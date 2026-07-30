#!/usr/bin/env python3
"""Convert the Dynamics 365 worksheet exports in incoming/data-exports/ into the
normalised JSON consumed by `npm run import:legacy`.

Same shape and posture as convert-price-lists.py: stdlib only, XLSX read straight
from the zip, fails loudly (file:row list, writes nothing) on anything it cannot
map. See docs/d365-export-analysis.md for what the exports contain.

The exports are D365 *dynamic* worksheets, which is what makes this reliable:

  sheet.xml   holds `<entity>:<signature>:<logical_name>=<Display Name>&...`
  sheet2.xml  holds the data grid, column order matching that map

So columns are identified by their D365 LOGICAL name, never by the display name a
user could rename in the view, and never by position.

Output is written next to the exports (incoming/ is gitignored) because the account
and sales-order data is client PII and must not land in src/seed/data/.

Usage: python3 scripts/convert-d365-exports.py [input-dir] [output-dir]
"""
import hashlib
import json
import re
import sys
import urllib.parse
import zipfile
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DEFAULT_IN = REPO / 'incoming' / 'data-exports'
DEFAULT_OUT = DEFAULT_IN / 'normalized'

NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
EXCEL_EPOCH = date(1899, 12, 30)

# D365 lookup/GUID columns that carry no analytical value, plus the audit-noise
# columns that are empty in every row of every export we have seen.
IGNORED = {
    'checksumLogicalName', 'createdonbehalfby', 'modifiedonbehalfby',
    'owningbusinessunit', 'overriddencreatedon',
}
# Dropped here so they never reach the database, the normalised JSON, or a backup
# of either: supplier bank details, and the D365 portal identity columns on
# `contact` (which include adx_identity_passwordhash and the security stamp).
SENSITIVE_PREFIXES = ('fulmxero_bankaccount', 'adx_identity_')

TEXT, NUM, DATE, DATETIME, BOOL = 'text', 'num', 'date', 'datetime', 'bool'


def col(name, kind=TEXT):
    return (name, kind)


# Columns pulled from a RELATED entity export as `<relationship-guid>.<logical>`,
# e.g. "5c5e1693-….atelier_code" for "Code (Product) (Product Prices)". The GUID is
# the relationship id and would change if the view were rebuilt, so these are
# matched on the suffix instead: a mapping key of "*.atelier_code" matches any
# prefix. Bare logical names always win over a wildcard.
WILDCARD = '*.'


def resolve(logical, mapping):
    if logical in mapping:
        return mapping[logical]
    _prefix, dot, suffix = logical.partition('.')
    return mapping.get(WILDCARD + suffix) if dot else None


# entity logical name -> (output name, {d365 logical name: (staging column, kind)})
ENTITIES = {
    'atelier_productprices': ('product_prices', {
        'atelier_productpricesid': col('guid'),
        'atelier_code': col('code'),
        'atelier_description': col('description'),
        'fulmxero_trackingoption1id': col('range_name'),
        'fulmxero_trackingoption2id': col('item_type'),
        'atelier_packtype': col('pack_type'),
        'atelier_contents': col('contents'),
        'atelier_width': col('width'),
        'atelier_repeat': col('repeat'),
        'atelier_verticalrepeat': col('vertical_repeat'),
        'atelier_dateeffective': col('date_effective', DATE),
        'atelier_dutyrate': col('duty_rate'),
        'atelier_freightrate': col('freight_rate'),
        'transactioncurrencyid': col('currency'),
        'exchangerate': col('exchange_rate', NUM),
        'atelier_effectiveexchangerate': col('price_exchange_rate', NUM),
        'atelier_wholesalerate': col('wholesale_rate', NUM),
        'atelier_wholesalerate_base': col('wholesale_rate_base', NUM),
        'atelier_exportprice': col('export_price', NUM),
        'atelier_exportprice_base': col('export_price_base', NUM),
        'atelier_priceexdutynz': col('price_ex_duty_nz', NUM),
        'atelier_priceincldutynz': col('price_incl_duty_nz', NUM),
        'atelier_landedcostnz': col('landed_cost_nz', NUM),
        'atelier_retailsellpricenz': col('retail_sell_price_nz', NUM),
        'atelier_tradesellpricenz': col('trade_sell_price_nz', NUM),
        'fulmar_tradesellpricewithsurchargenz': col('trade_sell_price_under_5m_nz', NUM),
        'atelier_5sellpricenz': col('sell_price_5pct_nz', NUM),
        'atelier_10sellpricenz': col('sell_price_10pct_nz', NUM),
        'atelier_setpricesmanually': col('set_prices_manually', BOOL),
        'atelier_manualduty': col('manual_duty_pct', NUM),
        'atelier_manualmarkuptotrade': col('manual_markup_to_trade_pct', NUM),
        'atelier_manualfreightshipping': col('manual_freight_shipping_nz', NUM),
        'atelier_manualpriceincludingfreight': col('manual_price_incl_freight_nz', NUM),
        'atelier_manualtradeexfreightshipping': col('manual_trade_ex_freight_nz', NUM),
        'atelier_manualwholesaleprice': col('manual_wholesale_price', NUM),
        'atelier_manualwholesaleprice_base': col('manual_wholesale_price_base', NUM),
        'fulmxero_trackingcategory1id': col('tracking_category_1'),
        'fulmxero_trackingcategory2id': col('tracking_category_2'),
        'statecode': col('status'),
        'statuscode': col('status_reason'),
        'createdby': col('created_by'),
        'createdon': col('created_on', DATETIME),
        'modifiedby': col('modified_by'),
        'modifiedon': col('modified_on', DATETIME),
    }),
    'fulmxero_item': ('stock_items', {
        'fulmxero_itemid': col('guid'),
        'fulmxero_itemcode': col('item_code'),
        'fulmxero_name': col('name'),
        'fulmxero_supplierid': col('supplier'),
        'fulmxero_trackingoption1id': col('range_name'),
        'fulmxero_trackingoption2id': col('item_type'),
        'fulmxero_itemmeasure': col('item_measure'),
        'fulmxero_productpriceid': col('product_price_list'),
        'fulmxero_openingunitsinstock': col('opening_stock', NUM),
        'fulmxero_totalstockonhand': col('stock_on_hand', NUM),
        'fulmxero_totalstockavailable': col('stock_available', NUM),
        'fulmxero_xerostockonhand': col('xero_stock_on_hand', NUM),
        'fulmxero_xerotod365stockdifference': col('xero_to_d365_difference', NUM),
        'fulmxero_availablecuts': col('available_cuts'),
        # Free text in practice, never a number: staff use it as a reservation note
        # ("ALL 53.5m - Leanne / Harvey", "reserved for Wendy KK 28-10-2022").
        # 112 rows populated, 0 of them numeric.
        'atelier_reserve': col('reserve_note'),
        'fulmxero_totalinventoryadjustments': col('total_inventory_adjustments', NUM),
        'fulmxero_totalpurchaseinvoices': col('total_purchase_invoices', NUM),
        'fulmxero_totalpurchaseorders': col('total_purchase_orders', NUM),
        'fulmxero_totalsalesinvoices': col('total_sales_invoices', NUM),
        'fulmxero_totalsalesorder': col('total_sales_orders', NUM),
        'fulmar_minqtytoavoidsurcharge': col('min_qty_to_avoid_surcharge', NUM),
        'fulmxero_retailprice': col('retail_price', NUM),
        'fulmxero_retailprice_base': col('retail_price_base', NUM),
        'fulmxero_tradeprice': col('trade_price', NUM),
        'fulmxero_tradeprice_base': col('trade_price_base', NUM),
        'fulmar_tradepricewithsurcharge': col('trade_price_with_surcharge', NUM),
        'fulmar_tradepricewithsurcharge_base': col('trade_price_with_surcharge_base', NUM),
        'transactioncurrencyid': col('currency'),
        'exchangerate': col('exchange_rate', NUM),
        'fulmxero_cansell': col('can_sell', BOOL),
        'fulmxero_canpurchase': col('can_purchase', BOOL),
        'fulmxero_cantrack': col('can_track', BOOL),
        'fulmxero_salesaccountid': col('sales_account'),
        'fulmxero_purchasingaccountid': col('purchasing_account'),
        'fulmxero_inventoryaccountid': col('inventory_account'),
        'fulmxero_salestaxrateid': col('sales_tax_rate'),
        'fulmxero_purchasingtaxrateid': col('purchasing_tax_rate'),
        'fulmxero_salesdescription': col('sales_description'),
        'fulmxero_purchasingdescription': col('purchasing_description'),
        'fulmxero_trackingcategory1id': col('tracking_category_1'),
        'fulmxero_trackingcategory2id': col('tracking_category_2'),
        'ownerid': col('owner'),
        'statecode': col('status'),
        'statuscode': col('status_reason'),
        'createdby': col('created_by'),
        'createdon': col('created_on', DATETIME),
        'modifiedby': col('modified_by'),
        'modifiedon': col('modified_on', DATETIME),
    }),
    'account': ('accounts', {
        'accountid': col('guid'),
        'name': col('name'),
        'atelier_accountnumber': col('atelier_account_number'),
        'accountnumber': col('exonet_dr_account_number'),
        'atelier_exonetcracnumber': col('exonet_crac_number'),
        'fulmxero_xerocontactid': col('xero_contact_id'),
        'fulmxero_iscustomer': col('is_customer', BOOL),
        'fulmxero_issupplier': col('is_supplier', BOOL),
        'fulmxero_customertype': col('customer_type'),
        'customertypecode': col('relationship_type'),
        'businesstypecode': col('business_type'),
        'accountclassificationcode': col('classification'),
        'industrycode': col('industry'),
        'customersizecode': col('marketing_category'),
        'atelier_rating': col('rating'),
        'parentaccountid': col('parent_account'),
        'ownerid': col('owner'),
        'primarycontactid': col('primary_contact'),
        'emailaddress1': col('email'),
        'telephone1': col('main_phone'),
        'telephone2': col('other_phone'),
        'fax': col('fax'),
        'websiteurl': col('website'),
        'territoryid': col('territory'),
        'territorycode': col('province'),
        'address1_composite': col('address1_composite'),
        'address1_name': col('address1_name'),
        'address1_line1': col('address1_street1'),
        'address1_line2': col('address1_street2'),
        'address1_line3': col('address1_street3'),
        'address1_city': col('address1_city'),
        'address1_stateorprovince': col('address1_state'),
        'address1_postalcode': col('address1_postal_code'),
        'address1_country': col('address1_country'),
        'address1_county': col('address1_county'),
        'address1_addresstypecode': col('address1_type'),
        'address2_composite': col('address2_composite'),
        'address2_name': col('address2_name'),
        'address2_line1': col('address2_street1'),
        'address2_line2': col('address2_street2'),
        'address2_line3': col('address2_street3'),
        'address2_city': col('address2_city'),
        'address2_stateorprovince': col('address2_state'),
        'address2_postalcode': col('address2_postal_code'),
        'address2_country': col('address2_country'),
        'address2_county': col('address2_county'),
        'address2_addresstypecode': col('address2_type'),
        'shippingmethodcode': col('shipping_method'),
        'transactioncurrencyid': col('currency'),
        'exchangerate': col('exchange_rate', NUM),
        'fulmxero_discount': col('discount', NUM),
        'creditlimit': col('credit_limit', NUM),
        'creditlimit_base': col('credit_limit_base', NUM),
        'creditonhold': col('credit_hold', BOOL),
        'paymenttermscode': col('payment_terms'),
        'fulmxero_paymenttermssalesid': col('payment_terms_sales'),
        'fulmxero_paymenttermsbillsid': col('payment_terms_bills'),
        'atelier_paymentwithorder': col('payment_with_order', BOOL),
        'fulmxero_billdays': col('bill_days', NUM),
        'fulmxero_salesdays': col('sales_days', NUM),
        'fulmxero_salesdayssuffix': col('sales_days_suffix'),
        'fulmxero_exosalespaymentterms': col('exo_sales_payment_terms'),
        'fulmxero_exobillpaymentterms': col('exo_bill_payment_terms'),
        'fulmar_defaultreservedays': col('default_reserve_days', NUM),
        'fulmar_orderstockcheckdetails': col('order_stock_check_details'),
        'fulmxero_saleswarningmessage': col('sales_warning_message'),
        'fulmar_oldestsampledueback': col('oldest_sample_due_back', DATETIME),
        'atelier_lastsalescontact': col('last_sales_contact', DATETIME),
        'atelier_nextsalescontactdue': col('next_sales_contact_due', DATETIME),
        'marketingonly': col('marketing_only', BOOL),
        'donotsendmm': col('do_not_send_marketing_materials', BOOL),
        'msdyn_gdproptout': col('gdpr_optout', BOOL),
        'donotemail': col('do_not_email', BOOL),
        'donotbulkemail': col('do_not_bulk_email', BOOL),
        'donotphone': col('do_not_phone', BOOL),
        'donotfax': col('do_not_fax', BOOL),
        'donotpostalmail': col('do_not_postal_mail', BOOL),
        'donotbulkpostalmail': col('do_not_bulk_postal_mail', BOOL),
        'followemail': col('follow_email_activity', BOOL),
        'preferredcontactmethodcode': col('preferred_contact_method'),
        'lastusedincampaign': col('last_date_included_in_campaign', DATETIME),
        'description': col('description'),
        'statecode': col('status'),
        'statuscode': col('status_reason'),
        'createdby': col('created_by'),
        'createdon': col('created_on', DATETIME),
        'modifiedby': col('modified_by'),
        'modifiedon': col('modified_on', DATETIME),
    }),
    'fulmxero_salesorder': ('sales_orders', {
        'fulmxero_salesorderid': col('guid'),
        'fulmxero_number': col('number'),
        'fulmxero_customerid': col('customer'),
        'fulmxero_contactid': col('contact'),
        'fulmxero_reference': col('reference'),
        'fulmxero_orderdate': col('order_date', DATETIME),
        'fulmxero_expecteddeliverydate': col('expected_delivery_date', DATETIME),
        'fulmxero_totalexgst': col('total_ex_gst', NUM),
        'fulmxero_gst': col('gst', NUM),
        'fulmxero_totalinclgst': col('total_incl_gst', NUM),
        'fulmxero_totalexgst_base': col('total_ex_gst_base', NUM),
        'fulmxero_gst_base': col('gst_base', NUM),
        'fulmxero_totalinclgst_base': col('total_incl_gst_base', NUM),
        'transactioncurrencyid': col('currency'),
        'exchangerate': col('exchange_rate', NUM),
        'fulmxero_pricingtype': col('pricing_type'),
        'fulmxero_salesorderdiscount': col('sales_order_discount_pct', NUM),
        'fulmxero_delivertoid': col('deliver_to'),
        'fulmxero_markparcel': col('mark_parcel'),
        'fulmxero_lastsent': col('last_sent', DATETIME),
        'fulmxero_onbehalfof': col('on_behalf_of'),
        'ownerid': col('owner'),
        'statecode': col('status'),
        'statuscode': col('status_reason'),
        'createdby': col('created_by'),
        'createdon': col('created_on', DATETIME),
        'modifiedby': col('modified_by'),
        'modifiedon': col('modified_on', DATETIME),
    }),
    # ---- 30 Jul pull ------------------------------------------------------
    'contact': ('contacts', {
        'contactid': col('guid'),
        'fullname': col('full_name'),
        'firstname': col('first_name'),
        'lastname': col('last_name'),
        'middlename': col('middle_name'),
        'salutation': col('salutation'),
        'suffix': col('suffix'),
        'nickname': col('nickname'),
        'jobtitle': col('job_title'),
        'department': col('department'),
        'parentcustomerid': col('company_name'),
        'accountrolecode': col('role'),
        'customertypecode': col('relationship_type'),
        'territorycode': col('territory'),
        'emailaddress1': col('email'),
        'emailaddress2': col('email2'),
        'emailaddress3': col('email3'),
        'telephone1': col('business_phone'),
        'business2': col('business_phone2'),
        'telephone2': col('home_phone'),
        'telephone3': col('telephone3'),
        'mobilephone': col('mobile_phone'),
        'fax': col('fax'),
        'websiteurl': col('website'),
        'address1_composite': col('address1_composite'),
        'address1_line1': col('address1_street1'),
        'address1_line2': col('address1_street2'),
        'address1_city': col('address1_city'),
        'address1_stateorprovince': col('address1_state'),
        'address1_postalcode': col('address1_postal_code'),
        'address1_country': col('address1_country'),
        'address1_telephone1': col('address1_phone'),
        'address2_composite': col('address2_composite'),
        'address3_composite': col('address3_composite'),
        'shippingmethodcode': col('shipping_method'),
        'paymenttermscode': col('payment_terms'),
        'defaultpricelevelid': col('price_list'),
        'transactioncurrencyid': col('currency'),
        'exchangerate': col('exchange_rate', NUM),
        'creditlimit': col('credit_limit', NUM),
        'creditonhold': col('credit_hold', BOOL),
        'isbackofficecustomer': col('back_office_customer', BOOL),
        'leadsourcecode': col('lead_source'),
        'preferredcontactmethodcode': col('preferred_contact_method'),
        'atelier_primarycontact': col('is_primary_contact', BOOL),
        'fulmxero_includeinemails': col('include_in_emails', BOOL),
        'fulmxero_xerocontactnumber': col('xero_contact_number'),
        'fulmxero_xerocontactpersonid': col('xero_contact_person_id'),
        'fulmar_oldestsampledueback': col('oldest_sample_due_back', DATETIME),
        'lastusedincampaign': col('last_date_included_in_campaign', DATETIME),
        'marketingonly': col('marketing_only', BOOL),
        'donotsendmm': col('do_not_send_marketing_materials', BOOL),
        'msdyn_gdproptout': col('gdpr_optout', BOOL),
        'donotemail': col('do_not_email', BOOL),
        'donotbulkemail': col('do_not_bulk_email', BOOL),
        'donotphone': col('do_not_phone', BOOL),
        'donotfax': col('do_not_fax', BOOL),
        'donotpostalmail': col('do_not_postal_mail', BOOL),
        'donotbulkpostalmail': col('do_not_bulk_postal_mail', BOOL),
        'followemail': col('follow_email_activity', BOOL),
        'description': col('description'),
        'ownerid': col('owner'),
        'statecode': col('status'),
        'statuscode': col('status_reason'),
        'createdby': col('created_by'),
        'createdon': col('created_on', DATETIME),
        'modifiedby': col('modified_by'),
        'modifiedon': col('modified_on', DATETIME),
    }),
    # The real source of reserved quantity: a first-class entity with a numeric
    # qty and an expiry, NOT the free-text `Reserve` note on the stock item.
    'fulmar_reserve': ('reserves', {
        'fulmar_reserveid': col('guid'),
        'fulmar_name': col('name'),
        'fulmar_reservenumber': col('reserve_number'),
        'fulmar_range': col('range_name'),
        'fulmar_customer': col('customer'),
        'fulmar_customercontact': col('customer_contact'),
        'fulmar_product': col('product'),
        WILDCARD + 'atelier_code': col('product_code'),
        WILDCARD + 'ownerid': col('customer_owner'),
        'fulmar_colourcode': col('colour_code'),
        'fulmar_supplier': col('supplier'),
        'fulmar_quantity': col('quantity', NUM),
        'fulmar_reserveduntil': col('reserved_until', DATETIME),
        'fulmar_defaultreserveduntildate': col('default_reserved_until', DATETIME),
        'fulmar_cfa': col('cfa'),
        'fulmar_comments': col('comments'),
        'fulmar_orderstockcheckdetails': col('order_stock_check_details'),
        'ownerid': col('owner'),
        'statecode': col('status'),
        'statuscode': col('status_reason'),
        'createdby': col('created_by'),
        'createdon': col('created_on', DATETIME),
        'modifiedby': col('modified_by'),
        'modifiedon': col('modified_on', DATETIME),
    }),
    'fulmar_cutting': ('cuttings', {
        'fulmar_cuttingid': col('guid'),
        'fulmar_name': col('name'),
        'fulmar_range': col('range_name'),
        'fulmar_customer': col('customer'),
        'fulmar_customercontact': col('customer_contact'),
        'fulmar_product': col('product'),
        WILDCARD + 'atelier_code': col('product_code'),
        WILDCARD + 'ownerid': col('customer_owner'),
        'fulmar_colourcode': col('colour_code'),
        'fulmar_supplier': col('supplier'),
        'fulmar_quantity': col('quantity', NUM),
        'fulmar_comments': col('comments'),
        'fulmar_orderstockcheckdetails': col('order_stock_check_details'),
        'ownerid': col('owner'),
        'statecode': col('status'),
        'statuscode': col('status_reason'),
        'createdby': col('created_by'),
        'createdon': col('created_on', DATETIME),
        'modifiedby': col('modified_by'),
        'modifiedon': col('modified_on', DATETIME),
    }),
    'fulmxero_itemlocation': ('item_locations', {
        'fulmxero_itemlocationid': col('guid'),
        'fulmxero_description': col('description'),
        'fulmxero_itemid': col('item'),
        'fulmxero_locationid': col('location'),
        'fulmxero_openingunitsinstock': col('opening_units_in_stock', NUM),
        'fulmxero_totalstockinhand': col('total_stock_on_hand', NUM),
        'fulmxero_totalstockavailable': col('total_stock_available', NUM),
        'fulmxero_totalitemadjustments': col('total_item_adjustments', NUM),
        'fulmxero_totalpurchaseinvoices': col('total_purchase_invoices', NUM),
        'fulmxero_totalpurchaseorders': col('total_purchase_orders', NUM),
        'fulmxero_totalsalesinvoices': col('total_sales_invoices', NUM),
        'fulmxero_totalsalesorders': col('total_sales_orders', NUM),
        'ownerid': col('owner'),
        'statecode': col('status'),
        'statuscode': col('status_reason'),
        'createdby': col('created_by'),
        'createdon': col('created_on', DATETIME),
        'modifiedby': col('modified_by'),
        'modifiedon': col('modified_on', DATETIME),
    }),
    'fulmxero_purchaseorder': ('purchase_orders', {
        'fulmxero_purchaseorderid': col('guid'),
        'fulmxero_title': col('number'),
        'fulmxero_vendorid': col('vendor'),
        'fulmxero_vendorcontactid': col('vendor_contact'),
        'fulmxero_date': col('order_date', DATETIME),
        'fulmxero_deliverydate': col('pickup_date', DATETIME),
        'fulmxero_reference': col('reference'),
        'fulmxero_summary': col('summary'),
        'fulmxero_attention': col('attention'),
        'fulmxero_phone': col('phone'),
        'fulmxero_locationid': col('location'),
        # A13: the per-supplier default shipping agent, absent on the account.
        'fulmxero_shippingagentid': col('shipping_agent'),
        'fulmxero_poshippingcontactid': col('shipping_contact'),
        'fulmxero_deliveryaddress': col('delivery_address'),
        'fulmxero_delivryinstructions': col('delivery_instructions'),
        'transactioncurrencyid': col('currency'),
        'exchangerate': col('exchange_rate', NUM),
        'fulmxero_totalexgst': col('total_ex_gst', NUM),
        'fulmxero_totalgst': col('gst', NUM),
        'fulmxero_totalinclgst': col('total_incl_gst', NUM),
        'fulmxero_totalexgst_base': col('total_ex_gst_base', NUM),
        'fulmxero_totalgst_base': col('gst_base', NUM),
        'fulmxero_totalinclgst_base': col('total_incl_gst_base', NUM),
        'fulmxero_lastsent': col('last_sent', DATETIME),
        'ownerid': col('owner'),
        'statecode': col('status'),
        'statuscode': col('status_reason'),
        'createdby': col('created_by'),
        'createdon': col('created_on', DATETIME),
        'modifiedby': col('modified_by'),
        'modifiedon': col('modified_on', DATETIME),
    }),
    'fulmxero_purchaseinvoice': ('purchase_invoices', {
        'fulmxero_purchaseinvoiceid': col('guid'),
        'fulmxero_title': col('number'),
        'fulmxero_vendorid': col('vendor'),
        'fulmxero_date': col('invoice_date', DATETIME),
        'fulmxero_duedate': col('due_date', DATETIME),
        'fulmxero_reference': col('reference'),
        'fulmxero_summary': col('summary'),
        'fulmxero_shippingagentsinvoicenumber': col('shipping_agents_invoice_number'),
        'transactioncurrencyid': col('currency'),
        'exchangerate': col('exchange_rate', NUM),
        'fulmxero_totalexgstrollup': col('total_ex_gst', NUM),
        'fulmxero_totalgstrollup': col('gst', NUM),
        'fulmxero_totalinclgstrollup': col('total_incl_gst', NUM),
        'fulmxero_totalexgstrollup_base': col('total_ex_gst_base', NUM),
        'fulmxero_totalgstrollup_base': col('gst_base', NUM),
        'fulmxero_totalinclgstrollup_base': col('total_incl_gst_base', NUM),
        'atelier_tempinvoicedate': col('temp_invoice_date', DATETIME),
        'atelier_tempinvoiceduedate': col('temp_invoice_due_date', DATETIME),
        'fulmxero_xeroinvoiceid': col('xero_invoice_id'),
        'fulmxero_xerointerfaceerror': col('xero_interface_error'),
        'ownerid': col('owner'),
        'statecode': col('status'),
        'statuscode': col('status_reason'),
        'createdby': col('created_by'),
        'createdon': col('created_on', DATETIME),
        'modifiedby': col('modified_by'),
        'modifiedon': col('modified_on', DATETIME),
    }),
    # A2/A4 spine: real invoiced sales history, each row linked to its sales order
    # AND to the Xero invoice.
    'fulmxero_salesinvoice': ('sales_invoices', {
        'fulmxero_salesinvoiceid': col('guid'),
        'fulmxero_title': col('number'),
        'fulmxero_invoicesuffix': col('invoice_suffix'),
        'fulmxero_customerid': col('customer'),
        'fulmxero_customercontactid': col('customer_contact'),
        'fulmxero_salesorderid': col('sales_order'),
        'fulmxero_date': col('invoice_date', DATETIME),
        'fulmxero_datedue': col('due_date', DATETIME),
        'fulmxero_reference': col('reference'),
        'fulmxero_summary': col('summary'),
        'transactioncurrencyid': col('currency'),
        'exchangerate': col('exchange_rate', NUM),
        'fulmxero_totalexgstrollup': col('total_ex_gst', NUM),
        'fulmxero_gstrollup': col('gst', NUM),
        'fulmxero_totalinclgstrollup': col('total_incl_gst', NUM),
        'fulmxero_totalexgstrollup_base': col('total_ex_gst_base', NUM),
        'fulmxero_gstrollup_base': col('gst_base', NUM),
        'fulmxero_totalinclgstrollup_base': col('total_incl_gst_base', NUM),
        'fulmxero_pricingtype': col('pricing_type'),
        'fulmxero_salesinvoicediscount': col('sales_invoice_discount_pct', NUM),
        'atelier_tempinvoicedate': col('temp_invoice_date', DATETIME),
        'atelier_tempinvoiceduedate': col('temp_invoice_due_date', DATETIME),
        'fulmxero_xeroinvoiceid': col('xero_invoice_id'),
        'fulmxero_xerointerfaceerror': col('xero_interface_error'),
        'fulmxero_lastsent': col('last_sent', DATETIME),
        'ownerid': col('owner'),
        'statecode': col('status'),
        'statuscode': col('status_reason'),
        'createdby': col('created_by'),
        'createdon': col('created_on', DATETIME),
        'modifiedby': col('modified_by'),
        'modifiedon': col('modified_on', DATETIME),
    }),
}

# Filenames carry the export timestamp: "Customers 29-07-2026 9-50-28 AM.xlsx".
EXPORTED_AT_RE = re.compile(
    r'(?P<d>\d{2})-(?P<m>\d{2})-(?P<y>\d{4})\s+(?P<H>\d{1,2})-(?P<M>\d{2})-(?P<S>\d{2})\s*(?P<ap>AM|PM)?',
    re.IGNORECASE,
)


def exported_at(stem):
    match = EXPORTED_AT_RE.search(stem)
    if not match:
        return None
    g = match.groupdict()
    hour = int(g['H']) % 12
    if (g['ap'] or '').upper() == 'PM':
        hour += 12
    return datetime(int(g['y']), int(g['m']), int(g['d']), hour, int(g['M']), int(g['S'])).isoformat()


def shared_strings(z):
    try:
        root = ET.fromstring(z.read('xl/sharedStrings.xml'))
    except KeyError:
        return []
    return [''.join(t.text or '' for t in si.iter(f'{NS}t')) for si in root]


def cell_value(c, sst):
    kind = c.get('t')
    if kind == 'inlineStr':
        node = c.find(f'{NS}is')
        return '' if node is None else ''.join(t.text or '' for t in node.iter(f'{NS}t'))
    v = c.find(f'{NS}v')
    raw = '' if v is None or v.text is None else v.text
    if kind == 's' and raw != '':
        return sst[int(raw)]
    return raw


def sheet_rows(z, path, sst):
    root = ET.fromstring(z.read(path))
    for line_no, row in enumerate(root.iter(f'{NS}row'), 1):
        cells = {}
        for c in row.findall(f'{NS}c'):
            index = 0
            for ch in c.get('r', ''):
                if not ch.isalpha():
                    break
                index = index * 26 + ord(ch.upper()) - 64
            cells[index - 1] = cell_value(c, sst)
        yield line_no, cells


def read_schema_map(z, sst):
    """The first cell of sheet.xml: '<entity>:<signature>:<logical>=<Display>&...'."""
    for _line_no, cells in sheet_rows(z, 'xl/worksheets/sheet.xml', sst):
        if 0 in cells and ':' in cells[0]:
            entity, _signature, query = cells[0].split(':', 2)
            names = [pair.partition('=')[0] for pair in query.split('&')]
            return entity, names
        break
    raise ValueError('no D365 schema map in sheet.xml — is this a dynamic worksheet export?')


def parse_number(value):
    return float(value)


def parse_date(value):
    return (EXCEL_EPOCH + timedelta(days=int(float(value)))).isoformat()


def parse_datetime(value):
    """Excel serial -> naive ISO timestamp. The serial is rendered in the exporting
    user's local time, so it is deliberately NOT tagged UTC."""
    days = float(value)
    stamp = datetime.combine(EXCEL_EPOCH, datetime.min.time()) + timedelta(days=days)
    return stamp.replace(microsecond=0).isoformat(sep=' ')


# D365 renders two-option fields by their label, and the consent fields use a
# label set whose polarity is the OPPOSITE of the word: the underlying attribute is
# `donotemail` / `donotsendmm`, so "Allow" and "Send" mean the do-not flag is FALSE.
# Staging keeps the source polarity — the columns are named `do_not_*` to match, and
# interpretation happens downstream. Getting this backwards would invert consent.
BOOLS = {
    'yes': True, 'no': False, 'true': True, 'false': False, '1': True, '0': False,
    'allow': False, 'do not allow': True,
    'send': False, 'do not send': True,
}


def coerce(value, kind):
    if kind == NUM:
        return parse_number(value)
    if kind == DATE:
        return parse_date(value)
    if kind == DATETIME:
        return parse_datetime(value)
    if kind == BOOL:
        coerced = BOOLS.get(value.lower())
        if coerced is None:
            raise ValueError(f'unmappable boolean "{value}"')
        return coerced
    return value


def convert_file(path, errors):
    with zipfile.ZipFile(path) as z:
        sst = shared_strings(z)
        entity, logical_names = read_schema_map(z, sst)
        if entity not in ENTITIES:
            raise ValueError(f'unknown D365 entity "{entity}" — add it to ENTITIES')
        out_name, mapping = ENTITIES[entity]
        matched = {key for name in logical_names for key in (name, WILDCARD + name.partition('.')[2])}
        missing = [n for n in mapping if n not in matched]
        if missing:
            raise ValueError(f'export is missing required column(s): {", ".join(sorted(missing))}')
        stamp = exported_at(path.stem)
        records = []
        for line_no, cells in sheet_rows(z, 'xl/worksheets/sheet2.xml', sst):
            if line_no == 1:  # header row of display names
                continue
            record = {'source_file': path.name, 'exported_at': stamp}
            raw = {}
            for index, logical in enumerate(logical_names):
                value = (cells.get(index) or '').strip()
                if not value:
                    continue
                if logical in IGNORED or logical.startswith(SENSITIVE_PREFIXES):
                    continue
                raw[logical] = value
                target = resolve(logical, mapping)
                if not target:
                    continue
                column, kind = target
                try:
                    record[column] = coerce(value, kind)
                except ValueError as error:
                    errors.append(f'{path.name}:{line_no}: {column}: {error}')
            record['row_checksum'] = (cells.get(1) or '').strip() or None
            record['raw'] = raw
            if not record.get('guid'):
                errors.append(f'{path.name}:{line_no}: missing record GUID')
                continue
            records.append(record)
    return out_name, records


def main():
    in_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_IN
    out_dir = Path(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_OUT
    files = sorted(p for p in in_dir.glob('*.xlsx') if not p.name.startswith('~$'))
    if not files:
        sys.exit(f'no .xlsx exports in {in_dir}')

    errors, by_entity, digests = [], {}, {}
    for path in files:
        digest = hashlib.sha1(path.read_bytes()).hexdigest()
        try:
            out_name, records = convert_file(path, errors)
        except (ValueError, KeyError) as error:
            errors.append(f'{path.name}: {error}')
            continue
        # A repeated export of the same view (e.g. the stray "Export.xlsx") would
        # otherwise double every row; dedupe on the D365 GUID, keeping the first.
        bucket = by_entity.setdefault(out_name, {})
        duplicates = 0
        for record in records:
            if record['guid'] in bucket:
                duplicates += 1
                continue
            bucket[record['guid']] = record
        note = f' ({duplicates} duplicate rows skipped)' if duplicates else ''
        print(f'  {path.name}: {len(records)} rows -> {out_name}{note}', file=sys.stderr)
        digests.setdefault(out_name, []).append(digest[:12])

    if errors:
        print(f'\n{len(errors)} problem(s); nothing written:', file=sys.stderr)
        for line in errors[:50]:
            print(f'  {line}', file=sys.stderr)
        if len(errors) > 50:
            print(f'  ... and {len(errors) - 50} more', file=sys.stderr)
        sys.exit(1)

    out_dir.mkdir(parents=True, exist_ok=True)
    for out_name, bucket in sorted(by_entity.items()):
        target = out_dir / f'{out_name}.json'
        target.write_text(json.dumps(list(bucket.values()), ensure_ascii=False, indent=0))
        print(f'wrote {target.relative_to(REPO)} ({len(bucket)} records)', file=sys.stderr)


if __name__ == '__main__':
    main()
