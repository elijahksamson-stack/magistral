/**
 * `claude:health` — is the CLI there, and is it logged in?
 *
 * Deliberately does NOT invoke the model to find out. A probe prompt would cost
 * the user real tokens every time the app started, which is precisely the kind
 * of quiet spending this app exists to avoid. Availability comes from
 * `claude --version`; authentication is inferred from the credential files the
 * CLI writes at login. The reason string always says which check failed.
 */

import { execFile } from 'node:child_process';
import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CliProviderStatus } from '../../../shared/types/claude';
import { buildChildEnv, buildCodexChildEnv } from './env';
import { createLogger, errorMessage } from '../logger';

const log = createLogger('claude-health');

export const VERSION_TIMEOUT_MS = 10_000;
const CLAUDE_BINARY_NAME = 'claude';
const CODEX_BINARY_NAME = 'codex';

export interface HealthReport {
  available: boolean;
  version?: string;
  authenticated: boolean;
  reason?: string;
}

export interface DetectedCliProvider {
  status: CliProviderStatus;
  binaryPath?: string;
}

/** Several Rust CLI status commands write successful human output to stderr. */
export function successfulCommandOutput(stdout: string, stderr: string): string {
  return stdout.trim() || stderr.trim();
}

/**
 * Find `claude` on PATH. Electron GUI processes inherit a stunted PATH when
 * launched from Finder, so the usual install locations are appended.
 */
export async function resolveClaudeBinary(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): Promise<string | null> {
  const pathEntries = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const fallbacks = [
    path.join(homeDir, '.local', 'bin'),
    path.join(homeDir, '.claude', 'local'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    ...windowsFallbackDirectories(env, homeDir),
  ];

  return firstExecutable(
    candidatePaths([...pathEntries, ...fallbacks], CLAUDE_BINARY_NAME, env),
  );
}

/**
 * Find Codex both as a normal CLI install and inside the ChatGPT desktop app.
 * Finder-launched Electron apps do not inherit the user's interactive PATH.
 */
export async function resolveCodexBinary(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): Promise<string | null> {
  const pathEntries = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const directories = [
    ...pathEntries,
    path.join(homeDir, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    ...windowsFallbackDirectories(env, homeDir),
  ];
  const appCandidates = [
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    path.join(homeDir, 'Applications', 'ChatGPT.app', 'Contents', 'Resources', 'codex'),
  ];
  return firstExecutable([
    ...candidatePaths(directories, CODEX_BINARY_NAME, env),
    ...appCandidates,
  ]);
}

/**
 * The names one CLI can have on this platform.
 *
 * On POSIX a binary is just `claude`. On Windows it is almost never that: an
 * npm-installed CLI is a `claude.cmd` shim, and `path.join(dir, 'claude')`
 * matches nothing. Magistral therefore found no providers at all on Windows and
 * every AI feature was silently unavailable — the app opened, vaults worked,
 * and the ✦ actions simply were not there.
 *
 * PATHEXT is what the shell itself consults, so it is what this consults, with
 * the documented default when the variable is absent. The bare name stays in
 * the list because a real extensionless executable is still valid.
 */
function executableNames(base: string, env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== 'win32') return [base];
  const pathext = env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  const extensions = pathext
    .split(';')
    .map((extension) => extension.trim())
    .filter(Boolean);
  return [...extensions.map((extension) => `${base}${extension.toLowerCase()}`), base];
}

/** Where a CLI installs on Windows, which shares nothing with the POSIX list. */
function windowsFallbackDirectories(env: NodeJS.ProcessEnv, homeDir: string): string[] {
  if (process.platform !== 'win32') return [];
  const appData = env.APPDATA ?? path.join(homeDir, 'AppData', 'Roaming');
  const localAppData = env.LOCALAPPDATA ?? path.join(homeDir, 'AppData', 'Local');
  return [
    path.join(appData, 'npm'), // npm -g puts its shims here
    path.join(localAppData, 'Programs'),
    path.join(localAppData, 'Microsoft', 'WindowsApps'),
  ];
}

/** Every name a CLI could carry, in every directory worth looking in. */
function candidatePaths(
  directories: readonly string[],
  base: string,
  env: NodeJS.ProcessEnv,
): string[] {
  const names = executableNames(base, env);
  return directories.flatMap((dir) => names.map((name) => path.join(dir, name)));
}

async function firstExecutable(candidates: readonly string[]): Promise<string | null> {
  for (const candidate of new Set(candidates)) {
    try {
      // X_OK is a no-op on Windows — it degrades to an existence check, which
      // is the right question there anyway, since PATHEXT has already decided
      // what counts as executable.
      await fs.access(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function runCommand(
  binaryPath: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(
      binaryPath,
      [...args],
      { timeout: VERSION_TIMEOUT_MS, env },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ ok: false, output: stderr.trim() || errorMessage(error) });
          return;
        }
        resolve({ ok: true, output: successfulCommandOutput(stdout, stderr) });
      },
    );
  });
}

function runVersion(
  binaryPath: string,
  env: NodeJS.ProcessEnv,
): Promise<{ ok: boolean; output: string }> {
  return runCommand(binaryPath, ['--version'], buildChildEnv(env));
}

export function isChatGptLoginStatus(output: string): boolean {
  return /\blogged in using chatgpt\b/i.test(output);
}

/**
 * Verify Codex is using ChatGPT subscription auth, never an API-key login.
 * This is intentionally a zero-token command and is safe to run before each
 * fallback invocation.
 */
export async function checkCodexSubscription(
  binaryPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HealthReport> {
  const cleanEnv = buildCodexChildEnv(env);
  const version = await runCommand(binaryPath, ['--version'], cleanEnv);
  if (!version.ok) {
    return {
      available: false,
      authenticated: false,
      reason: `\`${binaryPath} --version\` failed: ${version.output || 'no output'}`,
    };
  }

  const login = await runCommand(binaryPath, ['login', 'status'], cleanEnv);
  const authenticated = login.ok && isChatGptLoginStatus(login.output);
  return {
    available: true,
    version: version.output,
    authenticated,
    ...(authenticated
      ? {}
      : {
          reason:
            'Codex is installed but is not signed in with ChatGPT. Run `codex login` and choose ' +
            'ChatGPT subscription access; Magistral will not use an API-key login.',
        }),
  };
}

/**
 * Login state, read from disk. `~/.claude/.credentials.json` is written by
 * `claude login`; on macOS the token itself may live in the Keychain, in which
 * case `~/.claude.json` still carries the `oauthAccount` record.
 */
async function detectAuthentication(homeDir: string): Promise<boolean> {
  const credentialsPath = path.join(homeDir, '.claude', '.credentials.json');
  try {
    await fs.access(credentialsPath, constants.R_OK);
    return true;
  } catch {
    // Fall through to the settings file.
  }

  try {
    const raw = await fs.readFile(path.join(homeDir, '.claude.json'), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return false;
    const record = parsed as Record<string, unknown>;
    return typeof record.oauthAccount === 'object' && record.oauthAccount !== null;
  } catch (error: unknown) {
    log.debug('no readable Claude credentials', errorMessage(error));
    return false;
  }
}

export async function checkClaudeSubscription(
  binaryPath: string,
  homeDir: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<HealthReport> {
  const version = await runVersion(binaryPath, env);
  if (!version.ok) {
    return {
      available: false,
      authenticated: false,
      reason: `\`${binaryPath} --version\` failed: ${version.output || 'no output'}`,
    };
  }

  const authenticated = await detectAuthentication(homeDir);
  return {
    available: true,
    version: version.output,
    authenticated,
    ...(authenticated
      ? {}
      : {
          reason:
            'Claude Code is installed but not logged in. Run `claude` in a terminal and complete ' +
            'sign-in — Magistral uses your subscription and never an API key.',
        }),
  };
}

function missingProvider(
  id: CliProviderStatus['id'],
  label: CliProviderStatus['label'],
  reason: string,
): DetectedCliProvider {
  return { status: { id, label, available: false, authenticated: false, reason } };
}

/** Detect every supported CLI without sending a prompt or consuming tokens. */
export async function detectCliProviders(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): Promise<DetectedCliProvider[]> {
  const [claudeBinary, codexBinary] = await Promise.all([
    resolveClaudeBinary(env, homeDir),
    resolveCodexBinary(env, homeDir),
  ]);
  const [claudeHealth, codexHealth] = await Promise.all([
    claudeBinary ? checkClaudeSubscription(claudeBinary, homeDir, env) : null,
    codexBinary ? checkCodexSubscription(codexBinary, env) : null,
  ]);

  return [
    claudeBinary && claudeHealth
      ? { binaryPath: claudeBinary, status: { id: 'claude', label: 'Claude', ...claudeHealth } }
      : missingProvider(
          'claude',
          'Claude',
          'The `claude` command was not found. Install Claude Code, then return to Magistral.',
        ),
    codexBinary && codexHealth
      ? { binaryPath: codexBinary, status: { id: 'codex', label: 'ChatGPT', ...codexHealth } }
      : missingProvider(
          'codex',
          'ChatGPT',
          'No local Codex CLI was found. Install Codex or the ChatGPT desktop app, then return to Magistral.',
        ),
  ];
}

/** Health of the effective provider chain: Claude first, Codex fallback. */
export async function checkClaudeHealth(homeDir: string = os.homedir()): Promise<HealthReport> {
  const providers = await detectCliProviders(process.env, homeDir);
  const claude = providers.find((provider) => provider.status.id === 'claude')?.status;
  const codex = providers.find((provider) => provider.status.id === 'codex')?.status;
  if (claude?.available && claude.authenticated) return claude;
  if (!codex?.available || !codex.authenticated) {
    return {
      available: false,
      authenticated: false,
      reason: `${claude?.reason ?? 'Claude is unavailable.'} ${codex?.reason ?? 'Codex is unavailable.'}`,
    };
  }

  return {
    available: true,
    authenticated: true,
    ...(codex.version ? { version: codex.version } : {}),
    reason: 'Claude is unavailable; Magistral will use the local Codex CLI with ChatGPT subscription access.',
  };
}
