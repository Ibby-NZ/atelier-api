// Report access and masking — the one place a report is narrowed to what the
// caller may see, applied SERVER-SIDE before either the table or the CSV exists
// (US-006 hands maskReport's output straight to the writer, so the file and the
// screen cannot disagree about what was withheld).
//
// Four rules it exists to enforce:
//
//   - Access is derived from `request.user` and NOTHING else. Never a query
//     param, a header or a body value — those are the caller's own account of
//     what it may see. `users.can_view_finance` is the fact.
//
//   - A finance column is DELETED: from `columns`, from every row and from
//     `totals`. Not nulled and not blanked — a key that survives with an empty
//     value still tells the reader which figures exist and is one grep away
//     from being counted.
//
//   - Rows are PROJECTED onto the surviving columns rather than having the
//     finance keys subtracted from them. Subtraction can only remove what
//     somebody remembered to declare; a projection cannot leak a key nobody
//     declared. The cost is that an undeclared key silently disappears, which
//     surfaces immediately as a missing value in the report's own test — the
//     opposite of a leak, which is invisible.
//
//   - A report that is finance end to end answers 403 with a reason, never 200
//     with an empty table. "No rows" and "you may not see this" are
//     indistinguishable on a screen, and only the second is something a person
//     can act on.
//
// The module is pure: it takes a user record and a built report, and issues no
// query. What a report CONTAINS is each report module's business; which of it
// survives is this one's.

import { effectiveRole } from '../auth/guards.js'

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

// The roles a report is served to at all. The real gate is the route's own
// requireRole('backoffice') (director inherits); this list is the DERIVED
// statement /auth/me hands the CRM in US-008, so a drift here can only
// mis-describe a route, never open one.
export const REPORT_ROLES = Object.freeze(['backoffice', 'director'])

// Anonymous, a client, or a staff login with no finance grant.
export const NO_REPORT_ACCESS = Object.freeze({ reports: false, finance: false })

/**
 * What a login may read of the report library. Derived from the user record
 * alone — this function deliberately takes no request, so there is nothing a
 * caller could send that reaches it.
 *
 * @param {object|null} [user] request.user
 * @returns {Readonly<{ reports: boolean, finance: boolean }>}
 */
export const reportAccess = (user) => {
  if (!user) {
    return NO_REPORT_ACCESS
  }
  const reports = REPORT_ROLES.includes(effectiveRole(user))
  // Finance visibility is the explicit column, never the role: `backoffice`
  // covers the showroom and the accounts desk alike, which is exactly why a
  // second permission exists. A director created after the migration's backfill
  // therefore starts closed and is granted like anyone else — that is what
  // makes the grant revocable, where a role-derived answer could be handed out
  // and never taken back.
  return Object.freeze({
    reports,
    finance: reports && user.can_view_finance === true,
  })
}

/**
 * The same statement as reportAccess, resolved against the database when the
 * caller's own record does not carry the flag.
 *
 * `src/auth/guards.js` loads `request.user` through PUBLIC_USER_COLUMNS, which
 * is `id, email, name, role, trade_approved` and no more — so a route calling
 * `reportAccess(request.user)` reads `can_view_finance` as `undefined` and
 * answers `finance: false` to everyone, for ever. Nothing shows it today (no
 * report in Epic 5 declares a finance column), but /auth/me now publishes a
 * DERIVED report_access to the CRM, and a payload that says "you may see costs"
 * while the report route masks as though you may not is the exact drift this
 * layer exists to prevent — two statements of one rule, disagreeing.
 *
 * So the report layer fetches the one column it needs, keyed on the id the
 * SESSION resolved and never on anything the caller sent. It is a primary-key
 * lookup beside an unbounded aggregate, and it disappears of its own accord the
 * day the guard's projection carries the flag: a record that already has it is
 * used as-is. Fails closed — a row that has gone has no finance.
 *
 * @param {{ query: Function }} db pool or open client
 * @param {object|null} user request.user
 * @returns {Promise<Readonly<{ reports: boolean, finance: boolean }>>}
 */
export const loadReportAccess = async (db, user) => {
  if (!user || Object.hasOwn(user, 'can_view_finance')) {
    return reportAccess(user)
  }
  const { rows } = await db.query('SELECT can_view_finance FROM users WHERE id = $1', [user.id])
  return reportAccess({ ...user, can_view_finance: rows[0]?.can_view_finance === true })
}

// How a cell is meant to be read. The CSV writer and the CRM's cell pipeline
// both need to know a figure from a name, and the column is the only place that
// is stated once for the table and the file alike. `finance` is independent of
// it: a sell value is money and is not a cost.
export const COLUMN_KINDS = Object.freeze(['text', 'number', 'money', 'date'])

const COLUMN_KEY = /^[a-z][a-z0-9_]*$/

/**
 * Declare a report's columns. Called at module load by each report, so a
 * malformed declaration throws while the file is loading rather than reaching a
 * response — the posture assertEntity (src/lifecycle/registry.js) takes.
 *
 * @param {ReadonlyArray<{ key: string, label: string, kind?: string, finance?: boolean }>} columns
 * @returns {ReadonlyArray<Readonly<object>>}
 */
export const defineColumns = (columns) => {
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new Error('A report must declare at least one column.')
  }

  const seen = new Set()
  const declared = columns.map((column) => {
    const { key, label, kind = 'text', finance = false } = column ?? {}
    if (typeof key !== 'string' || !COLUMN_KEY.test(key)) {
      throw new Error(`Report column has a malformed key: ${JSON.stringify(key)}`)
    }
    if (seen.has(key)) {
      throw new Error(`Report column "${key}" is declared twice.`)
    }
    if (typeof label !== 'string' || label.trim() === '') {
      throw new Error(`Report column "${key}" has no label.`)
    }
    if (!COLUMN_KINDS.includes(kind)) {
      throw new Error(`Report column "${key}" has an unknown kind: ${kind}`)
    }
    seen.add(key)
    return Object.freeze({ key, label, kind, finance: finance === true })
  })

  return Object.freeze(declared)
}

// Only the declared keys survive, and they come out in column order — so one
// report always produces one row shape, which is what the CSV writer needs.
const projectOnto = (keys, source) => {
  const projected = {}
  for (const key of keys) {
    if (source && Object.hasOwn(source, key)) {
      projected[key] = source[key]
    }
  }
  return projected
}

const financeOnlyReason = (report) =>
  report.finance_reason ??
  `The "${report.report ?? 'requested'}" report is a finance report end to end, ` +
    'so there is no version of it without the money. Your account does not have ' +
    'finance visibility.'

/**
 * Narrow a built report to what this login may see.
 *
 * The report is `{ report, columns, rows, totals, meta }`, where `columns` came
 * from defineColumns. A report with no non-finance column left — or one that
 * declares `finance_only` — is refused with 403 rather than served empty.
 *
 * @param {object} report
 * @param {{ finance?: boolean }} [access] output of reportAccess
 * @returns {Readonly<object>}
 */
export const maskReport = (report, access = NO_REPORT_ACCESS) => {
  const columns = report?.columns
  if (!Array.isArray(columns) || columns.length === 0) {
    // A code fault, not a caller's: a report that declares no columns has no
    // masking rule to apply and would serve an untyped payload.
    throw new Error(`Report "${report?.report ?? 'unknown'}" declares no columns.`)
  }

  const finance = access?.finance === true
  const kept = finance ? columns : columns.filter((column) => !column.finance)

  if (!finance && (report.finance_only === true || kept.length === 0)) {
    throw httpError(403, financeOnlyReason(report))
  }

  const keys = kept.map((column) => column.key)
  const totals = report.totals ? projectOnto(keys, report.totals) : null

  return Object.freeze({
    ...report,
    columns: Object.freeze(kept),
    rows: (report.rows ?? []).map((row) => projectOnto(keys, row)),
    // An empty totals object would render as a totals row with nothing in it,
    // which is the "silently short" table US-008 has to be able to label.
    totals: totals && Object.keys(totals).length > 0 ? totals : null,
    meta: Object.freeze({
      ...report.meta,
      // Labels only: a masked column's KEY is the machine name of a figure this
      // caller may not have, and the note exists so the reader knows the table
      // is partial — not so a client can reconstruct the schema.
      masked_columns: Object.freeze(
        columns.filter((column) => !kept.includes(column)).map((column) => column.label)
      ),
    }),
  })
}
