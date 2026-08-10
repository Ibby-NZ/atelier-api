/**
 * de Le Cuona — a PDF, and the one drop in this corpus with no extraction path.
 *
 * A declared refusal, not an unknown file: the converter reports it and carries
 * on, where an unmapped filename fails the run. The distinction matters because
 * nobody has to re-discover this every time the drop folder is read — and if a
 * spreadsheet ever arrives, the entry is where the adapter goes.
 *
 * There is no PDF reader in this repo and adding one is a dependency, which
 * `scripts/lib/` does not take (node_modules is shared across every worktree on
 * this machine). The price list already carries 139 de Le Cuona rows from the
 * pricing pipeline, so the rates are not lost with the colourways.
 */
export const DE_LE_CUONA = Object.freeze({
  prefix: 'de Le Cuona',
  unsupported: 'PDF — no worksheet to read, and no PDF reader here without a dependency; '
    + 'ask the supplier for the spreadsheet this was printed from',
})
