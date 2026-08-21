/**
 * Refuse to package a native core built for the wrong operating system.
 *
 * This exists because it happened. Magistral 0.1.2 and 0.2.0 shipped a Windows
 * installer containing a Mach-O binary — `@electron/rebuild` ran on a Mac, so
 * the only `braindump.node` available to copy in was a macOS one. The build was
 * green, the installer ran, and every Windows user who launched it got:
 *
 *   braindump.node is not a valid Win32 application
 *
 * node-gyp cannot cross-compile this addon: a Windows build has to be produced
 * ON Windows. Nothing in the source can fix a wrong binary, so the only durable
 * defence is to make the mistake unshippable. afterPack is the last point where
 * the packaged tree can still be inspected before it becomes an artifact
 * somebody downloads.
 *
 * CommonJS on purpose: electron-builder `require`s this file, and the project
 * declares no `"type": "module"`, so `.cjs` is unambiguous either way.
 */

const { readdirSync, openSync, readSync, closeSync, statSync } = require('node:fs');
const path = require('node:path');

/** First bytes that identify an executable format. */
const SIGNATURES = [
  { format: 'pe', platforms: ['win32'], bytes: [0x4d, 0x5a] }, // "MZ"
  { format: 'macho', platforms: ['darwin'], bytes: [0xcf, 0xfa, 0xed, 0xfe] },
  { format: 'macho', platforms: ['darwin'], bytes: [0xce, 0xfa, 0xed, 0xfe] },
  // Universal ("fat") binaries, both byte orders.
  { format: 'macho-universal', platforms: ['darwin'], bytes: [0xca, 0xfe, 0xba, 0xbe] },
  { format: 'macho-universal', platforms: ['darwin'], bytes: [0xbe, 0xba, 0xfe, 0xca] },
  { format: 'elf', platforms: ['linux'], bytes: [0x7f, 0x45, 0x4c, 0x46] },
];

const HUMAN_FORMAT = {
  pe: 'a Windows binary',
  macho: 'a macOS binary',
  'macho-universal': 'a macOS universal binary',
  elf: 'a Linux binary',
  unknown: 'an unrecognised binary',
};

const HUMAN_PLATFORM = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

/** Every `.node` under `dir`, however deeply electron-builder nested it. */
function findNativeAddons(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const found = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    // Directories are followed but symlinks are not: a macOS .app is full of
    // them, and they loop.
    if (entry.isDirectory()) found.push(...findNativeAddons(full));
    else if (entry.isFile() && entry.name.endsWith('.node')) found.push(full);
  }
  return found;
}

function identify(filePath) {
  const handle = openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(4);
    readSync(handle, header, 0, 4, 0);
    return (
      SIGNATURES.find((signature) =>
        signature.bytes.every((byte, index) => header[index] === byte),
      ) ?? { format: 'unknown', platforms: [] }
    );
  } finally {
    closeSync(handle);
  }
}

exports.default = async function verifyNativeBinary(context) {
  const { appOutDir, electronPlatformName } = context;
  const target = HUMAN_PLATFORM[electronPlatformName] ?? electronPlatformName;

  const addons = findNativeAddons(appOutDir);
  if (addons.length === 0) {
    throw new Error(
      `No native core was packaged into ${appOutDir}. Magistral cannot open a vault ` +
        'without build/Release/braindump.node — run `npm run build:native` first.',
    );
  }

  for (const addon of addons) {
    const { format, platforms } = identify(addon);
    if (platforms.includes(electronPlatformName)) continue;

    throw new Error(
      `Refusing to package a broken ${target} build.\n\n` +
        `  ${path.relative(appOutDir, addon)}\n` +
        `  is ${HUMAN_FORMAT[format]} (${statSync(addon).size} bytes), but this is ` +
        `a ${target} package.\n\n` +
        'The native core cannot be cross-compiled — it has to be built on the ' +
        `platform it ships to. Build this target on ${target}, or use ` +
        '.github/workflows/release.yml, which runs each platform on its own ' +
        'runner.\n\n' +
        'Shipping this would give every user "is not a valid Win32 application" ' +
        'at launch, which is exactly what 0.1.2 and 0.2.0 did.',
    );
  }

  console.log(`  • native core verified  platform=${electronPlatformName} files=${addons.length}`);
};
