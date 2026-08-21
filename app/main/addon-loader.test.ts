/**
 * Loading the native core, and what the author is told when it fails.
 *
 * The message matters as much as the detection. Magistral 0.1.2 and 0.2.0
 * shipped a Windows installer holding a macOS binary; users saw the OS loader's
 * "is not a valid Win32 application" followed by our own advice to run
 * `npm run build:native` — npm instructions given to someone who downloaded an
 * installer. These cases pin the wording so that cannot come back.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { binaryPlatform, loadCoreAddon } from './addon-loader';

let dir: string;

/** A file that begins like a real binary of that platform, and is otherwise empty. */
async function writeFakeBinary(name: string, magic: readonly number[]): Promise<string> {
  const file = path.join(dir, name);
  await fs.writeFile(file, Buffer.from([...magic, 0x00, 0x00, 0x00, 0x00]));
  return file;
}

/** Magic bytes for a platform this machine is NOT, so the mismatch is real. */
function foreignMagic(): number[] {
  return process.platform === 'darwin' ? [0x4d, 0x5a] : [0xcf, 0xfa, 0xed, 0xfe];
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'braindump-addon-'));
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('binaryPlatform', () => {
  it('recognises a Windows binary by its MZ header', async () => {
    expect(binaryPlatform(await writeFakeBinary('win.node', [0x4d, 0x5a]))).toBe('win32');
  });

  it('recognises a macOS binary', async () => {
    expect(binaryPlatform(await writeFakeBinary('mac.node', [0xcf, 0xfa, 0xed, 0xfe]))).toBe(
      'darwin',
    );
  });

  it('recognises a macOS universal binary', async () => {
    expect(binaryPlatform(await writeFakeBinary('fat.node', [0xca, 0xfe, 0xba, 0xbe]))).toBe(
      'darwin',
    );
  });

  it('recognises a Linux binary', async () => {
    expect(binaryPlatform(await writeFakeBinary('linux.node', [0x7f, 0x45, 0x4c, 0x46]))).toBe(
      'linux',
    );
  });

  it('reports unknown rather than guessing', async () => {
    expect(binaryPlatform(await writeFakeBinary('junk.node', [0x00, 0x01]))).toBe('unknown');
  });

  it('reports unknown for a file that is not there', () => {
    expect(binaryPlatform(path.join(dir, 'absent.node'))).toBe('unknown');
  });
});

describe('what the author is told when the core will not load', () => {
  /*
   * The reported bug: a Windows user running the published 0.2.0 installer.
   * Whatever platform this suite runs on, a binary for a DIFFERENT one has to
   * produce the broken-download message.
   */
  it('says the download is wrong, not the machine', async () => {
    const result = loadCoreAddon([await writeFakeBinary('foreign.node', foreignMagic())]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/will not run on/i);
    expect(result.reason).toMatch(/nothing is wrong with your machine/i);
    expect(result.reason).toMatch(/packaged incorrectly/i);
  });

  it('never tells a user with a foreign binary to run npm', async () => {
    const result = loadCoreAddon([await writeFakeBinary('foreign2.node', foreignMagic())]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The exact advice every Windows user got, and could not act on.
    expect(result.reason).not.toMatch(/npm run/);
    expect(result.reason).not.toMatch(/rebuild:electron/);
  });

  it('names the platform whose build the reader should fetch', async () => {
    const result = loadCoreAddon([await writeFakeBinary('foreign3.node', foreignMagic())]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(process.platform === 'darwin' ? /macOS/ : /Windows|Linux/);
  });

  it('still reports a missing core with the developer hint', () => {
    const result = loadCoreAddon(['/definitely/not/a/real/braindump.node']);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/native core was not found/i);
    expect(result.reason).toMatch(/npm run build:native/);
  });
});
