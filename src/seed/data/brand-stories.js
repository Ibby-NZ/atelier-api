// House descriptions, keyed by brand slug — SEED-OWNED, not a vendored
// atelier-app snapshot (a re-copy of ./data must not overwrite this file).
// Rendered by the storefront as the brand page's lede and, where a founding
// year is stated, as the "est. YYYY" meta beside the house name.
//
// FILLS BLANKS ONLY. `toBrandRow()` reads `realCatalogue.js`'s own story first
// and falls back here, so a house the snapshot describes is never overridden by
// this file — these are the seventeen that had no description at all (the
// fourteen represented-only houses, plus Trend, Vervain and Atelier's own
// entry, none of which the snapshot covers).
//
// Written from each house's own website, 4 Aug 2026. Register follows the
// snapshot's: one factual sentence, NZ spelling, no marketing adjectives that
// the house does not itself claim, and a parent group named in parentheses the
// way Stroheim and S. Harris already do it.
//
// A year is stated ONLY where the house or a cited source confirms it —
// `foundedYear()` in the storefront parses "Founded YYYY" / "Established YYYY"
// straight out of this text and puts it on the brand page and the houses index,
// so a guessed date would surface as fact. Houses whose founding year could not
// be confirmed (Filippo Uecher, Fine, Hamam, Madeaux, Maria Flora, Verel de
// Belval, Alpaka) state none and show their country alone, which is what the
// design degrades to.
//
// Sahco, Le Crin, Timney Fowler, The Vale London and Brochier left the roster
// on 2 Sep 2026 (Userback 8287607) and their copy went with them.

export const BRAND_STORIES = Object.freeze({
  alpaka:
    'Estonian house of alpaca wool and silk home accessories — throws, cushions and rugs — cut to a Nordic minimalism and made to last a lifetime.',
  'armani-casa':
    "Founded 2000, Giorgio Armani's interiors line: Milanese textiles and furnishings in the house's own restrained, tonal language.",
  'atelier-textiles-nz':
    'Atelier’s own workroom — a boutique importer and distributor of over forty luxury furnishing houses, with trade showrooms in Auckland, Wellington and Christchurch.',
  'filippo-uecher':
    "Milanese house of fabrics, sheers, throws, textile wallcoverings and rugs, drawn from the designer's own travels and heritage.",
  fine: 'Austrian house from Mils in the Tyrol, weaving upholstery and decorative cloth in a contemporary country style shaped by its alpine heritage.',
  'garrett-leather':
    'Founded 1988 in Buffalo, New York — upholstery leather for interiors and aviation, from a family house that began in its founder’s attic.',
  hamam:
    'Turkish house of bath and bed linen — pestemals, towels, robes and sheeting — woven from Turkish cotton in the tradition of the hamam.',
  'jean-monro':
    'Founded 1981, an English house reprinting 18th, 19th and early 20th century documents and hand blocks recovered from great English houses.',
  madeaux:
    'Richard Smith’s London house of woven, printed and embroidered cloth, known for its handmade grasscloth wallcoverings and bespoke colourways.',
  'maria-flora':
    'Italian spinner, weaver and editor of outdoor cloth, drawing its botanicals from 1920s glass-plate plant negatives.',
  sette:
    'Founded 2010, a Spanish house pairing the simplicity of natural cloth with a refined, faintly rustic hand.',
  trend:
    'Broad-range decorative and performance cloth with an emphasis on cleanable finishes (Fabricut family).',
  'verel-de-belval':
    'Lyon silk house holding one of the world’s largest weaving archives, working traditional silk mastery under the Entreprise du Patrimoine Vivant label.',
  vervain:
    'Quintessential silks and wallcoverings, worked with designers including Barry Dixon and Denise McGaha (Fabricut family).',

  // --- Added 13 Aug 2026, with the three houses the roster omitted --------
  // Written from the client's own brand copy rather than from the houses'
  // websites; the years are the ones that copy states.
  'fox-linton':
    'British house founded by designer Mary Fox Linton, weaving indoor and outdoor cloth and throws in wool, linen, silk and velvet at specialist mills across Britain and Europe.',
  houles:
    'Founded 1928 in Paris, a fourth-generation maison of passementerie — tassels, fringes, cords, braids and tiebacks — and of curtain poles, finials and fittings.',
  'jannelli-volpi':
    'Founded 1961, a family-run Milanese wallpaper house, maker of the licensed Armani/Casa and Missoni wallcovering collections.',
})
