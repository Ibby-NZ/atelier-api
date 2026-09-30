/**
 * The supplier roster, second ruling (1 Oct 2026, after 1792790400000).
 *
 * - "Merge Rubelli under Rubelli Venezia": the duplicate Rubelli (which held the
 *   house Rubelli's 520 price lines) merges into Rubelli Venezia, the supplier
 *   the Rubelli and Kieffer houses sit under — the same merge the roster made
 *   for the house-named suppliers (lines, aliases and the rest move; "Rubelli"
 *   becomes an alias; the row is archived).
 * - Inter-weave stays a supplier "for now": it is created (it had no row) with
 *   the contact the list gives, and the house STOCK - INTERWEAVE is linked to it.
 * - Alpaka, Libeco, Solbiati and Stoker Mills stay, as the roster left them.
 *
 * The statement is the roster migration's own (`rosterSql`), imported rather
 * than copied: that migration has run and is a fixed record, and one merge rule
 * is safer than two that could drift. A no-op on a database without the roster.
 * DOWN DOES NOTHING.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
import { rosterSpec, rosterSql } from './1792790400000_supplier-roster.js'

export const SPEC = rosterSpec({
  houses: { 'stock-interweave': 'Inter-weave' },
  also: [],
  merges: { Rubelli: 'Rubelli Venezia' },
  notSuppliers: [],
  contacts: [{ supplier: 'Inter-weave', country: 'New Zealand', people: [['Customer service', 'customerservice@inter-weave.co.nz']] }],
})

export const CREATE_INTERWEAVE = `
  INSERT INTO suppliers (name, slug, country)
  SELECT 'Inter-weave', 'inter-weave', 'New Zealand'
   WHERE EXISTS (SELECT 1 FROM suppliers WHERE lower(name) = 'fabricut')
     AND EXISTS (SELECT 1 FROM suppliers WHERE lower(name) = 'pierre frey')
     AND NOT EXISTS (SELECT 1 FROM suppliers WHERE lower(name) = 'inter-weave' OR slug = 'inter-weave')
`

export const up = (pgm) => {
  pgm.sql(CREATE_INTERWEAVE)
  pgm.sql(rosterSql(SPEC))
}

export const down = () => {}
