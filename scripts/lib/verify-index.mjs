/**
 * Self-verification for the generated knowledge index.
 *
 * A byte range that is off by even one byte produces a slice that starts
 * mid-heading or mid-codepoint, and nothing downstream would notice — the model
 * would simply be handed corrupt context. So the builder re-opens every file
 * after writing and proves that each recorded range still slices back to the
 * exact heading the index claims it does.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { BYTES_PER_TOKEN, toPlatformPath } from './corpus.mjs';

/**
 * @typedef {object} VerificationFailure
 * @property {string} id
 * @property {string} reason
 */

/**
 * @typedef {object} VerificationReport
 * @property {number} checked
 * @property {number} bytesVerified
 * @property {VerificationFailure[]} failures
 */

/**
 * Re-read every section by its byte range and assert it still resolves to the
 * content the index claims.
 *
 * @param {string} knowledgeDir
 * @param {{ sections: readonly import('./types.mjs').PackSectionLike[] }} index
 * @returns {Promise<VerificationReport>}
 */
export async function verifyIndex(knowledgeDir, index) {
  const buffers = new Map();
  const failures = [];
  let bytesVerified = 0;

  for (const section of index.sections) {
    const buffer = await loadBuffer(buffers, knowledgeDir, section.relPath);
    if (!buffer) {
      failures.push({ id: section.id, reason: `unreadable file ${section.relPath}` });
      continue;
    }

    const failure = checkSection(section, buffer);
    if (failure) {
      failures.push(failure);
      continue;
    }
    bytesVerified += section.byteEnd - section.byteStart;
  }

  failures.push(...checkCoverage(index.sections));

  return { checked: index.sections.length, bytesVerified, failures };
}

/**
 * @param {Map<string, Buffer | null>} cache
 * @param {string} knowledgeDir
 * @param {string} relPath
 * @returns {Promise<Buffer | null>}
 */
async function loadBuffer(cache, knowledgeDir, relPath) {
  if (cache.has(relPath)) return cache.get(relPath) ?? null;
  const buffer = await readFile(join(knowledgeDir, toPlatformPath(relPath))).catch(() => null);
  cache.set(relPath, buffer);
  return buffer;
}

/**
 * @param {import('./types.mjs').PackSectionLike} section
 * @param {Buffer} buffer
 * @returns {VerificationFailure | null}
 */
function checkSection(section, buffer) {
  const fail = (reason) => ({ id: section.id, reason });

  const rangeFailure = checkRange(section, buffer, fail);
  if (rangeFailure) return rangeFailure;

  const slice = buffer.subarray(section.byteStart, section.byteEnd);
  const text = slice.toString('utf8');

  if (Buffer.byteLength(text, 'utf8') !== slice.length) {
    return fail('range splits a multi-byte UTF-8 sequence');
  }

  if (section.kind === 'sector') {
    const expected = `## ${section.section}`;
    const firstLine = text.split('\n', 1)[0].replace(/\r$/, '');
    if (firstLine !== expected) {
      return fail(`slice starts with "${firstLine}", expected "${expected}"`);
    }
  } else if (section.byteStart !== 0 || section.byteEnd !== buffer.length) {
    return fail(`${section.kind} sections must cover the whole file`);
  }

  const estimated = Math.ceil((section.byteEnd - section.byteStart) / BYTES_PER_TOKEN);
  if (section.approxTokens !== estimated) {
    return fail(`approxTokens ${section.approxTokens} does not match range (${estimated})`);
  }

  return null;
}

/**
 * @param {import('./types.mjs').PackSectionLike} section
 * @param {Buffer} buffer
 * @param {(reason: string) => VerificationFailure} fail
 * @returns {VerificationFailure | null}
 */
function checkRange(section, buffer, fail) {
  if (!Number.isInteger(section.byteStart) || !Number.isInteger(section.byteEnd)) {
    return fail('byte offsets must be integers');
  }
  if (section.byteStart < 0 || section.byteEnd > buffer.length) {
    return fail(
      `range ${section.byteStart}..${section.byteEnd} outside ${section.relPath}` +
        ` (${buffer.length} bytes)`,
    );
  }
  if (section.byteEnd <= section.byteStart) {
    return fail(`empty range ${section.byteStart}..${section.byteEnd}`);
  }
  return null;
}

/**
 * Sections of one file must tile it: contiguous, ordered, non-overlapping.
 *
 * @param {readonly import('./types.mjs').PackSectionLike[]} sections
 * @returns {VerificationFailure[]}
 */
function checkCoverage(sections) {
  const byFile = new Map();
  for (const section of sections) {
    const bucket = byFile.get(section.relPath) ?? [];
    bucket.push(section);
    byFile.set(section.relPath, bucket);
  }

  const failures = [];
  for (const [relPath, bucket] of byFile) {
    const ordered = [...bucket].sort((left, right) => left.byteStart - right.byteStart);
    for (let index = 1; index < ordered.length; index += 1) {
      if (ordered[index].byteStart !== ordered[index - 1].byteEnd) {
        failures.push({
          id: ordered[index].id,
          reason: `gap or overlap in ${relPath} at byte ${ordered[index].byteStart}`,
        });
      }
    }
  }
  return failures;
}
