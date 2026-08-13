#!/usr/bin/env node
/**
 * Generates resources/knowledge/index.json.
 *
 *   node scripts/build-knowledge-index.mjs [--check]
 *
 * Walks the 45 bundled corpus files, splits every sector module at its
 * `## N. Section Title` boundaries, and records exact BYTE ranges so the Claude
 * bridge can slice a section out of a 60 KB file without reading the file into
 * memory or guessing at character offsets.
 *
 * The script is idempotent: when the derived sections are byte-identical to the
 * ones already on disk it keeps the existing `generatedAt` and leaves the file
 * alone, so re-running it never produces a spurious diff.
 *
 * It also verifies itself. After writing, it re-reads the index from disk and
 * re-slices every single section out of its source file, asserting the slice
 * starts with the heading the index claims and does not split a UTF-8 sequence.
 * A wrong offset here would silently feed the model corrupt context, so this is
 * not optional and a failure exits non-zero.
 *
 * `--check` verifies the committed index without rewriting it.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildIndexPayload } from './lib/corpus.mjs';
import { verifyIndex } from './lib/verify-index.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KNOWLEDGE_DIR = join(REPO_ROOT, 'resources', 'knowledge');
const INDEX_PATH = join(KNOWLEDGE_DIR, 'index.json');
const JSON_INDENT = 2;
const EXIT_FAILURE = 1;
const MAX_REPORTED_FAILURES = 10;

/**
 * @param {readonly import('./lib/types.mjs').PackSectionLike[]} sections
 * @returns {string}
 */
function fingerprint(sections) {
  return JSON.stringify(sections);
}

/**
 * @param {string} path
 * @returns {Promise<import('./lib/types.mjs').KnowledgeIndexLike | null>}
 */
async function readExistingIndex(path) {
  const raw = await readFile(path, 'utf8').catch(() => null);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // A corrupt index is not a reason to stop; it is a reason to rewrite it.
    return null;
  }
}

/**
 * @param {readonly import('./lib/types.mjs').PackSectionLike[]} sections
 */
function summarize(sections) {
  const byKind = new Map();
  const files = new Set();
  let bytes = 0;
  let tokens = 0;

  for (const section of sections) {
    byKind.set(section.kind, (byKind.get(section.kind) ?? 0) + 1);
    files.add(section.relPath);
    bytes += section.byteEnd - section.byteStart;
    tokens += section.approxTokens;
  }

  return { byKind, fileCount: files.size, bytes, tokens };
}

/**
 * @param {number} value
 * @returns {string}
 */
function group(value) {
  return value.toLocaleString('en-US');
}

/**
 * @param {import('./lib/types.mjs').KnowledgeIndexLike} index
 * @param {import('./lib/verify-index.mjs').VerificationReport} report
 * @param {string} writeState
 */
function printReport(index, report, writeState) {
  const stats = summarize(index.sections);
  const kinds = [...stats.byKind]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([kind, count]) => `${kind} ${count}`)
    .join(' · ');

  process.stdout.write(
    [
      'BrainDump knowledge index',
      `  corpus     ${relative(REPO_ROOT, KNOWLEDGE_DIR)}`,
      `  files      ${index.fileCount} indexed (${stats.fileCount} contributed sections)`,
      `  sections   ${group(index.sections.length)}  (${kinds})`,
      `  bytes      ${group(stats.bytes)} mapped by byte range`,
      `  tokens     ~${group(stats.tokens)} total · budget ${group(12_000)} per invocation`,
      `  verified   ${report.checked - report.failures.length}/${report.checked} slices re-read from disk`,
      `  generated  ${index.generatedAt}`,
      `  output     ${relative(REPO_ROOT, INDEX_PATH)} (${writeState})`,
      '',
    ].join('\n'),
  );
}

/**
 * @param {import('./lib/verify-index.mjs').VerificationReport} report
 * @param {string} stage
 */
function printFailures(report, stage) {
  process.stderr.write(`\nVerification failed ${stage}: ${report.failures.length} problem(s)\n`);
  for (const failure of report.failures.slice(0, MAX_REPORTED_FAILURES)) {
    process.stderr.write(`  ${failure.id}: ${failure.reason}\n`);
  }
  if (report.failures.length > MAX_REPORTED_FAILURES) {
    process.stderr.write(`  ... ${report.failures.length - MAX_REPORTED_FAILURES} more\n`);
  }
}

async function main() {
  const isCheckOnly = process.argv.includes('--check');

  const existing = await readExistingIndex(INDEX_PATH);

  if (isCheckOnly) {
    if (!existing) {
      process.stderr.write(`No index at ${INDEX_PATH}. Run without --check first.\n`);
      process.exitCode = EXIT_FAILURE;
      return;
    }
    const report = await verifyIndex(KNOWLEDGE_DIR, existing);
    if (report.failures.length > 0) {
      printFailures(report, 'on the committed index');
      process.exitCode = EXIT_FAILURE;
      return;
    }
    printReport(existing, report, 'unchanged (--check)');
    return;
  }

  const payload = await buildIndexPayload(KNOWLEDGE_DIR);

  const preWrite = await verifyIndex(KNOWLEDGE_DIR, payload);
  if (preWrite.failures.length > 0) {
    printFailures(preWrite, 'before writing — nothing was written');
    process.exitCode = EXIT_FAILURE;
    return;
  }

  const isUnchanged =
    existing !== null &&
    existing.fileCount === payload.fileCount &&
    fingerprint(existing.sections ?? []) === fingerprint(payload.sections);

  const index = {
    generatedAt: isUnchanged ? existing.generatedAt : new Date().toISOString(),
    fileCount: payload.fileCount,
    sections: payload.sections,
  };

  if (!isUnchanged) {
    await writeFile(INDEX_PATH, `${JSON.stringify(index, null, JSON_INDENT)}\n`, 'utf8');
  }

  // Re-read from disk, not from memory. The point is to prove what was written.
  const written = await readExistingIndex(INDEX_PATH);
  if (!written) {
    process.stderr.write(`Index could not be re-read from ${INDEX_PATH}\n`);
    process.exitCode = EXIT_FAILURE;
    return;
  }

  const postWrite = await verifyIndex(KNOWLEDGE_DIR, written);
  if (postWrite.failures.length > 0) {
    printFailures(postWrite, 'after writing');
    process.exitCode = EXIT_FAILURE;
    return;
  }

  printReport(written, postWrite, isUnchanged ? 'unchanged' : 'rewritten');
}

main().catch((error) => {
  process.stderr.write(`build-knowledge-index failed: ${error?.stack ?? error}\n`);
  process.exitCode = EXIT_FAILURE;
});
