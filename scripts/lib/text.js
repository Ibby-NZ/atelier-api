/**
 * The encoding sniff and the CSV reader now live in `src/lib/csv-text.js`, so
 * the API can read a staff-saved spreadsheet with the same code that reads the
 * supplier drops. This file stays as the converters' import path — `scripts/`
 * already imports from `src/` and back (same package, plain relative specifier,
 * no bundler), and moving the specifier in every caller would have made a
 * behaviour-free move look like a change.
 */

export { decodeText, csvRows } from '../../src/lib/csv-text.js'
