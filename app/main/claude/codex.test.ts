import { describe, expect, it } from 'vitest';
import {
  buildCodexArgs,
  interpretCodex,
  isClaudeAllowanceLimit,
  isCodexSessionId,
  tagCodexSessionId,
  unwrapCodexSessionId,
} from './codex';

describe('buildCodexArgs', () => {
  it('runs non-interactively with read-only permissions and isolated config', () => {
    const args = buildCodexArgs({ prompt: 'Read this graph.' });

    expect(args).toEqual([
      '--sandbox',
      'read-only',
      '--ask-for-approval',
      'never',
      'exec',
      '--json',
      '--ignore-user-config',
      '--skip-git-repo-check',
      'Read this graph.',
    ]);
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('resumes only a Codex session supplied by the bridge', () => {
    const args = buildCodexArgs({ prompt: 'Continue.', resumeSessionId: 'thread-42' });

    expect(args.slice(0, 6)).toEqual([
      '--sandbox',
      'read-only',
      '--ask-for-approval',
      'never',
      'exec',
      'resume',
    ]);
    expect(args.at(-2)).toBe('thread-42');
    expect(args.at(-1)).toBe('Continue.');
  });
});

describe('Codex session ids', () => {
  it('tags and unwraps ids without confusing Claude ids', () => {
    expect(tagCodexSessionId('thread-42')).toBe('codex:thread-42');
    expect(isCodexSessionId('codex:thread-42')).toBe(true);
    expect(unwrapCodexSessionId('codex:thread-42')).toBe('thread-42');
    expect(isCodexSessionId('claude-session-42')).toBe(false);
    expect(unwrapCodexSessionId('claude-session-42')).toBeUndefined();
  });
});

describe('Claude allowance classification', () => {
  it('recognizes the session-limit message emitted by Claude Code', () => {
    expect(
      isClaudeAllowanceLimit("You've hit your session limit · resets 6:20pm (America/New_York)"),
    ).toBe(true);
  });

  it('does not turn generic failures into cross-provider retries', () => {
    expect(isClaudeAllowanceLimit('claude: not logged in')).toBe(false);
    expect(isClaudeAllowanceLimit('The service is temporarily overloaded')).toBe(false);
  });
});

describe('interpretCodex', () => {
  it('reads session, answer, usage, and failure records', () => {
    expect(interpretCodex({ type: 'thread.started', thread_id: 'thread-1' })).toEqual({
      kind: 'init',
      sessionId: 'thread-1',
    });
    expect(
      interpretCodex({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'Final answer.' },
      }),
    ).toEqual({ kind: 'text', text: 'Final answer.' });
    expect(
      interpretCodex({
        type: 'turn.completed',
        usage: {
          input_tokens: 10,
          cached_input_tokens: 4,
          cache_write_input_tokens: 2,
          output_tokens: 3,
        },
      }),
    ).toEqual({
      kind: 'result',
      usage: {
        inputTokens: 10,
        outputTokens: 3,
        cacheReadTokens: 4,
        cacheCreationTokens: 2,
        notionalCostUsd: 0,
      },
    });
    expect(
      interpretCodex({ type: 'turn.failed', error: { message: 'usage limit reached' } }),
    ).toEqual({ kind: 'error', message: 'usage limit reached' });
  });
});
