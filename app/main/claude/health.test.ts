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

describe('resolveCodexBinary', () => {
  it('detects an executable codex on the GUI process PATH', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'braindump-codex-'));
    temporaryDirectories.push(directory);
    const binary = path.join(directory, 'codex');
    await writeFile(binary, '#!/bin/sh\n');
    await chmod(binary, 0o755);

    await expect(resolveCodexBinary({ PATH: directory }, directory)).resolves.toBe(binary);
  });
});

describe('detectCliProviders', () => {
  it('reports every authenticated CLI found on the GUI process PATH', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'braindump-providers-'));
    temporaryDirectories.push(home);
    const bin = path.join(home, 'bin');
    await mkdir(bin);
    await mkdir(path.join(home, '.claude'));
    await writeFile(path.join(home, '.claude', '.credentials.json'), '{}');

    const claude = path.join(bin, 'claude');
    const codex = path.join(bin, 'codex');
    await writeFile(claude, '#!/bin/sh\necho "claude 2.0"\n');
    await writeFile(
      codex,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex 1.0"; else echo "Logged in using ChatGPT" >&2; fi\n',
    );
    await Promise.all([chmod(claude, 0o755), chmod(codex, 0o755)]);

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
