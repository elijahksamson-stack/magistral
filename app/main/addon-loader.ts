/**
 * Resolves and loads the compiled N-API addon (`build/Release/braindump.node`).
 *
 * Failure here must never be fatal: the window still opens and the renderer
 * gets an actionable message. Candidate paths are supplied by the caller so
 * this file stays free of any electron import and therefore unit-testable.
 */

import { closeSync, existsSync, openSync, readSync } from 'node:fs';
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

// ---------------------------------------------------------------------------
// Which platform was this binary actually built for?
//
// Magistral 0.1.2 and 0.2.0 shipped a Windows installer containing a macOS
// binary, and the message users got was the OS loader's ("is not a valid Win32
// application") followed by our advice to run `npm run build:native` — npm
// instructions, to someone who downloaded an installer and has no repo, no
// Node and no compiler. It read as though they had done something wrong.
//
// Reading the file's own magic bytes says exactly what is wrong without parsing
// per-OS loader wording, and lets the message be honest: this download is
// broken, it is not the reader's fault, and nothing they do locally will fix it.
//
// The signature table is duplicated in scripts/verify-native-binary.cjs, which
// runs in plain node during packaging and cannot import compiled TypeScript.
// Six lines in two runtimes beats a fragile build-time dependency on `out/`.
// ---------------------------------------------------------------------------

type BinaryPlatform = 'win32' | 'darwin' | 'linux' | 'unknown';

const SIGNATURES: readonly {
  readonly platform: BinaryPlatform;
  readonly bytes: readonly number[];
}[] = [
  { platform: 'win32', bytes: [0x4d, 0x5a] }, // "MZ"
  { platform: 'darwin', bytes: [0xcf, 0xfa, 0xed, 0xfe] },
  { platform: 'darwin', bytes: [0xce, 0xfa, 0xed, 0xfe] },
  { platform: 'darwin', bytes: [0xca, 0xfe, 0xba, 0xbe] }, // universal
  { platform: 'darwin', bytes: [0xbe, 0xba, 0xfe, 0xca] },
  { platform: 'linux', bytes: [0x7f, 0x45, 0x4c, 0x46] },
];

const PLATFORM_NAMES: Record<string, string> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
};

function platformName(platform: string): string {
  return PLATFORM_NAMES[platform] ?? platform;
}

/** The OS a compiled file targets, read from its first bytes. */
export function binaryPlatform(filePath: string): BinaryPlatform {
  let handle: number;
  try {
    handle = openSync(filePath, 'r');
  } catch {
    return 'unknown';
  }

  try {
    const header = Buffer.alloc(4);
    readSync(handle, header, 0, 4, 0);
    const match = SIGNATURES.find((signature) =>
      signature.bytes.every((byte, index) => header[index] === byte),
    );
    return match?.platform ?? 'unknown';
  } catch {
    return 'unknown';
  } finally {
    closeSync(handle);
  }
}

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

    /*
     * The wrong-operating-system case is not a build problem the reader can
     * act on — it is a broken download. Saying so plainly, and NOT handing
     * them npm commands, is the difference between "this app is broken" and
     * "I did something wrong".
     */
    const builtFor = binaryPlatform(found);
    if (builtFor !== 'unknown' && builtFor !== process.platform) {
      return {
        ok: false,
        reason:
          `This copy of Magistral will not run on ${platformName(process.platform)}. ` +
          `Its native core was built for ${platformName(builtFor)}, so ` +
          `${platformName(process.platform)} cannot load it.\n\n` +
          'Nothing is wrong with your machine and there is nothing to fix here — ' +
          `the download itself was packaged incorrectly. Please get the ` +
          `${platformName(process.platform)} build of Magistral and install that instead.`,
      };
    }

    // Same core, right platform, wrong Node ABI: a real rebuild case, and one
    // only a developer can be in, since a packaged app ships its own Electron.
    if (/NODE_MODULE_VERSION|different Node\.js version/i.test(errorMessage(error))) {
      return {
        ok: false,
        reason:
          `The Magistral native core at ${found} was built against a different Node ABI ` +
          `than this Electron runtime. ${BUILD_HINT}`,
      };
    }

    return {
      ok: false,
      reason: `The Magistral native core at ${found} failed to load: ${errorMessage(error)}.`,
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
