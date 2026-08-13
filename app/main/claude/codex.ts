/**
 * Pure Codex CLI adapter pieces.
 *
 * The main bridge owns process lifetime; this module only builds the safe argv,
 * tags provider-specific session ids, and interprets Codex's JSONL records.
 */

import type { ClaudeUsage } from '../../../shared/types/claude';
import { EMPTY_USAGE } from './stream-events';

export const CODEX_SESSION_PREFIX = 'codex:';

export interface CodexArgsInput {
  readonly prompt: string;
  readonly resumeSessionId?: string;
}

/**
 * Codex global flags precede `exec` so they also govern `exec resume`.
 * User config is ignored to prevent an alternate model provider, MCP server,
 * hook, or wider permission policy from changing this invocation.
 */
export function buildCodexArgs(input: CodexArgsInput): string[] {
  const common = [
    '--sandbox',
    'read-only',
    '--ask-for-approval',
    'never',
    'exec',
  ];
  const run = ['--json', '--ignore-user-config', '--skip-git-repo-check'];

  if (input.resumeSessionId) {
    return [...common, 'resume', ...run, input.resumeSessionId, input.prompt];
  }
  return [...common, ...run, input.prompt];
}

export function isCodexSessionId(sessionId: string | undefined): boolean {
  return Boolean(sessionId?.startsWith(CODEX_SESSION_PREFIX));
}

export function unwrapCodexSessionId(sessionId: string | undefined): string | undefined {
  if (!isCodexSessionId(sessionId)) return undefined;
  const raw = sessionId?.slice(CODEX_SESSION_PREFIX.length);
  return raw || undefined;
}

export function tagCodexSessionId(sessionId: string): string {
  return sessionId ? `${CODEX_SESSION_PREFIX}${sessionId}` : '';
}

/** Conservative: only allowance exhaustion, never a generic transient error. */
export function isClaudeAllowanceLimit(message: string): boolean {
  const text = message.replace(/[\s_-]+/g, ' ').trim();
  return [
    /\byou(?:'ve| have) hit your (?:session|usage|weekly|monthly) limit\b/i,
    /\b(?:session|usage|weekly|monthly) limit (?:has been )?(?:reached|exceeded)\b/i,
    /\b(?:credits?|allowance) (?:is |are )?(?:exhausted|depleted|maxed out)\b/i,
  ].some((pattern) => pattern.test(text));
}

export type CodexSignal =
  | { readonly kind: 'init'; readonly sessionId: string }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'thinking'; readonly text: string }
  | { readonly kind: 'tool'; readonly name: string }
  | { readonly kind: 'result'; readonly usage: ClaudeUsage }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ignored' };

const IGNORED: CodexSignal = { kind: 'ignored' };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readCodexUsage(value: unknown): ClaudeUsage {
  const usage = asRecord(value);
  if (!usage) return EMPTY_USAGE;
  return {
    inputTokens: asNumber(usage.input_tokens),
    outputTokens: asNumber(usage.output_tokens),
    cacheReadTokens: asNumber(usage.cached_input_tokens),
    cacheCreationTokens: asNumber(usage.cache_write_input_tokens),
    notionalCostUsd: 0,
  };
}

function itemSignal(value: unknown): CodexSignal {
  const item = asRecord(value);
  if (!item) return IGNORED;
  const type = asString(item.type);

  if (type === 'agent_message') {
    const text = asString(item.text);
    return text ? { kind: 'text', text } : IGNORED;
  }
  if (type === 'reasoning') {
    const text = asString(item.text);
    return text ? { kind: 'thinking', text } : IGNORED;
  }

  const names: Record<string, string> = {
    command_execution: 'Shell',
    file_change: 'File change',
    mcp_tool_call: 'MCP tool',
    web_search: 'Web search',
  };
  const name = names[type];
  return name ? { kind: 'tool', name } : IGNORED;
}

export function interpretCodex(value: unknown): CodexSignal {
  const record = asRecord(value);
  if (!record) return IGNORED;
  const type = asString(record.type);

  if (type === 'thread.started') {
    const sessionId = asString(record.thread_id);
    return sessionId ? { kind: 'init', sessionId } : IGNORED;
  }
  if (type === 'item.completed') return itemSignal(record.item);
  if (type === 'turn.completed') return { kind: 'result', usage: readCodexUsage(record.usage) };

  if (type === 'turn.failed') {
    const error = asRecord(record.error);
    return { kind: 'error', message: asString(error?.message) || 'Codex turn failed.' };
  }
  if (type === 'error') {
    return { kind: 'error', message: asString(record.message) || 'Codex reported an error.' };
  }
  return IGNORED;
}
