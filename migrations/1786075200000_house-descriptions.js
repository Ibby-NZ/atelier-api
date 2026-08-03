/**
 * Fills in the eighteen houses that had no description: the fourteen
 * represented-only houses created by 1786060800000_client-house-roster, plus
 * Brochier, Trend, Vervain and Atelier's own entry — none of which the vendored
 * realCatalogue.js snapshot describes.
 *
 * A migration as well as a seed change, for the same reason the roster needed
 * one: a deployed database is not necessarily reseeded, and the represented-
 * only houses were inserted by the previous migration with a null story.
 * `src/seed/data/brand-stories.js` covers fresh seeds; this covers the rest.
 *
 * FILLS BLANKS ONLY — `WHERE story IS NULL OR btrim(story) = ''`. A description
 * staff wrote in the CRM between the roster migration and this one is left
 * alone. (Note that the seed itself does NOT honour that: `upsertBrands` writes
 * `story = EXCLUDED.story` unconditionally, so a CRM-edited story is already
 * lost on the next reseed. That is pre-existing behaviour for every house the
 * snapshot describes and is not changed here.)
 *
 * The text is inlined rather than imported from `src/seed/data/`: a migration
 * is a record of what ran, and one importing a file that later changes would
 * rewrite its own past. The two are expected to drift — the seed file is the
 * live source.
 *
 * Written from each house's own website (4 Aug 2026). A founding year appears
 * only where the house or a cited source confirms it, because the storefront's
 * `foundedYear()` parses "Founded YYYY" straight out of this text and renders
 * it as "est. YYYY" — a guessed date would surface as fact.
 *
 * Idempotent: re-running matches no rows, since every target is now non-null.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */

const BRAND_STORIES = [
  [
    'alpaka',
    'Estonian house of alpaca wool and silk home accessories — throws, cushions and rugs — cut to a Nordic minimalism and made to last a lifetime.',
  ],
  [
    'armani-casa',
    "Founded 2000, Giorgio Armani's interiors line: Milanese textiles and furnishings in the house's own restrained, tonal language.",
  ],
  [
    'atelier-textiles-nz',
    'Atelier’s own workroom — a boutique importer and distributor of over forty luxury furnishing houses, with trade showrooms in Auckland, Wellington and Christchurch.',
  ],
  [
    'brochier',
    'Italian house of jacquards, velvets, plains and prints for upholstery and curtaining, woven under Clerici Tessuto of Como.',
  ],
  [
    'filippo-uecher',
    "Milanese house of fabrics, sheers, throws, textile wallcoverings and rugs, drawn from the designer's own travels and heritage.",
  ],
  [
    'fine',
    'Austrian house from Mils in the Tyrol, weaving upholstery and decorative cloth in a contemporary country style shaped by its alpine heritage.',
  ],
  [
    'garrett-leather',
    'Founded 1988 in Buffalo, New York — upholstery leather for interiors and aviation, from a family house that began in its founder’s attic.',
  ],
  [
    'hamam',
    'Turkish house of bath and bed linen — pestemals, towels, robes and sheeting — woven from Turkish cotton in the tradition of the hamam.',
  ],
  [
    'jean-monro',
    'Founded 1981, an English house reprinting 18th, 19th and early 20th century documents and hand blocks recovered from great English houses.',
  ],
  [
    'le-crin',
    'Founded 1787 in the Sarthe, the last workshop weaving horsehair by hand — a few metres a day, under the Entreprise du Patrimoine Vivant label.',
  ],
  [
    'madeaux',
    'Richard Smith’s London house of woven, printed and embroidered cloth, known for its handmade grasscloth wallcoverings and bespoke colourways.',
  ],
  [
    'maria-flora',
    'Italian spinner, weaver and editor of outdoor cloth, drawing its botanicals from 1920s glass-plate plant negatives.',
  ],
  [
    'sette',
    'Founded 2010, a Spanish house pairing the simplicity of natural cloth with a refined, faintly rustic hand.',
  ],
  [
    'the-vale-london',
    'London house of textiles and wallcoverings, every design beginning as hand-rendered artwork drawn from London interiors and travel.',
  ],
  [
    'timney-fowler',
    'Founded 1980 in London by Sue Timney and Grahame Fowler, celebrated for bold graphic black-and-white print work across cloth, paper and ceramics.',
  ],
  [
    'trend',
    'Broad-range decorative and performance cloth with an emphasis on cleanable finishes (Fabricut family).',
  ],
  [
    'verel-de-belval',
    'Lyon silk house holding one of the world’s largest weaving archives, working traditional silk mastery under the Entreprise du Patrimoine Vivant label.',
  ],
  [
    'vervain',
    'Quintessential silks and wallcoverings, worked with designers including Barry Dixon and Denise McGaha (Fabricut family).',
  ],
]

export const up = async (pgm) => {
  for (const [slug, story] of BRAND_STORIES) {
    await pgm.db.query(
      `UPDATE brands SET story = $2
        WHERE slug = $1 AND (story IS NULL OR btrim(story) = '')`,
      [slug, story]
    )
  }
}

/**
 * Clears only the descriptions this migration wrote, and only where the text is
 * still exactly what it wrote — a staff edit made afterwards is left in place.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = async (pgm) => {
  for (const [slug, story] of BRAND_STORIES) {
    await pgm.db.query(`UPDATE brands SET story = NULL WHERE slug = $1 AND story = $2`, [
      slug,
      story,
    ])
  }
}
