/**
 * The barcode minter (W20-US-002).
 *
 * The client's words: "at the moment we have to manually keep track of our own
 * barcode number. What we couldn't get the old system to do was to remember the
 * next number... sometimes it gets doubled up." The doubling-up half is ALREADY
 * SOLVED and is not re-implemented here — `samples.barcode` is NOT NULL UNIQUE
 * and a duplicate is the database's 23505 on `samples_barcode_key`, mapped to a
 * 409 by src/samples/admin-samples.js, never by a pre-check that races the
 * scanner. The gap is only "remember the next number", and this is it.
 *
 * A SEQUENCE, NOT `max(barcode) + 1`. A max-plus-one has to read the whole
 * corpus, serialises every insert behind that read, and still races: two
 * concurrent creates read the same maximum and mint the same tag, which is
 * exactly the doubling-up being complained about. A sequence is non-blocking,
 * non-transactional and hands every caller a distinct value with no lock at all.
 * Gaps are the price (a rolled-back create burns its number) and are the correct
 * trade: a gap in a tag series costs nothing, a duplicate costs a mislabelled
 * physical object.
 *
 * THE FORMAT: `ATL-S-` + six zero-padded digits, e.g. `ATL-S-001000`. It is
 * spelled in src/samples/admin-samples.js (the module that mints it) rather than
 * as a column DEFAULT, so there is one copy of it and not two to drift apart.
 * The evidence behind it, all of it gathered from this database and this repo:
 *
 *   - `samples` currently holds ZERO rows. There is no live corpus to collide
 *     with yet, which is the cheapest moment there will ever be to fix a format.
 *   - `legacy_cuttings` — 1,886 staged rows, the D365 ancestor of this register —
 *     has NO barcode column at all, and its `name` is a sentence ("Zomia wants a
 *     cutting"), not a number: 0 of 1,886 are pure digits. Nothing is inherited
 *     from D365 and nothing there can collide.
 *   - The one recorded Atelier barcode shape is the demo register's
 *     `ATL-0049-217` (six values in src/seed/data/atelier.js: 066, 091, 118,
 *     150, 203, 217), corroborated by
 *     _bmad-output/planning-artifacts/research-sample-scanner.md — "an internal,
 *     Atelier-issued code, not a supplier EAN". So the hand-typed corpus is
 *     `ATL-` + four digits + `-` + three digits.
 *
 * A GENERATED VALUE THEREFORE CANNOT COLLIDE WITH A HAND-TYPED ONE BY
 * CONSTRUCTION, not by luck: the middle segment of a minted tag is the literal
 * `S` and the middle segment of every hand-typed tag is four digits, so the two
 * namespaces are disjoint whatever either side does next. `ATL-` is kept so a
 * printed tag still reads as Atelier's; `S` says "the server chose this one".
 * Six fixed digits mean no re-padding half way through the series, and because
 * the register's default read is `ORDER BY s.barcode ASC`, fixed width also
 * makes lexical order chronological order.
 *
 * START AT 1000, NOT 1. Every number in evidence is three digits and the highest
 * is 217. Starting at 1 would run the generated series straight through the
 * office's own numbering, so the first year of minted tags would read as
 * plausible hand-typed ones even to a person holding them. 1000 is above every
 * observed value AND one digit wider than all of them, so the two number lines
 * never overlap even if someone reads a tag with the `ATL-`/`S` context stripped
 * off. It buys distinguishability and costs nothing: a sequence has no upper
 * bound worth worrying about here.
 *
 * The generator does NOT make a collision impossible in general, and it must not
 * pretend to. If the sequence is ever moved behind the corpus (a restore, a
 * `setval`, a tag typed into the `ATL-S-` space by hand), a minted barcode can
 * still hit `samples_barcode_key`. The correct answer is the SAME 409 a typed
 * duplicate gets — not a retry loop, which would paper over the real fault and
 * spin under contention. test/samples-barcodes.test.js drives that path
 * deliberately.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.createSequence('samples_barcode_seq', { start: 1000 })
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropSequence('samples_barcode_seq')
}
