/**
 * The supplier roster the office sent (28 Sep 2026, "Supplier contacts Sept
 * 2026.ods") and its ruling on 1 Oct 2026.
 *
 * The Suppliers screen listed 67 suppliers. The office: the suppliers are the
 * ones the list names; "a house/range's price list sits under the house, and
 * the house in turn sits under the supplier" — a price list is a HOUSE's, even
 * where the house and its supplier share a name (Fabricut, Pierre Frey).
 *
 * 1. Every house the list names is linked to its supplier (live already
 *    agreed; this makes the list the rule).
 * 2. A supplier that is really a HOUSE (Trend, Stroheim, Larsen, Boussac …,
 *    raised by the price-list roll-up, one per price-list spelling) is MERGED
 *    into the supplier that invoices it: its price lines, samples, orders,
 *    invoices, contacts, aliases, terms and rates move across; its name becomes
 *    an ALIAS of that supplier, so an import or a backfill that says "Trend"
 *    files under Fabricut and never raises it again; it is renamed
 *    "<name> (merged into <supplier>)" and archived. A price line keeps its own
 *    `supplier` text, which is the house's price-list name and the import's key.
 * 3. Stroheim is also invoiced by Jim Thompson (the list files it under both);
 *    Fabricut stays its main supplier.
 * 4. The Xero contacts that are not textile suppliers are archived where no
 *    house, order or invoice points at them — archived, not deleted, so their
 *    Xero link stays and the next Xero pull refreshes them rather than raising
 *    them again.
 * 5. The list's contacts are added where the supplier has none with that
 *    email, spelt as the list spells them; a blank country is filled.
 *
 * The two duplicates (Janelli Volpi, Rubelli) are kept for now, as the office
 * asked. On a database that does not hold the roster (a fresh or test database)
 * this does nothing. DOWN DOES NOTHING — a merge cannot be told apart afterwards.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */

/** House (by slug) -> its supplier (by the platform's own name for it). */
export const HOUSES = Object.freeze({
  'cc-milano': 'C&C Milano',
  'colefax-fowler': 'Colefax & Fowler',
  'jane-churchill': 'Colefax & Fowler',
  larsen: 'Colefax & Fowler',
  'manuel-canovas': 'Colefax & Fowler',
  'de-le-cuona': 'De Le Cuona',
  fabricut: 'Fabricut',
  's-harris': 'Fabricut',
  vervain: 'Fabricut',
  trend: 'Fabricut',
  stroheim: 'Fabricut',
  'clarence-house': 'Fabricut',
  fine: 'Fine',
  'garrett-leather': 'Garrett Leather',
  hamam: 'Hamam',
  houles: 'Houlès',
  'jean-monro': 'Jean Monro',
  'jim-thompson': 'Jim Thompson',
  'no-9-thompson': 'Jim Thompson',
  'studio-b': 'Jim Thompson',
  monogram: 'Jim Thompson',
  'fox-linton': 'Jim Thompson',
  'liberty-london': 'Liberty',
  link: 'Link',
  'loro-piana': 'Loro Piana',
  'maria-flora': 'Maria Flora',
  'filippo-uecher': 'Maria Flora',
  'jannelli-volpi': 'Jannelli Volpi',
  'missoni-home': 'Jannelli Volpi',
  'armani-casa': 'Jannelli Volpi',
  sirpi: 'Jannelli Volpi',
  code: 'Jannelli Volpi',
  marimekko: 'Jannelli Volpi',
  metaphores: 'Metaphores',
  'verel-de-belval': 'Metaphores',
  madeaux: 'Madeaux',
  'perennials-outdoor-fabric': 'Perennials',
  'pierre-frey': 'Pierre Frey',
  boussac: 'Pierre Frey',
  'fadini-borghi': 'Pierre Frey',
  braquenie: 'Pierre Frey',
  'le-manach': 'Pierre Frey',
  'rubelli-venezia': 'Rubelli Venezia',
  kieffer: 'Rubelli Venezia',
})

/** A house the list files under a second supplier: "also invoiced by". */
export const ALSO_INVOICED_BY = Object.freeze([['stroheim', 'Jim Thompson']])

/** A supplier that is really a house -> the supplier that invoices it. */
export const MERGES = Object.freeze({
  Altagamma: 'Jannelli Volpi',
  'Armani Casa': 'Jannelli Volpi',
  Boussac: 'Pierre Frey',
  Braquenie: 'Pierre Frey',
  'Clarence House': 'Fabricut',
  'Fadini Borghi': 'Pierre Frey',
  'Filippo Uecher': 'Maria Flora',
  'Fox Linton': 'Jim Thompson',
  'Jane Churchill': 'Colefax & Fowler',
  'JV Design': 'Jannelli Volpi',
  JWall: 'Jannelli Volpi',
  Kieffer: 'Rubelli Venezia',
  Larsen: 'Colefax & Fowler',
  'Le Crin': 'Metaphores',
  'Le Manach': 'Pierre Frey',
  'Manuel Canovas': 'Colefax & Fowler',
  Missoni: 'Jannelli Volpi',
  'Nicky Haslam': 'Jean Monro',
  'S Harris': 'Fabricut',
  Stroheim: 'Fabricut',
  Trend: 'Fabricut',
  'Verel De Belval': 'Metaphores',
  Vervain: 'Fabricut',
})

/** Xero contacts that are not textile suppliers. */
export const NOT_SUPPLIERS = Object.freeze([
  'ABC Furniture', 'Bayside Club', 'Bayside Wholesale', 'Capital Cab Co', 'Carlton Functions',
  'Central Copiers', 'DIISR - Small Business Services', 'Gateway Motors', 'Hoyt Productions',
  'MCO Cleaning Services', 'Net Connect', 'PC Complete', 'PowerDirect', 'SMART Agency',
  'Swanston Security', 'Truxton Property Management', 'Xero', 'Young Bros Transport',
])

/**
 * The list's contacts — [name, email, role?] — and each supplier's country,
 * spelt as the list spells them. Rubelli's goes on Rubelli Venezia, the one its
 * houses sit under.
 */
export const CONTACTS = Object.freeze([
  { supplier: 'C&C Milano', country: 'Italy', people: [['Elena Derla', 'elenaderla@cec-milano.com']] },
  { supplier: 'Colefax & Fowler', country: 'United Kingdom', people: [['Jennifer Burk', 'jennifer.burk@colefax.co.uk']] },
  { supplier: 'De Le Cuona', country: 'United States', people: [['Emma Ballantine', 'Emma@delecuona.com']] },
  { supplier: 'Fabricut', country: 'United States', people: [['Kelli Morgan', 'kelli.morgan@fabricut.com']] },
  { supplier: 'Fine', country: 'Austria', people: [['Katharina Farzam', 'Katharina.Farzam@fine.a']] },
  { supplier: 'Garrett Leather', country: 'United States', people: [['Kelsey Macpherson', 'KMacpherson@garrettleather.com']] },
  { supplier: 'Hamam', country: 'Turkey', people: [['Buket Bıçak', 'buket.bicak@hamam.com']] },
  { supplier: 'Houlès', country: 'France', people: [['Vincent LECOUVÉ', 'vincent.lecouve@houles.com']] },
  { supplier: 'Jean Monro', country: null, people: [['Dhiran Gurung', 'sales@jeanmonro.com']] },
  { supplier: 'Jim Thompson', country: 'Thailand', people: [['Supakorn', 'supakorn@jimthompson.com']] },
  {
    supplier: 'Liberty',
    country: 'United Kingdom',
    people: [['Lucile Chaix', 'interiorswholesale@libertylondon.com', 'Stock + reserves'], ['Karin Fritz', 'KFritz@libertylondon.com']],
  },
  {
    supplier: 'Link',
    country: 'United States',
    people: [['Matthew Robinson', 'mrobinson@linkoutdoor.com', 'Stock + reserves'], ['Michelle Brown', 'mbrown@linkoutdoor.com', 'Sampling']],
  },
  { supplier: 'Loro Piana', country: 'Italy', people: [['Maria Grazia Casalino', 'mariagrazia.casalino@loropiana.com']] },
  { supplier: 'Maria Flora', country: 'Italy', people: [['Asmaa El Haddadi', 'asmaa@mffu.it']] },
  { supplier: 'Libeco', country: 'Belgium', people: [['Customer service', 'customerservice@melman.com.au']] },
  { supplier: 'Jannelli Volpi', country: 'Italy', people: [['Hadeil Eid', 'hadeil.eid@jannellievolpi.it']] },
  { supplier: 'Metaphores', country: 'France', people: [['Silvia Modena', 'sm@mffu.it']] },
  { supplier: 'Madeaux', country: 'United Kingdom', people: [['Suzie Thorn', 'sales@madeaux.com']] },
  { supplier: 'Perennials', country: 'United States', people: [['Jennifer Rogers', 'internationalsupport@sutherlandfurniture.com']] },
  { supplier: 'Pierre Frey', country: 'France', people: [['Wendy Zhang', 'wendy.zhang@pierrefrey.com']] },
  { supplier: 'Rubelli Venezia', country: 'Italy', people: [['Monica Simonaio', 'M.Simonaio@rubelli.com']] },
  { supplier: 'Solbiati', country: 'Italy', people: [['Maria Grazia Casalino', 'mariagrazia.casalino@loropiana.com']] },
  { supplier: 'Stoker Mills', country: 'United Kingdom', people: [['Ryan', 'ryan@stokermills.com']] },
])

/** The roster as the SQL reads it. */
export const rosterSpec = ({ houses = HOUSES, also = ALSO_INVOICED_BY, merges = MERGES, notSuppliers = NOT_SUPPLIERS, contacts = CONTACTS } = {}) => ({
  houses: Object.entries(houses).map(([house, supplier]) => ({ house, supplier })),
  also: also.map(([house, supplier]) => ({ house, supplier })),
  merges: Object.entries(merges).map(([from, into]) => ({ from, into })),
  notSuppliers,
  contacts: contacts.flatMap(({ supplier, country, people }) =>
    people.map(([name, email, role = null]) => ({ supplier, country, name, email, role }))
  ),
})

// Checked at load: a typo must fail here, not quietly match nothing on live.
for (const house of Object.keys(HOUSES)) {
  if (!/^[a-z0-9-]+$/.test(house)) throw new Error(`supplier roster: bad house slug "${house}"`)
}
for (const { people } of CONTACTS) {
  for (const [name, email] of people) {
    if (!name || !/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error(`supplier roster: bad contact ${name} <${email}>`)
  }
}

/**
 * The migration's statement for a spec. `guard` (true for the migration) makes
 * it a no-op on a database without the roster; a test passes its own fixtures.
 */
export const rosterSql = (spec, { guard = true } = {}) => {
  const json = JSON.stringify(spec)
  if (json.includes('$spec$')) throw new Error('supplier roster: the spec may not contain its own quote tag')
  return `
DO $migration$
DECLARE
  spec jsonb := $spec$${json}$spec$::jsonb;
  entry jsonb;
  old_id int; old_name text; new_id int; new_name text; target int;
BEGIN
  ${guard ? `IF NOT EXISTS (SELECT 1 FROM suppliers WHERE lower(name) = 'fabricut')
     OR NOT EXISTS (SELECT 1 FROM suppliers WHERE lower(name) = 'pierre frey') THEN
    RETURN;
  END IF;` : ''}

  -- 1. Every house the list names, under its supplier.
  FOR entry IN SELECT * FROM jsonb_array_elements(spec->'houses') LOOP
    SELECT id INTO target FROM suppliers WHERE lower(name) = lower(entry->>'supplier') AND archived_at IS NULL;
    CONTINUE WHEN target IS NULL;
    UPDATE brands SET supplier_id = target WHERE slug = entry->>'house' AND supplier_id IS DISTINCT FROM target;
  END LOOP;

  -- 2. A supplier that is really a house, into the supplier that invoices it.
  FOR entry IN SELECT * FROM jsonb_array_elements(spec->'merges') LOOP
    old_id := NULL; new_id := NULL;
    SELECT id, name INTO old_id, old_name FROM suppliers WHERE lower(name) = lower(entry->>'from');
    SELECT id, name INTO new_id, new_name FROM suppliers WHERE lower(name) = lower(entry->>'into') AND archived_at IS NULL;
    CONTINUE WHEN old_id IS NULL OR new_id IS NULL OR old_id = new_id;

    UPDATE brands SET supplier_id = new_id WHERE supplier_id = old_id;
    UPDATE price_list_items SET supplier_id = new_id WHERE supplier_id = old_id;
    UPDATE samples SET supplier_id = new_id WHERE supplier_id = old_id;
    UPDATE sample_orders SET supplier_id = new_id WHERE supplier_id = old_id;
    UPDATE purchase_orders SET supplier_id = new_id WHERE supplier_id = old_id;
    UPDATE purchase_order_bulks SET supplier_id = new_id WHERE supplier_id = old_id;
    UPDATE supplier_invoices SET supplier_id = new_id WHERE supplier_id = old_id;
    UPDATE supplier_contacts SET supplier_id = new_id WHERE supplier_id = old_id;
    UPDATE supplier_contact_log SET supplier_id = new_id WHERE supplier_id = old_id;
    UPDATE supplier_aliases SET supplier_id = new_id WHERE supplier_id = old_id;
    UPDATE supplier_brand_terms SET supplier_id = new_id WHERE supplier_id = old_id;
    UPDATE supplier_pricing_parameters SET supplier_id = new_id
     WHERE supplier_id = old_id AND NOT EXISTS (SELECT 1 FROM supplier_pricing_parameters WHERE supplier_id = new_id);
    UPDATE supplier_freight_rates f SET supplier_id = new_id
     WHERE f.supplier_id = old_id
       AND NOT EXISTS (
         SELECT 1 FROM supplier_freight_rates g
          WHERE g.supplier_id = new_id AND g.category IS NOT DISTINCT FROM f.category
            AND g.freight_class IS NOT DISTINCT FROM f.freight_class AND g.effective_from = f.effective_from);
    DELETE FROM brand_additional_suppliers b
     WHERE b.supplier_id = old_id
       AND (EXISTS (SELECT 1 FROM brand_additional_suppliers x WHERE x.brand_id = b.brand_id AND x.supplier_id = new_id)
            OR EXISTS (SELECT 1 FROM brands h WHERE h.id = b.brand_id AND h.supplier_id = new_id));
    UPDATE brand_additional_suppliers SET supplier_id = new_id WHERE supplier_id = old_id;

    -- The supplier's blanks from the merged row. A Xero link moves only to a
    -- supplier without one; otherwise it stays on the archived row, where the
    -- next Xero pull still finds it rather than raising a new supplier.
    UPDATE suppliers t
       SET country = COALESCE(t.country, o.country),
           currency = COALESCE(t.currency, o.currency),
           po_email = COALESCE(t.po_email, o.po_email),
           phone = COALESCE(t.phone, o.phone),
           address = COALESCE(t.address, o.address),
           website_url = COALESCE(t.website_url, o.website_url),
           xero_contact_id = COALESCE(t.xero_contact_id, o.xero_contact_id),
           updated_at = now()
      FROM suppliers o
     WHERE t.id = new_id AND o.id = old_id;
    UPDATE suppliers o SET xero_contact_id = NULL
      FROM suppliers t
     WHERE o.id = old_id AND t.id = new_id AND t.xero_contact_id = o.xero_contact_id;

    UPDATE suppliers
       SET name = old_name || ' (merged into ' || new_name || ')',
           archived_at = COALESCE(archived_at, now()),
           updated_at = now()
     WHERE id = old_id;
    INSERT INTO supplier_aliases (supplier_id, alias)
    SELECT new_id, old_name
     WHERE NOT EXISTS (SELECT 1 FROM supplier_aliases WHERE lower(btrim(alias)) = lower(btrim(old_name)));
  END LOOP;

  -- 3. Also invoiced by.
  FOR entry IN SELECT * FROM jsonb_array_elements(spec->'also') LOOP
    INSERT INTO brand_additional_suppliers (brand_id, supplier_id)
    SELECT h.id, s.id FROM brands h, suppliers s
     WHERE h.slug = entry->>'house' AND lower(s.name) = lower(entry->>'supplier') AND s.archived_at IS NULL
       AND h.supplier_id IS DISTINCT FROM s.id
    ON CONFLICT DO NOTHING;
  END LOOP;

  -- 4. Not textile suppliers, where nothing points at them.
  UPDATE suppliers s SET archived_at = now(), updated_at = now()
   WHERE s.archived_at IS NULL
     AND lower(s.name) IN (SELECT lower(value) FROM jsonb_array_elements_text(spec->'notSuppliers'))
     AND NOT EXISTS (SELECT 1 FROM brands WHERE supplier_id = s.id)
     AND NOT EXISTS (SELECT 1 FROM purchase_orders WHERE supplier_id = s.id)
     AND NOT EXISTS (SELECT 1 FROM purchase_order_bulks WHERE supplier_id = s.id)
     AND NOT EXISTS (SELECT 1 FROM supplier_invoices WHERE supplier_id = s.id);

  -- 5. The contacts, and a blank country.
  FOR entry IN SELECT * FROM jsonb_array_elements(spec->'contacts') LOOP
    target := NULL;
    SELECT id INTO target FROM suppliers WHERE lower(name) = lower(entry->>'supplier') AND archived_at IS NULL;
    CONTINUE WHEN target IS NULL;
    UPDATE suppliers SET country = entry->>'country', updated_at = now()
     WHERE id = target AND country IS NULL AND entry->>'country' IS NOT NULL;
    INSERT INTO supplier_contacts (supplier_id, name, role, email, note)
    SELECT target, entry->>'name', entry->>'role', entry->>'email', 'From the supplier contacts list, Sept 2026'
     WHERE NOT EXISTS (SELECT 1 FROM supplier_contacts WHERE supplier_id = target AND lower(email) = lower(entry->>'email'));
  END LOOP;
END
$migration$;
`
}

export const up = (pgm) => {
  pgm.sql(rosterSql(rosterSpec()))
}

export const down = () => {}
