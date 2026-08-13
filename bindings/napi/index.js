'use strict';

/**
 * Loader for the BrainDump native addon.
 *
 * Resolves build/Release/braindump.node (falling back to a Debug build) and
 * re-exports the BrainDumpCoreAddon surface declared in shared/types/addon.ts.
 * Every failure mode reports what to run next — a missing or stale .node file
 * is the single most common first-run problem.
 */

const { existsSync } = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ADDON_FILENAME = 'braindump.node';
const CANDIDATE_PATHS = [
  path.join(REPO_ROOT, 'build', 'Release', ADDON_FILENAME),
  path.join(REPO_ROOT, 'build', 'Debug', ADDON_FILENAME),
];
const REQUIRED_EXPORTS = ['createGraph', 'graphFromJSON', 'version', 'schemaVersion'];

const BUILD_HINT =
  "Run 'npm run build:native' to compile it. " +
  "Inside Electron, follow that with 'npm run rebuild:electron' so the addon " +
  "matches Electron's ABI.";

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

function resolveAddonPath() {
  const found = CANDIDATE_PATHS.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      `BrainDump native addon not found. Looked in:\n  ${CANDIDATE_PATHS.join('\n  ')}\n${BUILD_HINT}`,
    );
  }
  return found;
}

function requireAddon(addonPath) {
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return require(addonPath);
  } catch (error) {
    throw new Error(
      `BrainDump native addon at ${addonPath} failed to load: ${describe(error)}\n${BUILD_HINT}`,
    );
  }
}

function assertComplete(addon, addonPath) {
  const missing = REQUIRED_EXPORTS.filter((name) => typeof addon[name] !== 'function');
  if (missing.length > 0) {
    throw new Error(
      `BrainDump native addon at ${addonPath} is stale — missing: ${missing.join(', ')}.\n${BUILD_HINT}`,
    );
  }
  return addon;
}

function loadAddon() {
  const addonPath = resolveAddonPath();
  return assertComplete(requireAddon(addonPath), addonPath);
}

const addon = loadAddon();

module.exports = {
  createGraph: addon.createGraph,
  graphFromJSON: addon.graphFromJSON,
  version: addon.version,
  schemaVersion: addon.schemaVersion,
};
