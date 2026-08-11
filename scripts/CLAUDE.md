# atelier-api — converters

Extracted from the root CLAUDE.md (root conventions still apply). Loaded automatically when working in this directory.

The converter/import pipelines that live half in this directory are documented where the data lands:

- Price-list converter + pricing template v1/v2 + colour-file converters and adapters: `src/seed/CLAUDE.md`
- D365 export converter (`convert-d365-exports.js`): `src/legacy/CLAUDE.md`

Read the relevant one BEFORE touching `scripts/lib/` or any `convert-*.js` — the committed `src/seed/data/price-lists.json` is byte-pinned to these converters.
