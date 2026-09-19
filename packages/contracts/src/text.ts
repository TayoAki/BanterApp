/**
 * Text helpers shared by the semantic validators.
 *
 * "Exact" evidence matching means the quote is a substring of the confirmed
 * transcript. Models frequently swap typographic quotes/dashes or collapse
 * whitespace, so a second pass compares both sides after a conservative
 * typographic normalization. The normalization never changes words, so a
 * hallucinated quote still fails.
 */

export function normalizeTypography(input: string): string {
  return input
    .normalize('NFC')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/\s+/g, ' ')
    .trim();
}

export function foldForMatch(input: string): string {
  return normalizeTypography(input).toLowerCase();
}

export type SubstringMatch = { found: true; normalized: boolean } | { found: false };

/** Checks `quote` occurs in `haystack`, exactly first, then typographically normalized. */
export function findExactOrNormalized(haystack: string, quote: string): SubstringMatch {
  if (quote.length === 0) return { found: false };
  if (haystack.includes(quote)) return { found: true, normalized: false };
  const h = normalizeTypography(haystack);
  const q = normalizeTypography(quote);
  if (q.length === 0) return { found: false };
  if (h.includes(q)) return { found: true, normalized: true };
  return { found: false };
}

export function isBlank(input: string | null | undefined): boolean {
  return input === null || input === undefined || input.trim().length === 0;
}

/** Unicode-aware character count (code points, not UTF-16 units). */
export function codePointLength(input: string): number {
  let n = 0;
  for (const _ of input) n += 1;
  return n;
}

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;

export function words(input: string): string[] {
  return normalizeTypography(input).match(WORD_RE) ?? [];
}

export function lowerWords(input: string): string[] {
  return words(input).map((w) => w.toLowerCase().replace(/^'+|'+$/g, ''));
}
