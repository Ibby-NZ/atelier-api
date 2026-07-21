/**
 * URL-safe slug from a display name. Strips diacritics (Métaphores → metaphores),
 * collapses every non-alphanumeric run to a single hyphen.
 */
export const slugify = (text) => {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error(`slugify requires a non-empty string, got: ${JSON.stringify(text)}`)
  }
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
