/**
 * Keyword mining for corpus sections.
 *
 * Keywords are the routing surface: they decide which slices of the corpus a
 * request pulls in. They are derived, never hand-written, so that adding a
 * module to resources/knowledge/ needs no code change.
 *
 * Signal is weighted by where a term appears. A term in the section heading is
 * what the section is about; a term in a sub-heading names a mechanism; a bolded
 * term is what the author chose to emphasise; body prose is background.
 */

import { parseHeading } from './markdown-lines.mjs';

export const KEYWORD_LIMIT = 16;

const SUBHEADING_WEIGHT = 5;
const BOLD_WEIGHT = 3;
const BODY_WEIGHT = 1;
const MIN_TERM_LENGTH = 3;
const MIN_PLURAL_FOLD_LENGTH = 5;

const TERM_PATTERN = /[a-z][a-z0-9-]*/g;
const BOLD_PATTERN = /\*\*([^*]+)\*\*/g;

/**
 * Words that carry no routing signal. Generic English plus the connective
 * vocabulary that saturates every module in this corpus ("value", "market" and
 * friends stay in — they do discriminate between sections).
 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'had',
  'her', 'was', 'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his', 'how',
  'its', 'may', 'new', 'now', 'old', 'see', 'two', 'who', 'boy', 'did', 'she',
  'use', 'way', 'been', 'call', 'come', 'each', 'from', 'have', 'here', 'into',
  'just', 'like', 'made', 'make', 'many', 'more', 'most', 'much', 'must',
  'need', 'only', 'other', 'over', 'said', 'same', 'some', 'such', 'take',
  'than', 'that', 'them', 'then', 'they', 'this', 'time', 'very', 'were',
  'what', 'when', 'with', 'about', 'after', 'again', 'against', 'because',
  'before', 'being', 'below', 'between', 'both', 'cannot', 'could', 'does',
  'doing', 'down', 'during', 'each', 'few', 'further', 'having', 'itself',
  'less', 'once', 'onto', 'ought', 'ourselves', 'should', 'still', 'their',
  'there', 'these', 'those', 'through', 'under', 'until', 'upon', 'using',
  'where', 'which', 'while', 'whose', 'will', 'without', 'would', 'your',
  'also', 'across', 'along', 'among', 'another', 'anything', 'become',
  'becomes', 'often', 'rather', 'therefore', 'thus', 'whether', 'within',
  'versus', 'via', 'per', 'etc', 'yet', 'even', 'ever', 'every', 'given',
  'goes', 'gone', 'good', 'great', 'high', 'kind', 'know', 'large', 'last',
  'later', 'least', 'left', 'long', 'look', 'lower', 'main', 'mean', 'means',
  'might', 'next', 'note', 'part', 'place', 'point', 'real', 'right', 'says',
  'seen', 'sets', 'show', 'shows', 'side', 'small', 'sort', 'thing', 'things',
  'think', 'turn', 'used', 'uses', 'want', 'well', 'went', 'whole', 'work',
  'works', 'able', 'above', 'add', 'adds', 'always', 'apply', 'applies',
  'basis', 'case', 'cases', 'change', 'changes', 'common', 'compare',
  'compared', 'define', 'defined', 'differ', 'different', 'either', 'else',
  'end', 'ends', 'form', 'forms', 'full', 'general', 'give', 'gives', 'group',
  'help', 'hold', 'holds', 'keep', 'level', 'levels', 'list', 'move', 'moves',
  'name', 'names', 'number', 'numbers', 'often', 'order', 'others', 'per',
  'read', 'set', 'several', 'similar', 'single', 'specific', 'state',
  'stated', 'step', 'steps', 'table', 'term', 'terms', 'top', 'total',
  'toward', 'true', 'type', 'types', 'under', 'until', 'weak', 'whereas',
  'why', 'wide', 'year', 'years',
  // URL and citation debris — every sector section ends in a "### Sources"
  // block, which would otherwise win on the sub-heading weight alone.
  'http', 'https', 'www', 'com', 'org', 'net', 'gov', 'edu', 'html', 'pdf',
  'url', 'source', 'sources', 'accessed', 'retrieved', 'link', 'links',
  // Frame vocabulary shared by all five mindset files, so it routes nothing.
  'already', 'answer', 'answers', 'deserve', 'deserves', 'done', 'matter',
  'matters', 'never', 'own', 'reveal', 'reveals', 'together', 'useful',
  'valuable',
]);

/**
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  const matches = text.toLowerCase().match(TERM_PATTERN);
  if (!matches) return [];
  return matches
    .map((term) => term.replace(/^-+|-+$/g, ''))
    .filter((term) => term.length >= MIN_TERM_LENGTH && !STOPWORDS.has(term));
}

/**
 * Fold "margins" into "margin" when both occur, so one concept does not consume
 * two of the limited keyword slots.
 *
 * @param {Map<string, number>} scores
 * @returns {Map<string, number>}
 */
function foldPlurals(scores) {
  const folded = new Map();
  for (const [term, score] of scores) {
    const stem = term.endsWith('s') && term.length >= MIN_PLURAL_FOLD_LENGTH
      ? term.slice(0, -1)
      : term;
    const key = stem !== term && scores.has(stem) ? stem : term;
    folded.set(key, (folded.get(key) ?? 0) + score);
  }
  return folded;
}

/**
 * @param {readonly string[]} bodyLines Section body, heading line excluded.
 * @returns {Map<string, number>}
 */
function scoreBody(bodyLines) {
  const scores = new Map();

  const bump = (text, weight) => {
    for (const term of tokenize(text)) {
      scores.set(term, (scores.get(term) ?? 0) + weight);
    }
  };

  for (const line of bodyLines) {
    const heading = parseHeading(line);
    bump(line, heading ? SUBHEADING_WEIGHT : BODY_WEIGHT);

    for (const match of line.matchAll(BOLD_PATTERN)) {
      bump(match[1], BOLD_WEIGHT);
    }
  }

  return foldPlurals(scores);
}

/**
 * Terms that name the section itself. These always lead the keyword list —
 * the heading is the single most reliable statement of what a slice contains.
 *
 * @param {{ title: string, module: string, sector?: string }} labels
 * @returns {string[]}
 */
function anchorTerms(labels) {
  const ordered = [labels.title, labels.module, labels.sector ?? ''];
  const seen = new Set();
  const anchors = [];

  for (const label of ordered) {
    for (const term of tokenize(label)) {
      if (seen.has(term)) continue;
      seen.add(term);
      anchors.push(term);
    }
  }

  return anchors;
}

/**
 * Derive the routing keywords for one section.
 *
 * @param {object} input
 * @param {string} input.title
 * @param {string} input.module
 * @param {string} [input.sector]
 * @param {readonly string[]} input.bodyLines
 * @param {number} [input.limit]
 * @returns {string[]}
 */
export function mineKeywords({ title, module, sector, bodyLines, limit = KEYWORD_LIMIT }) {
  const anchors = anchorTerms({ title, module, sector }).slice(0, limit);
  const taken = new Set(anchors);
  const remaining = limit - anchors.length;
  if (remaining <= 0) return anchors;

  const ranked = [...scoreBody(bodyLines)]
    .filter(([term]) => !taken.has(term))
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, remaining)
    .map(([term]) => term);

  return [...anchors, ...ranked];
}
