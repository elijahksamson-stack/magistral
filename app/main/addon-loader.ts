/**
 * Resolves and loads the compiled N-API addon (`build/Release/braindump.node`).
 *
 * Failure here must never be fatal: the window still opens and the renderer
 * gets an actionable message. Candidate paths are supplied by the caller so
 * this file stays free of any electron import and therefore unit-testable.
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { SCHEMA_VERSION } from '../../shared/types/graph';
import type { BrainDumpCoreAddon } from '../../shared/types/addon';
import { createLogger, errorMessage } from './logger';

const log = createLogger('addon');

/** `createRequire` needs a referrer; absolute paths make it irrelevant. */
const nativeRequire = createRequire(process.execPath);

export type AddonLoadResult =
  | { readonly ok: true; readonly addon: BrainDumpCoreAddon; readonly path: string }
  | { readonly ok: false; readonly reason: string };

const BUILD_HINT = 'Run `npm run build:native && npm run rebuild:electron`, then restart Magistral.';

function isCoreAddon(value: unknown): value is BrainDumpCoreAddon {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<BrainDumpCoreAddon>;
  return (
    typeof candidate.createGraph === 'function' &&
    typeof candidate.graphFromJSON === 'function' &&
    typeof candidate.version === 'function' &&
    typeof candidate.schemaVersion === 'function'
  );
}

export function loadCoreAddon(candidatePaths: readonly string[]): AddonLoadResult {
  const found = candidatePaths.find((candidate) => existsSync(candidate));
  if (!found) {
    return {
      ok: false,
      reason:
        `The Magistral native core was not found. Looked in:\n  ${candidatePaths.join('\n  ')}\n` +
        BUILD_HINT,
    };
  }

  let loaded: unknown;
  try {
    loaded = nativeRequire(found);
  } catch (error: unknown) {
    log.error('native addon failed to load', error);
    return {
      ok: false,
      reason:
        `The Magistral native core at ${found} failed to load: ${errorMessage(error)}. ` +
        `This usually means it was built against a different Node ABI. ${BUILD_HINT}`,
    };
  }

  if (!isCoreAddon(loaded)) {
    return {
      ok: false,
      reason: `${found} loaded but does not expose the expected native core surface. ${BUILD_HINT}`,
    };
  }

  const coreSchema = safeSchemaVersion(loaded);
  if (coreSchema !== null && coreSchema !== SCHEMA_VERSION) {
    return {
      ok: false,
      reason:
        `Native core speaks graph schema v${coreSchema} but this build expects ` +
        `v${SCHEMA_VERSION}. Rebuild the core: ${BUILD_HINT}`,
    };
  }

  log.info('native core loaded', { path: found, version: safeVersion(loaded) });
  return { ok: true, addon: loaded, path: found };
}

function safeSchemaVersion(addon: BrainDumpCoreAddon): number | null {
  try {
    return addon.schemaVersion();
  } catch (error: unknown) {
    log.warn('core schemaVersion() threw', error);
    return null;
  }
}

function safeVersion(addon: BrainDumpCoreAddon): string {
  try {
    return addon.version();
  } catch {
    return 'unknown';
  }
}
