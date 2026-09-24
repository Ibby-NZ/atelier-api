// Back-office supplier JSON API. Every route is backoffice-only (director
// inherits via the role guard) — a supplier record names the freight agent, the
// Incoterm, the internal PO address and how each house is discounted, so there
// is no viewer for it below staff. Handlers stay thin; the SQL and the rules
// live in ../suppliers/admin-suppliers.js.
//
// Three things worth knowing before editing this file:
//   - `slug` is never accepted from the client. It is derived from the name on
//     create and NOT recomputed on rename — it is the stable key the backfill
//     and any later import address a supplier by.
//   - A duplicate is always the database's 23505, mapped to a 409 by the module.
//     A pre-check races and would still need the handler, so there is none.
//   - DELETE goes through the shared lifecycle module and answers a refusal as a
//     VALUE, not an exception: Fastify's error serializer drops custom
//     properties, so a thrown error could not carry `blockers`, which is the
//     entire point of the 409.

import { backfillSuppliers } from '../suppliers/backfill.js'
import { getProductTier, setProductTier } from '../suppliers/product-tiers.js'
import {
  listSuppliers,
  getSupplier,
  createSupplier,
  updateSupplier,
  setSupplierArchived,
  DEFAULT_PAGE,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from '../suppliers/admin-suppliers.js'
import {
  pageSupplierBrandTerms,
  createSupplierBrandTerms,
  updateSupplierBrandTerms,
  createSupplierDiscountTier,
  updateSupplierDiscountTier,
  getSupplierBrandTerms,
  findScopedTierId,
  getSupplierDefaultDiscount,
  setSupplierDefaultDiscount,
  DEFAULT_LIMIT as TERMS_DEFAULT_LIMIT,
  MAX_LIMIT as TERMS_MAX_LIMIT,
} from '../suppliers/supplier-terms.js'
import {
  CONTACT_METHODS,
  listSupplierContacts,
  createSupplierContact,
  updateSupplierContact,
  deleteSupplierContact,
  listContactLog,
  createContactLogEntry,
  DEFAULT_PAGE as LOG_DEFAULT_PAGE,
  DEFAULT_LIMIT as LOG_DEFAULT_LIMIT,
  MAX_LIMIT as LOG_MAX_LIMIT,
} from '../suppliers/supplier-contacts.js'
import { loadReportAccess } from '../reports/access.js'
import { deleteOrExplain, replyDelete } from '../lifecycle/delete.js'

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

// Mirrors `suppliers_discount_method_check`. The database owns the vocabulary —
// this is the boundary copy that turns a typo into a 400 instead of letting a
// 23514 surface as a 500, exactly as CATEGORY_ENUM does in admin-price-lists.js.
// `test/suppliers-routes.test.js` compares it to the live CHECK definition, so
// widening one side without the other fails rather than drifting quietly.
export const DISCOUNT_METHOD_ENUM = Object.freeze(['averaged', 'per-brand'])

// Required on create, editable after.
const nameProp = { type: 'string', minLength: 1, maxLength: 200 }

// Optional columns. Nullable so a PATCH can clear one with an explicit null —
// every one of them is nullable in the schema, `currency` deliberately so:
// blank means "no invoice on file yet", and defaulting it from `country` is the
// exact mistake the column exists to prevent.
const nullableShort = { type: ['string', 'null'], maxLength: 200 }
const nullableToken = { type: ['string', 'null'], maxLength: 32 }
const nullableEmail = { type: ['string', 'null'], maxLength: 254 }
const discountMethodProp = {
  type: ['string', 'null'],
  enum: [...DISCOUNT_METHOD_ENUM, null],
}

// Long-form free text (a street address, an internal note) gets the same cap
// the terms `note` carries.
const nullableLong = { type: ['string', 'null'], maxLength: 2000 }

const supplierProps = {
  short_code: nullableToken,
  d365_token: nullableToken,
  country: nullableShort,
  currency: nullableShort,
  agent: nullableShort,
  incoterm: nullableShort,
  po_email: nullableEmail,
  discount_method: discountMethodProp,
  phone: nullableShort,
  address: nullableLong,
  website_url: nullableShort,
  notes: nullableLong,
}

// :id is coerced to an integer by Fastify; a non-numeric id is a 400 by schema.
const idParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'integer', minimum: 1 },
  },
}

const listQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    q: { type: 'string', maxLength: 200 },
    include_archived: { type: 'boolean', default: false },
    page: { type: 'integer', minimum: 1, default: DEFAULT_PAGE },
    limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
  },
}

// No `slug`: server-derived. Ajv strips it rather than rejecting it (this
// codebase's `removeAdditional` gotcha), which is why it is simply absent from
// the module's INSERT column list too.
const createSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: nameProp,
    ...supplierProps,
  },
}

const patchSchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: nameProp,
    ...supplierProps,
  },
}

const notFound = (reply, id) => {
  reply.code(404)
  return { error: 'Not Found', message: `Supplier ${id} not found.` }
}

// ---------------------------------------------------------------------------
// Contact people (supplier_contacts) + the contact log (supplier_contact_log)
//
// Staff address-book data, not cost data — the backoffice guard alone is the
// gate, no finance check. The log is APPEND-ONLY: no PATCH or DELETE routes
// exist for it on purpose (see src/suppliers/supplier-contacts.js).
// ---------------------------------------------------------------------------

const contactBodyProps = {
  name: { type: 'string', minLength: 1, maxLength: 200 },
  role: nullableShort,
  email: nullableEmail,
  phone: nullableShort,
  note: nullableLong,
}

const createContactSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: contactBodyProps,
}

const patchContactSchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: contactBodyProps,
}

const contactParamsSchema = {
  type: 'object',
  required: ['id', 'contactId'],
  properties: {
    id: { type: 'integer', minimum: 1 },
    contactId: { type: 'integer', minimum: 1 },
  },
}

// The shape check only — '2026-02-31' passes and is the database's 22008,
// mapped to a 422 by the module. Never a 500.
const isoDayProp = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }

const createLogEntrySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['method'],
  properties: {
    method: { type: 'string', enum: [...CONTACT_METHODS] },
    // Omitted = the column's CURRENT_DATE default; not nullable, because a log
    // entry without a day is not a record of anything.
    contacted_on: isoDayProp,
    note: nullableLong,
    follow_up_on: { ...isoDayProp, type: ['string', 'null'] },
  },
}

const logListQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    page: { type: 'integer', minimum: 1, default: LOG_DEFAULT_PAGE },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: LOG_MAX_LIMIT,
      default: LOG_DEFAULT_LIMIT,
    },
  },
}

// ---------------------------------------------------------------------------
// Commercial terms (supplier_brand_terms + supplier_discount_tiers)
//
// The boundary copies of the column CHECKs, same posture as DISCOUNT_METHOD_ENUM
// above: without them a typo reaches the constraint and surfaces as a 500. The
// database stays the gate — a violation that gets past these is still mapped to
// a 422 by the module — but the common mistakes are refused here.
//
// `discount_chain` is an ARRAY of rates, not a rate, and it is MULTIPLICATIVE:
// {0.4, 0.4} is x0.36, not -80%. There is no schema keyword that can say that,
// which is why every write response carries the evaluated `net_multiplier`.
// ---------------------------------------------------------------------------

// numeric(6,4) CHECK (>= 0 AND < 1) — a fraction off list. 1 is a free metre.
const rateProp = { type: 'number', minimum: 0, exclusiveMaximum: 1 }
const nullableRateProp = { type: ['number', 'null'], minimum: 0, exclusiveMaximum: 1 }
// numeric(6,4) CHECK (> 0) — a multiplier on the landed cost (Fabricut: 2.1-2.5).
const nullableMarkupProp = { type: ['number', 'null'], exclusiveMinimum: 0 }

const termsBodyProps = {
  discount: nullableRateProp,
  // No `null` member: the column is NOT NULL and "no chain" is [], never absent.
  discount_chain: { type: 'array', items: rateProp, maxItems: 16 },
  markup: nullableMarkupProp,
  indicative: { type: 'boolean' },
  note: { type: ['string', 'null'], maxLength: 2000 },
}

// The supplier's own net rate — one column on `suppliers`, the same fraction
// off list every other rate here is. Its own body schema rather than a member
// of `supplierProps`, because the general supplier PATCH is open to any
// backoffice login and this one is finance-gated; `null` clears it, and that is
// a different statement from 0 (prices that arrive already net).
const defaultDiscountSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['default_discount'],
  properties: { default_discount: nullableRateProp },
}

const productTierBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['tier_id'],
  properties: { tier_id: { type: ['integer', 'null'], minimum: 1 } },
}

const createTermsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['brand_id'],
  properties: {
    brand_id: { type: 'integer', minimum: 1 },
    ...termsBodyProps,
  },
}

// `brand_id` is absent: it is the row's identity (one set of terms per house),
// so moving terms to another maison is a delete and a re-create.
const patchTermsSchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: termsBodyProps,
}

// `label` is free text matched case-insensitively against the LINE's category,
// NOT the products.category enum — the houses quote things the enum has no word
// for. Nothing here can check whether it will ever match; the response says so
// per tier (`matches_category`).
const tierBodyProps = {
  label: { type: 'string', minLength: 1, maxLength: 200 },
  pct: rateProp,
  is_fallback: { type: 'boolean' },
}

const createTierSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['label', 'pct'],
  properties: tierBodyProps,
}

const patchTierSchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: tierBodyProps,
}

const termsParamsSchema = {
  type: 'object',
  required: ['id', 'termsId'],
  properties: {
    id: { type: 'integer', minimum: 1 },
    termsId: { type: 'integer', minimum: 1 },
  },
}

const tierParamsSchema = {
  type: 'object',
  required: ['id', 'termsId', 'tierId'],
  properties: {
    id: { type: 'integer', minimum: 1 },
    termsId: { type: 'integer', minimum: 1 },
    tierId: { type: 'integer', minimum: 1 },
  },
}

const termsListQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    page: { type: 'integer', minimum: 1, default: DEFAULT_PAGE },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: TERMS_MAX_LIMIT,
      default: TERMS_DEFAULT_LIMIT,
    },
  },
}

export const adminSupplierRoutes = async (app, { pool }) => {
  const backoffice = app.guards.requireRole('backoffice')
  const director = app.guards.requireRole('director')

  // `npm run backfill:suppliers` without a shell. Staging showed an empty
  // Suppliers screen for a week because the backfill only existed as a CLI and
  // the server has no console (Userback 8367793). Director-only: it writes
  // supplier records, aliases and per-house terms in one transaction. Idempotent
  // by construction (src/suppliers/backfill.js), so a second press changes
  // nothing, and it answers the same summary + worklist the CLI prints.
  app.post('/admin/suppliers/backfill', { preHandler: director }, async (request) => {
    const summary = await backfillSuppliers(pool)
    request.log.info({ suppliers: summary.suppliers, brands: summary.brands }, 'supplier backfill')
    return { summary }
  })

  app.get(
    '/admin/suppliers',
    { preHandler: backoffice, schema: { querystring: listQuerySchema } },
    async (request) => {
      const { q, include_archived, page, limit } = request.query
      const { suppliers, total } = await listSuppliers(pool, {
        q,
        includeArchived: include_archived,
        page,
        limit,
      })
      return { suppliers, meta: { total, page, limit } }
    }
  )

  app.get(
    '/admin/suppliers/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const supplier = await getSupplier(pool, request.params.id)
      if (!supplier) return notFound(reply, request.params.id)
      return { supplier }
    }
  )

  app.post(
    '/admin/suppliers',
    { preHandler: backoffice, schema: { body: createSchema } },
    async (request, reply) => {
      const supplier = await createSupplier(pool, request.body)
      reply.code(201)
      return { supplier }
    }
  )

  app.patch(
    '/admin/suppliers/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema, body: patchSchema } },
    async (request) => ({
      supplier: await updateSupplier(pool, request.params.id, request.body),
    })
  )

  app.post(
    '/admin/suppliers/:id/archive',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const supplier = await setSupplierArchived(pool, request.params.id, true)
      if (!supplier) return notFound(reply, request.params.id)
      return { supplier }
    }
  )

  app.post(
    '/admin/suppliers/:id/restore',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const supplier = await setSupplierArchived(pool, request.params.id, false)
      if (!supplier) return notFound(reply, request.params.id)
      return { supplier }
    }
  )

  // 'supplier' is a code literal, never a path parameter: the registry is not an
  // authorisation boundary, so an entity name taken from the URL would let a
  // caller choose which table gets deleted from.
  app.delete(
    '/admin/suppliers/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) =>
      replyDelete(
        reply,
        await deleteOrExplain(pool, 'supplier', request.params.id, {
          user: request.user,
        })
      )
  )

  // ---- contact people -----------------------------------------------------

  app.get(
    '/admin/suppliers/:id/contacts',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request) => ({
      contacts: await listSupplierContacts(pool, request.params.id),
    })
  )

  app.post(
    '/admin/suppliers/:id/contacts',
    { preHandler: backoffice, schema: { params: idParamsSchema, body: createContactSchema } },
    async (request, reply) => {
      const contact = await createSupplierContact(pool, request.params.id, request.body)
      reply.code(201)
      return { contact }
    }
  )

  app.patch(
    '/admin/suppliers/:id/contacts/:contactId',
    { preHandler: backoffice, schema: { params: contactParamsSchema, body: patchContactSchema } },
    async (request) => ({
      contact: await updateSupplierContact(
        pool,
        request.params.id,
        request.params.contactId,
        request.body
      ),
    })
  )

  app.delete(
    '/admin/suppliers/:id/contacts/:contactId',
    { preHandler: backoffice, schema: { params: contactParamsSchema } },
    async (request, reply) => {
      const { id, contactId } = request.params
      if (!(await deleteSupplierContact(pool, id, contactId))) {
        reply.code(404)
        return { error: 'Not Found', message: `Supplier ${id} has no contact ${contactId}.` }
      }
      reply.code(204)
    }
  )

  // ---- contact log ----------------------------------------------------------

  app.get(
    '/admin/suppliers/:id/contact-log',
    { preHandler: backoffice, schema: { params: idParamsSchema, querystring: logListQuerySchema } },
    async (request) => {
      const { page, limit } = request.query
      const { entries, total } = await listContactLog(pool, request.params.id, { page, limit })
      return { entries, meta: { total, page, limit } }
    }
  )

  app.post(
    '/admin/suppliers/:id/contact-log',
    { preHandler: backoffice, schema: { params: idParamsSchema, body: createLogEntrySchema } },
    async (request, reply) => {
      const entry = await createContactLogEntry(
        pool,
        request.params.id,
        request.body,
        // The signed-in staff member IS the "who" — never taken from the body.
        request.user
      )
      reply.code(201)
      return { entry }
    }
  )

  // Commercial terms are COST data — what Atelier pays a maison — so the
  // backoffice role alone is not the gate. `backoffice` covers the showroom as
  // well as the accounts desk, which is exactly why `users.can_view_finance`
  // exists as a second, explicit, revocable permission, and a login that may not
  // SEE a cost figure in a report must not be able to SET one here (the split
  // src/routes/admin-legacy.js already makes for a commercial column).
  //
  // It is read through `loadReportAccess` and NEVER off `request.user`: guards
  // load the user through PUBLIC_USER_COLUMNS, which does not carry the flag, so
  // `request.user.can_view_finance` is `undefined` and would answer false to
  // everyone, for ever, with nothing to show for it.
  const finance = async (request) => {
    const access = await loadReportAccess(pool, request.user)
    if (!access.finance) {
      throw httpError(
        403,
        'A house’s commercial terms are cost data. Your account does not have ' +
          'finance visibility — ask a director.'
      )
    }
  }
  const financeStaff = [backoffice, finance]

  // The standalone terms list. Not redundant with GET /admin/suppliers/:id,
  // which embeds terms per HOUSE and therefore drops any row whose brand is not
  // linked to this supplier. This one keys on supplier_id alone, so nothing is
  // invisible even for houses nobody has linked yet.
  app.get(
    '/admin/suppliers/:id/brand-terms',
    {
      preHandler: financeStaff,
      schema: { params: idParamsSchema, querystring: termsListQuerySchema },
    },
    async (request) => {
      const { page, limit } = request.query
      // The supplier's own rate rides along: it is what every house with no
      // terms row of its own is discounted at, so a terms list read without it
      // says "no discount" where the answer is "the supplier default".
      const [{ terms, total }, supplier] = await Promise.all([
        pageSupplierBrandTerms(pool, request.params.id, { page, limit }),
        getSupplierDefaultDiscount(pool, request.params.id),
      ])
      return {
        terms,
        default_discount: supplier.default_discount,
        meta: { total, page, limit },
      }
    }
  )

  // The discount tier chosen for one product (migration 1791638400000): the
  // product's choice plus every tier its house offers, so the CRM can render
  // the picker from one read. Finance-gated — a tier is a discount.
  app.get(
    '/admin/products/:id/discount-tier',
    { preHandler: financeStaff, schema: { params: idParamsSchema } },
    async (request) => ({ discount_tier: await getProductTier(pool, request.params.id) })
  )

  // PUT: the body IS the choice; null clears it back to category matching.
  app.put(
    '/admin/products/:id/discount-tier',
    { preHandler: financeStaff, schema: { params: idParamsSchema, body: productTierBodySchema } },
    async (request) => ({
      discount_tier: await setProductTier(pool, request.params.id, request.body.tier_id),
    })
  )

  // The supplier-level rate. A PATCH of its own rather than a field on
  // PATCH /admin/suppliers/:id, because that route is backoffice-wide and a
  // discount is cost data — the same reason the terms routes are gated.
  app.patch(
    '/admin/suppliers/:id/default-discount',
    { preHandler: financeStaff, schema: { params: idParamsSchema, body: defaultDiscountSchema } },
    async (request) => ({
      supplier: await setSupplierDefaultDiscount(
        pool,
        request.params.id,
        request.body.default_discount
      ),
    })
  )

  // Every write below answers with the whole terms row in the read model's
  // shape, so the response carries `net_multiplier` — what the chain the office
  // just typed actually evaluates to ({0.4, 0.4} -> 0.36). There is no other way
  // to check it, and a silent typo moves every price under that house.
  app.post(
    '/admin/suppliers/:id/brand-terms',
    { preHandler: financeStaff, schema: { params: idParamsSchema, body: createTermsSchema } },
    async (request, reply) => {
      const terms = await createSupplierBrandTerms(pool, request.params.id, request.body)
      reply.code(201)
      return { terms }
    }
  )

  app.patch(
    '/admin/suppliers/:id/brand-terms/:termsId',
    { preHandler: financeStaff, schema: { params: termsParamsSchema, body: patchTermsSchema } },
    async (request) => ({
      terms: await updateSupplierBrandTerms(
        pool,
        request.params.id,
        request.params.termsId,
        request.body
      ),
    })
  )

  // Scoped first, then deleted: deleteOrExplain addresses a row by id alone, so
  // without this a terms id from another supplier would be reachable through
  // this supplier's path. 'supplier_brand_term' is a code literal — the entity
  // name is never taken from the URL.
  app.delete(
    '/admin/suppliers/:id/brand-terms/:termsId',
    { preHandler: financeStaff, schema: { params: termsParamsSchema } },
    async (request, reply) => {
      const { id, termsId } = request.params
      if (!(await getSupplierBrandTerms(pool, id, termsId))) {
        reply.code(404)
        return { error: 'Not Found', message: `Supplier ${id} has no terms ${termsId}.` }
      }
      return replyDelete(
        reply,
        await deleteOrExplain(pool, 'supplier_brand_term', termsId, { user: request.user })
      )
    }
  )

  app.post(
    '/admin/suppliers/:id/brand-terms/:termsId/tiers',
    { preHandler: financeStaff, schema: { params: termsParamsSchema, body: createTierSchema } },
    async (request, reply) => {
      const terms = await createSupplierDiscountTier(
        pool,
        request.params.id,
        request.params.termsId,
        request.body
      )
      reply.code(201)
      return { terms }
    }
  )

  app.patch(
    '/admin/suppliers/:id/brand-terms/:termsId/tiers/:tierId',
    { preHandler: financeStaff, schema: { params: tierParamsSchema, body: patchTierSchema } },
    async (request) => ({
      terms: await updateSupplierDiscountTier(
        pool,
        request.params.id,
        request.params.termsId,
        request.params.tierId,
        request.body
      ),
    })
  )

  app.delete(
    '/admin/suppliers/:id/brand-terms/:termsId/tiers/:tierId',
    { preHandler: financeStaff, schema: { params: tierParamsSchema } },
    async (request, reply) => {
      const { id, termsId, tierId } = request.params
      if (!(await findScopedTierId(pool, id, termsId, tierId))) {
        reply.code(404)
        return { error: 'Not Found', message: `Terms ${termsId} have no tier ${tierId}.` }
      }
      return replyDelete(
        reply,
        await deleteOrExplain(pool, 'supplier_discount_tier', tierId, { user: request.user })
      )
    }
  )
}
