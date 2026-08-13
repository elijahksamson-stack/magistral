/**
 * Interprets one parsed stream-json object into something the bridge can act on.
 *
 * The CLI's NDJSON is external data: every field is checked before it is read,
 * and an unrecognised shape becomes `{ kind: 'ignored' }` rather than a throw.
 * Unknown-but-harmless records appear whenever the CLI adds an event type, and
 * they must not fail a run that is otherwise fine.
 */

import type { ClaudeUsage } from '../../../shared/types/claude';

export type StreamSignal =
  | { readonly kind: 'init'; readonly sessionId: string }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'thinking'; readonly text: string }
  | { readonly kind: 'tool'; readonly name: string }
  | {
      readonly kind: 'result';
      readonly sessionId: string;
      readonly text: string;
      readonly usage: ClaudeUsage;
      readonly isError: boolean;
      readonly errorText?: string;
    }
  | { readonly kind: 'ignored' };

const IGNORED: StreamSignal = { kind: 'ignored' };

export const EMPTY_USAGE: ClaudeUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  notionalCostUsd: 0,
};

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

export function readUsage(raw: unknown, costUsd: unknown): ClaudeUsage {
  const usage = asRecord(raw);
  if (!usage) return { ...EMPTY_USAGE, notionalCostUsd: asNumber(costUsd) };
  return {
    inputTokens: asNumber(usage.input_tokens),
    outputTokens: asNumber(usage.output_tokens),
    cacheReadTokens: asNumber(usage.cache_read_input_tokens),
    cacheCreationTokens: asNumber(usage.cache_creation_input_tokens),
    notionalCostUsd: asNumber(costUsd),
  };
}

/** `stream_event` wraps the raw Anthropic SSE event under `event`. */
function readStreamEvent(event: Record<string, unknown>): StreamSignal {
  const type = asString(event.type);

  if (type === 'content_block_delta') {
    const delta = asRecord(event.delta);
    if (!delta) return IGNORED;
    const deltaType = asString(delta.type);
    if (deltaType === 'text_delta') {
      const text = asString(delta.text);
      return text ? { kind: 'text', text } : IGNORED;
    }
    if (deltaType === 'thinking_delta') {
      const text = asString(delta.thinking);
      return text ? { kind: 'thinking', text } : IGNORED;
    }
    return IGNORED;
  }

  if (type === 'content_block_start') {
    const block = asRecord(event.content_block);
    if (block && asString(block.type) === 'tool_use') {
      const name = asString(block.name);
      return name ? { kind: 'tool', name } : IGNORED;
    }
    return IGNORED;
  }

  return IGNORED;
}

/** An `assistant` record carries complete blocks; used to name tools. */
function readAssistant(record: Record<string, unknown>): StreamSignal {
  const message = asRecord(record.message);
  const content = message?.content;
  if (!Array.isArray(content)) return IGNORED;

  for (const entry of content) {
    const block = asRecord(entry);
    if (block && asString(block.type) === 'tool_use') {
      const name = asString(block.name);
      if (name) return { kind: 'tool', name };
    }
  }
  return IGNORED;
}

/** Concatenate the text blocks of an `assistant` record. */
export function readAssistantText(value: unknown): string {
  const record = asRecord(value);
  const message = asRecord(record?.message);
  const content = message?.content;
  if (!Array.isArray(content)) return '';

  return content
    .map((entry) => {
      const block = asRecord(entry);
      return block && asString(block.type) === 'text' ? asString(block.text) : '';
    })
    .join('');
}

export function interpret(value: unknown): StreamSignal {
  const record = asRecord(value);
  if (!record) return IGNORED;

  const type = asString(record.type);

  if (type === 'system') {
    const sessionId = asString(record.session_id);
    if (asString(record.subtype) === 'init' && sessionId) return { kind: 'init', sessionId };
    return IGNORED;
  }

  if (type === 'stream_event') {
    const event = asRecord(record.event);
    return event ? readStreamEvent(event) : IGNORED;
  }

  if (type === 'assistant') return readAssistant(record);

  if (type === 'result') {
    const subtype = asString(record.subtype);
    const isError = record.is_error === true || subtype.startsWith('error');
    return {
      kind: 'result',
      sessionId: asString(record.session_id),
      text: asString(record.result),
      usage: readUsage(record.usage, record.total_cost_usd),
      isError,
      ...(isError ? { errorText: asString(record.result) || subtype || 'CLI reported an error' } : {}),
    };
  }

  return IGNORED;
}
