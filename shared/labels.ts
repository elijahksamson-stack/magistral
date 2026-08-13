/**
 * Label normalization — CONTRACT.
 *
 * Two labels sharing a normalized form ARE the same node. This is the dedup
 * key, which makes it one of the few pieces of logic that must agree byte for
 * byte across the C++ core, the main process and the renderer.
 *
 * It lives here because it was previously written twice and the two copies
 * disagreed: one stripped punctuation everywhere, the core only at the ends.
 * Under that copy "S&P 500" and "S P 500" were the same concept, so a proposal
 * to create the second while the first existed was refused as a duplicate of a
 * node the core would have considered entirely different.
 *
 * Mirrors `braindump::normalizeLabel` in core/src/types.cpp.
 */

/** ASCII whitespace only — the core does not treat U+00A0 as a separator. */
const ASCII_WHITESPACE_RUN = /[ \t\n\r\v\f]+/;
const ASCII_UPPERCASE = /[A-Z]/g;

/**
 * ASCII whitespace plus ASCII punctuation — the core's `isStrippable`. Bytes
 * >= 0x80 are deliberately absent: the core passes them through untouched, so
 * "«Moat»" normalizes with its guillemets intact on both sides of the bridge.
 */
const ASCII_TRIVIA_CLASS = ' \\t\\n\\r\\v\\f!-/:-@[-`{-~';
const LEADING_ASCII_TRIVIA = new RegExp(`^[${ASCII_TRIVIA_CLASS}]+`);
const TRAILING_ASCII_TRIVIA = new RegExp(`[${ASCII_TRIVIA_CLASS}]+$`);

/** ASCII-only case folding: "ÜBER" -> "Über", exactly as the core folds it. */
function collapseAndLowerAscii(label: string): string {
  return label
    .split(ASCII_WHITESPACE_RUN)
    .filter((part) => part.length > 0)
    .join(' ')
    .replace(ASCII_UPPERCASE, (upper) => upper.toLowerCase());
}

/**
 * Lowercase, collapse internal whitespace, trim, strip surrounding punctuation.
 *
 *   "The Binding Constraint"  -> "the binding constraint"
 *   "  binding   constraint " -> "binding constraint"
 *   "Binding Constraint!"     -> "binding constraint"
 *   "S&P 500"                 -> "s&p 500"   (interior punctuation is KEPT)
 *
 * ASCII-only by contract — a Unicode-aware `toLowerCase()` here would compute a
 * different dedup key from the one the core stored, and every non-ASCII label
 * would stop resolving.
 */
export function normalizeLabel(label: string): string {
  const collapsed = collapseAndLowerAscii(label);
  const stripped = collapsed
    .replace(LEADING_ASCII_TRIVIA, '')
    .replace(TRAILING_ASCII_TRIVIA, '');

  // A label made entirely of punctuation keeps its collapsed form rather than
  // normalizing to "" — an empty dedup key would collide with every other one.
  return stripped.length > 0 ? stripped : collapsed;
}
