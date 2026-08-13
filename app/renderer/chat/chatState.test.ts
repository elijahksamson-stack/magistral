import { describe, expect, it } from 'vitest';

import type { ClaudeUsage } from '../../../shared/types/claude';
import {
  appendTurn,
  deriveTurnStatus,
  findBusyTurnId,
  isTurnBusy,
  renderTranscript,
  renderTurn,
  sealRestoredTurns,
  type ChatTurn,
  type ClaudeRunSnapshot,
} from './chatState';

const USAGE: ClaudeUsage = {
  inputTokens: 1200,
  outputTokens: 300,
  cacheReadTokens: 8000,
  cacheCreationTokens: 0,
  notionalCostUsd: 0.07,
};

function run(overrides: Partial<ClaudeRunSnapshot> = {}): ClaudeRunSnapshot {
  return {
    requestId: 'req-1',
    streaming: false,
    text: '',
    error: null,
    usage: null,
    packs: [],
    ...overrides,
  };
}

function turn(id: string, prompt = 'Why does packaging bind?'): ChatTurn {
  return { id, prompt, askedAt: '2026-08-06T12:00:00.000Z' };
}

describe('deriveTurnStatus', () => {
  it('is pending before the bridge reports anything', () => {
    expect(deriveTurnStatus(undefined)).toBe('pending');
  });

  it('is streaming while text is arriving', () => {
    expect(deriveTurnStatus(run({ streaming: true, text: 'partial' }))).toBe('streaming');
  });

  it('is complete once usage is reported', () => {
    expect(deriveTurnStatus(run({ text: 'done', usage: USAGE }))).toBe('complete');
  });

  it('is failed when the bridge reported an error', () => {
    expect(deriveTurnStatus(run({ error: 'CLI_NOT_FOUND' }))).toBe('failed');
  });

  it('is interrupted when a turn stopped without usage or error', () => {
    // This is exactly the shape a cancelled turn leaves behind: streaming has
    // ended, some text arrived, and no `done` event ever reported usage.
    expect(deriveTurnStatus(run({ text: 'half a thou' }))).toBe('interrupted');
  });

  it('prefers the error over a cancelled-looking shape', () => {
    expect(deriveTurnStatus(run({ error: 'TIMEOUT', usage: null }))).toBe('failed');
  });

  it.each([
    ['pending', true],
    ['streaming', true],
    ['complete', false],
    ['interrupted', false],
    ['failed', false],
  ] as const)('isTurnBusy(%s) === %s', (status, expected) => {
    expect(isTurnBusy(status)).toBe(expected);
  });
});

describe('renderTurn', () => {
  it('carries the prompt, text, packs and usage through', () => {
    const rendered = renderTurn(
      turn('req-1'),
      run({ text: 'answer', usage: USAGE, packs: ['mindset/seeing-clearly'] }),
    );

    expect(rendered).toEqual({
      id: 'req-1',
      prompt: 'Why does packaging bind?',
      askedAt: '2026-08-06T12:00:00.000Z',
      status: 'complete',
      text: 'answer',
      error: null,
      packs: ['mindset/seeing-clearly'],
      usage: USAGE,
    });
  });

  it('renders a turn with no run yet as empty and pending', () => {
    const rendered = renderTurn(turn('req-1'), undefined);
    expect(rendered.status).toBe('pending');
    expect(rendered.text).toBe('');
    expect(rendered.packs).toEqual([]);
  });

  it('honours a recorded outcome that produced no text', () => {
    // A turn that failed or was stopped before a single delta arrived. Without
    // this it falls through to 'pending' and pins the composer's Stop button.
    const rendered = renderTurn(
      { ...turn('req-1'), finishedStatus: 'interrupted' },
      undefined,
    );

    expect(rendered.status).toBe('interrupted');
    expect(rendered.text).toBe('');
  });
});

describe('sealRestoredTurns', () => {
  it('settles a turn that was never given an outcome', () => {
    const [sealed] = sealRestoredTurns([turn('req-1')]);
    expect(sealed!.finishedStatus).toBe('interrupted');
  });

  it('leaves a turn that already recorded an outcome untouched', () => {
    const finished: ChatTurn = {
      ...turn('req-1'),
      answer: 'The binding constraint moves.',
      finishedStatus: 'complete',
    };

    expect(sealRestoredTurns([finished])[0]).toBe(finished);
  });

  it('leaves a stored answer alone even when no status was recorded', () => {
    const answered: ChatTurn = { ...turn('req-1'), answer: 'partial' };

    expect(sealRestoredTurns([answered])[0]).toBe(answered);
  });

  it('does not mutate the turns it was handed', () => {
    const original = [turn('req-1')];
    const sealed = sealRestoredTurns(original);

    expect(original[0]!.finishedStatus).toBeUndefined();
    expect(sealed).not.toBe(original);
  });

  it('leaves a restored transcript with no busy turn', () => {
    // The bug this exists for: restored turns have no run and never will, so
    // an unsealed transcript reports every one of them as busy forever.
    const restored = sealRestoredTurns([turn('req-1'), turn('req-2')]);

    expect(findBusyTurnId(renderTranscript(restored, {}))).toBeNull();
  });
});

describe('renderTranscript', () => {
  it('renders streamed deltas in arrival order', () => {
    const deltas = ['The', 'The binding', 'The binding constraint', 'The binding constraint moves.'];

    const texts = deltas.map((text, index) => {
      const isLast = index === deltas.length - 1;
      const runs = {
        'req-1': run({ text, streaming: !isLast, ...(isLast ? { usage: USAGE } : {}) }),
      };
      return renderTranscript([turn('req-1')], runs)[0]!.text;
    });

    expect(texts).toEqual(deltas);
    // Each snapshot must extend the previous one — never reorder or drop text.
    for (let i = 1; i < texts.length; i += 1) {
      expect(texts[i]!.startsWith(texts[i - 1]!)).toBe(true);
    }
  });

  it('keeps turns in the order they were asked, not the order they finish', () => {
    const turns = [turn('req-1', 'first'), turn('req-2', 'second')];
    const runs = {
      'req-2': run({ requestId: 'req-2', text: 'answered first', usage: USAGE }),
      'req-1': run({ requestId: 'req-1', text: 'still going', streaming: true }),
    };

    expect(renderTranscript(turns, runs).map((entry) => entry.prompt)).toEqual([
      'first',
      'second',
    ]);
  });

  it('surfaces a cancelled turn as interrupted while keeping its partial text', () => {
    const rendered = renderTranscript(
      [turn('req-1')],
      { 'req-1': run({ text: 'The binding const', packs: ['mindset/seeing-clearly'] }) },
    );

    expect(rendered[0]!.status).toBe('interrupted');
    expect(rendered[0]!.text).toBe('The binding const');
    expect(rendered[0]!.packs).toEqual(['mindset/seeing-clearly']);
  });
});

describe('transcript helpers', () => {
  it('appends immutably', () => {
    const original = [turn('req-1')];
    const next = appendTurn(original, turn('req-2'));

    expect(original).toHaveLength(1);
    expect(next).toHaveLength(2);
    expect(next).not.toBe(original);
  });

  it('finds the turn a cancel control should act on', () => {
    const turns = [turn('req-1'), turn('req-2')];
    const runs = {
      'req-1': run({ requestId: 'req-1', text: 'done', usage: USAGE }),
      'req-2': run({ requestId: 'req-2', text: 'going', streaming: true }),
    };

    expect(findBusyTurnId(renderTranscript(turns, runs))).toBe('req-2');
  });

  it('returns no busy turn once everything settled', () => {
    const runs = { 'req-1': run({ text: 'done', usage: USAGE }) };
    expect(findBusyTurnId(renderTranscript([turn('req-1')], runs))).toBeNull();
  });
});
