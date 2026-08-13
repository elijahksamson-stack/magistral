/**
 * Child-environment hygiene for the spawned `claude` CLI.
 *
 * THIS IS THE MOST IMPORTANT FILE IN THE APP.
 *
 * The CLI decides how to bill by sniffing its environment. If ANTHROPIC_API_KEY
 * (or any of the other keys in STRIPPED_ENV_KEYS) reaches the child, it quietly
 * stops using the logged-in subscription and starts consuming API credits —
 * with no visible difference in the output. There is no runtime signal that
 * this went wrong, which is exactly why it is a pure function with a dedicated
 * unit test rather than three lines inlined into the spawn call.
 *
 * Pure and dependency-free on purpose: it takes an env and returns a new env.
 */

import { STRIPPED_ENV_KEYS } from '../../../shared/types/claude';

export type EnvRecord = Readonly<Record<string, string | undefined>>;

/**
 * Environment switches that can make Codex use metered API credentials.
 *
 * BrainDump's Codex fallback is deliberately subscription-only. The cached
 * login is checked separately with `codex login status`; removing these keys
 * prevents an inherited shell configuration from overriding that login.
 */
export const CODEX_STRIPPED_ENV_KEYS: readonly string[] = [
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_ORG_ID',
  'OPENAI_ORGANIZATION',
  'OPENAI_PROJECT_ID',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_ENDPOINT',
] as const;

/**
 * Return a copy of `source` with every key in STRIPPED_ENV_KEYS removed.
 *
 * Keys are compared case-insensitively. Windows environment variables are
 * case-insensitive, and while this app ships macOS-first, a case-sensitive
 * check here would be a silent hole on any platform that is not.
 *
 * `source` is never mutated.
 */
export function buildChildEnv(source: EnvRecord): Record<string, string> {
  return withoutKeys(source, STRIPPED_ENV_KEYS);
}

/** A clean environment for Codex: no Anthropic or OpenAI API billing keys. */
export function buildCodexChildEnv(source: EnvRecord): Record<string, string> {
  return withoutKeys(source, [...STRIPPED_ENV_KEYS, ...CODEX_STRIPPED_ENV_KEYS]);
}

function withoutKeys(source: EnvRecord, keys: readonly string[]): Record<string, string> {
  const banned = new Set(keys.map((key) => key.toLowerCase()));
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (banned.has(key.toLowerCase())) continue;
    result[key] = value;
  }
  return result;
}

/**
 * True when `env` still carries a key that would divert billing to the API.
 * Used as a belt-and-braces assertion immediately before spawn.
 */
export function hasBillingLeak(env: EnvRecord): boolean {
  return hasAnyKey(env, STRIPPED_ENV_KEYS);
}

/** True when a Codex child could be diverted to metered API credentials. */
export function hasCodexBillingLeak(env: EnvRecord): boolean {
  return hasAnyKey(env, [...STRIPPED_ENV_KEYS, ...CODEX_STRIPPED_ENV_KEYS]);
}

function hasAnyKey(env: EnvRecord, keys: readonly string[]): boolean {
  const banned = new Set(keys.map((key) => key.toLowerCase()));
  return Object.keys(env).some((key) => banned.has(key.toLowerCase()));
}
