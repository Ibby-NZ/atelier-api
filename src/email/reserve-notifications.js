// Reserve and cutting notifications — the letters the office sends to the
// HOUSES (W24). A reserve asks a mill to hold cloth it already has for a named
// client; a cutting asks it to post a physical sample. Neither is an order.
//
// Four things about this domain decide the shape of everything below:
//
//   - **A docket spans HOUSES, so one save is several letters.** `reserve_lines`
//     carries its own `supplier` per line, and a client rings up about cloth
//     from three mills at once. The unit of sending is therefore (house × kind),
//     not the docket: one letter per house, and a separate one per kind because
//     "hold this" and "post us a cutting" are different asks and a house that
//     receives them merged answers one of them.
//
//   - **The house is free text, so it may match no supplier at all.**
//     `reserve_lines.supplier` is a typed string with no foreign key (a D365
//     carry-over). `resolveSupplierEmail` matches it case-insensitively against
//     `suppliers.name` and returns null for anything less exact. A null means
//     NOTHING is emailed to that house — and the back-office copy is then the
//     only place that fact appears, which is precisely why the copy is sent
//     even when the supplier letter is not.
//
//   - **The trigger is the WRITE, and the letter covers exactly what was
//     written.** `POST /admin/reserves` and `POST /admin/reserves/:id/lines`
//     each carry their new lines in the request body, so the notifier is handed
//     that array rather than the docket's full line list. A docket the office
//     adds to next week must not re-ask the house for what it already holds.
//
//   - **Only `cancelled` mails the house after that.** `confirmed` is the house
//     telling US something, `arrived` is our warehouse, `dispatched` is our
//     courier — a letter for any of them tells the house what it already knows.
//     A cancellation is the one move that costs the house money if it never
//     arrives: cloth stays held against a client who walked away.
//
// Every helper is a no-op when `mailer` is null and NEVER throws — a reserve
// line that moved must not un-move because a relay was down.

import { resolveSupplierEmail } from './recipients.js'

const KIND_LABELS = Object.freeze({ reserve: 'Reserve', cutting: 'Cutting' })

const REQUEST_TEMPLATES = Object.freeze({
  reserve: 'supplier_reserve_request',
  cutting: 'supplier_cutting_request',
})

/**
 * One line as the house reads it. Our own ids are absent on purpose: nothing
 * here is a reference the mill can look up, and a letter of internal numbers is
 * a letter that gets forwarded back asking which cloth is meant.
 *
 * `multiplier` is the "×10 / ×20" copies count and is printed only when it is
 * more than one — a line reading "×1" is noise on every single-cutting request.
 */
const formatLine = (line, index) => {
  const label = [line.range_name, line.product_name].filter(Boolean).join(' — ')
  const multiplier = Number(line.multiplier ?? 1)
  return [
    `  ${index + 1}. ${label || line.product_name || 'Unnamed'}`,
    line.colour ? `     Colour: ${line.colour}` : null,
    line.product_code ? `     Code: ${line.product_code}` : null,
    line.qty ? `     Quantity: ${line.qty}` : null,
    multiplier > 1 ? `     Copies: ${multiplier}` : null,
    line.reserved_until ? `     Please hold until: ${line.reserved_until}` : null,
    line.reserve_number ? `     Your reference: ${line.reserve_number}` : null,
    line.comment ? `     Note: ${line.comment}` : null,
  ]
    .filter(Boolean)
    .join('\n')
}

const formatLines = (lines) => lines.map(formatLine).join('\n')

/**
 * Group lines into the letters they will become: one bucket per house per kind.
 * A line with no house at all still gets a bucket (keyed on an empty name) so
 * the office is told about it — a line nobody was asked for is the failure this
 * whole file exists to make visible.
 */
const groupForSending = (lines) => {
  const groups = new Map()
  for (const line of lines ?? []) {
    const kind = REQUEST_TEMPLATES[line.kind] ? line.kind : 'reserve'
    const supplier = (line.supplier ?? '').trim()
    const key = `${kind}::${supplier.toLowerCase()}`
    const existing = groups.get(key)
    if (existing) existing.lines.push(line)
    else groups.set(key, { kind, supplier, lines: [line] })
  }
  return [...groups.values()]
}

/**
 * Ask the houses for the lines just raised on a docket, and copy the office.
 *
 * @param {import('./mailer.js').Mailer|null} mailer
 * @param {{ query: Function }} db
 * @param {{ account_name?: string|null, owner_name?: string|null }} docket
 * @param {ReadonlyArray<object>} lines  the lines THIS request created
 */
export const notifyReserveRequest = async (mailer, db, docket, lines) => {
  if (!mailer || !lines?.length) {
    return { ok: false }
  }
  for (const group of groupForSending(lines)) {
    const kindLabel = KIND_LABELS[group.kind]
    const linesText = formatLines(group.lines)
    const supplierEmail = await resolveSupplierEmail(db, group.supplier)
    const data = {
      supplier_name: group.supplier || 'Sir or Madam',
      account_name: docket?.account_name ?? null,
      owner_name: docket?.owner_name ?? null,
      lines_text: linesText,
    }
    if (supplierEmail) {
      await mailer.send({
        template: REQUEST_TEMPLATES[group.kind],
        to: supplierEmail,
        data,
      })
    }
    // Sent whether or not the house was reachable: when it was not, this is the
    // only record that the request exists and nobody has actually been asked.
    await mailer.send({
      template: 'backoffice_reserve_request',
      to: mailer.backofficeEmail,
      data: {
        kind_label: kindLabel,
        supplier_name: group.supplier || null,
        supplier_email: supplierEmail,
        account_name: docket?.account_name ?? null,
        owner_name: docket?.owner_name ?? null,
        lines_text: linesText,
      },
    })
  }
  return { ok: true }
}

/**
 * A line moved. Only `cancelled` writes to the house — see the header.
 *
 * The line is re-read from the docket the transition returned rather than
 * trusted from the caller, so the letter quotes the row as it now stands.
 *
 * @param {import('./mailer.js').Mailer|null} mailer
 * @param {{ query: Function }} db
 * @param {{ account_name?: string|null, lines?: ReadonlyArray<object> }} docket
 * @param {number} lineId
 * @param {string} status
 */
export const notifyReserveLineTransition = async (mailer, db, docket, lineId, status) => {
  if (!mailer || status !== 'cancelled') {
    return { ok: false }
  }
  const line = (docket?.lines ?? []).find((candidate) => candidate.id === Number(lineId))
  if (!line) {
    return { ok: false }
  }
  const supplierEmail = await resolveSupplierEmail(db, line.supplier)
  if (!supplierEmail) {
    return { ok: false }
  }
  await mailer.send({
    template: 'supplier_reserve_cancelled',
    to: supplierEmail,
    data: {
      supplier_name: line.supplier,
      kind_label: (KIND_LABELS[line.kind] ?? 'Reserve').toLowerCase(),
      lines_text: formatLine(line, 0),
      reserve_number: line.reserve_number,
      account_name: docket?.account_name ?? null,
    },
  })
  return { ok: true }
}
