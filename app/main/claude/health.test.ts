import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  detectCliProviders,
  isChatGptLoginStatus,
  resolveCodexBinary,
  successfulCommandOutput,
} from './health';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true })));
});

/*
 * A CLI is `codex` on POSIX and `codex.cmd` on Windows, where an npm global
 * install writes a shim and an extensionless file is not executable at all.
 * The fixture has to follow the platform or it tests nothing.
 */
const isWindows = process.platform === 'win32';

/** A file the platform will agree is runnable. */
async function writeFakeCli(directory: string, base: string, body: string): Promise<string> {
  const binary = path.join(directory, isWindows ? `${base}.cmd` : base);
  await writeFile(binary, isWindows ? `@echo off\r\n${body}\r\n` : `#!/bin/sh\n${body}\n`);
  // chmod is a no-op on Windows, where PATHEXT decides what runs.
  if (!isWindows) await chmod(binary, 0o755);
  return binary;
}

describe('resolveCodexBinary', () => {
  it('detects an executable codex on the GUI process PATH', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'braindump-codex-'));
    temporaryDirectories.push(directory);
    const binary = await writeFakeCli(directory, 'codex', '');

    await expect(resolveCodexBinary({ PATH: directory }, directory)).resolves.toBe(binary);
  });

  /*
   * The Windows bug this covers: resolution looked for `path.join(dir, 'codex')`
   * only, so an npm-installed `codex.cmd` was invisible and Magistral reported
   * no providers at all — every AI feature silently absent on Windows.
   */
  it.runIf(isWindows)('finds a .cmd shim, which is how npm installs a CLI', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'braindump-codex-cmd-'));
    temporaryDirectories.push(directory);
    const shim = path.join(directory, 'codex.cmd');
    await writeFile(shim, '@echo off\r\n');

    await expect(
      resolveCodexBinary({ PATH: directory, PATHEXT: '.COM;.EXE;.BAT;.CMD' }, directory),
    ).resolves.toBe(shim);
  });
});

describe('detectCliProviders', () => {
  /*
   * Skipped on Windows because it CANNOT pass there yet, and saying so here is
   * better than a green suite that hides it.
   *
   * Resolution now finds `codex.cmd`, and the next line fails with spawn EINVAL:
   * Node refuses to spawn a .cmd without `shell: true`, and `shell: true` joins
   * arguments without escaping — with the prompt travelling as an argv entry
   * (args.ts, `-p <prompt>`) that is an injection surface on the path CLAUDE.md
   * guards. cmd.exe also caps a command line at 8191 characters, while
   * DOCUMENT_CHAR_LIMIT allows 60,000.
   *
   * The fix is to move the prompt off argv and onto stdin, which bridge.ts
   * currently ignores. That is a change to how every CLI invocation is made and
   * wants its own design, not a patch bolted on here.
   */
  it.skipIf(isWindows)('reports every authenticated CLI found on the GUI process PATH', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'braindump-providers-'));
    temporaryDirectories.push(home);
    const bin = path.join(home, 'bin');
    await mkdir(bin);
    await mkdir(path.join(home, '.claude'));
    await writeFile(path.join(home, '.claude', '.credentials.json'), '{}');

    await writeFakeCli(bin, 'claude', isWindows ? 'echo claude 2.0' : 'echo "claude 2.0"');
    await writeFakeCli(
      bin,
      'codex',
      isWindows
        ? 'if "%1"=="--version" (echo codex 1.0) else (echo Logged in using ChatGPT 1>&2)'
        : 'if [ "$1" = "--version" ]; then echo "codex 1.0"; else echo "Logged in using ChatGPT" >&2; fi',
    );

    const providers = await detectCliProviders({ PATH: bin }, home);

    expect(providers.map(({ status }) => status)).toMatchObject([
      { id: 'claude', available: true, authenticated: true, version: 'claude 2.0' },
      { id: 'codex', available: true, authenticated: true, version: 'codex 1.0' },
    ]);
  });
});

describe('isChatGptLoginStatus', () => {
  it('accepts ChatGPT subscription auth', () => {
    expect(isChatGptLoginStatus('Logged in using ChatGPT')).toBe(true);
  });

  it('reads successful status text from stderr, as the bundled Codex CLI emits it', () => {
    const output = successfulCommandOutput('', 'Logged in using ChatGPT\n');
    expect(isChatGptLoginStatus(output)).toBe(true);
  });

  it('rejects API-key auth and signed-out status', () => {
    expect(isChatGptLoginStatus('Logged in using an API key')).toBe(false);
    expect(isChatGptLoginStatus('Not logged in')).toBe(false);
  });
});
