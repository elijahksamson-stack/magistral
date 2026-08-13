/**
 * JSDoc mirrors of the index contract in shared/types/claude.ts.
 *
 * The build scripts are plain ESM, so they cannot import the TypeScript
 * contract. These typedefs exist to keep editors honest and to make the shape
 * greppable from one place. shared/types/claude.ts remains the source of truth;
 * scripts/index-budget.test.mjs reads PACK_TOKEN_BUDGET straight out of it
 * rather than mirroring the value here.
 */

/**
 * @typedef {'mindset' | 'sector' | 'macroman'} PackKindLike
 */

/**
 * @typedef {object} PackSectionLike
 * @property {string} id
 * @property {PackKindLike} kind
 * @property {string} [sector]
 * @property {string} module
 * @property {string} section
 * @property {string} relPath
 * @property {number} byteStart
 * @property {number} byteEnd
 * @property {number} approxTokens
 * @property {string[]} keywords
 */

/**
 * @typedef {object} KnowledgeIndexLike
 * @property {string} generatedAt
 * @property {number} fileCount
 * @property {PackSectionLike[]} sections
 */

export {};
