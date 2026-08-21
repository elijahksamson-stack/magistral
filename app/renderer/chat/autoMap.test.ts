/**
 * Auto-map scheduling: which answer gets read, and which never does.
 *
 * Every rule here corresponds to a way the toggle could spend a CLI run on
 * nothing, or throw away a review the author was in the middle of.
 */

import { describe, expect, it } from 'vitest';

import { nextTurnToMap, seenTurnIds } from './autoMap';
import type { RenderedTurn } from './chatState';

function turn(id: string, overrides: Partial<RenderedTurn> = {}): RenderedTurn {
  return {
    id,
    prompt: 'what binds?',
    askedAt: '2026-08-06T12:00:00.000Z',
    status: 'complete',
    text: 'Your graph has no node for crypto markets.',
    error: null,
    packs: [],
    usage: null,
    ...overrides,
  };
}

describe('nextTurnToMap', () => {
  it('reads the oldest unread answer, so a burst is mapped in the order asked', () => {
    const turns = [turn('a'), turn('b'), turn('c')];

    expect(nextTurnToMap(turns, new Set(['a']))?.id).toBe('b');
  });

  it('never reads the same answer twice', () => {
    expect(nextTurnToMap([turn('a')], new Set(['a']))).toBeNull();
  });

  /*
   * Half a paragraph names half the concepts. A proposal built from it is
   * wrong in a way that looks right, which is worse than no proposal.
   */
  it('waits for an answer that is still streaming', () => {
    const turns = [turn('a', { status: 'streaming', text: 'Your graph has no node for' })];

    expect(nextTurnToMap(turns, new Set())).toBeNull();
  });

  it('skips a turn that has not started', () => {
    expect(nextTurnToMap([turn('a', { status: 'pending', text: '' })], new Set())).toBeNull();
  });

  it('skips a stopped answer rather than mapping a fragment', () => {
    const turns = [turn('a', { status: 'interrupted', text: 'Your graph has no' })];

    expect(nextTurnToMap(turns, new Set())).toBeNull();
  });

  it('skips a failed turn, which has no concepts to find', () => {
    const turns = [turn('a', { status: 'failed', text: '', error: 'the CLI exited' })];

    expect(nextTurnToMap(turns, new Set())).toBeNull();
  });

  it('skips an empty answer rather than spending a run to learn it is empty', () => {
    expect(nextTurnToMap([turn('a', { text: '   ' })], new Set())).toBeNull();
  });

  it('finds a later readable answer past ones it must skip', () => {
    const turns = [turn('a', { status: 'streaming' }), turn('b', { text: '' }), turn('c')];

    expect(nextTurnToMap(turns, new Set())?.id).toBe('c');
  });

  it('returns null for an empty transcript', () => {
    expect(nextTurnToMap([], new Set())).toBeNull();
  });
});

describe('seenTurnIds', () => {
  /*
   * Switching the toggle on is a request about what the author says NEXT.
   * Without this, flipping it mid-conversation fires a proposal per past turn.
   */
  it('marks the whole existing transcript as already read', () => {
    expect(seenTurnIds([turn('a'), turn('b')])).toEqual(new Set(['a', 'b']));
  });

  it('is empty for an empty transcript, so the next answer is read', () => {
    expect(seenTurnIds([]).size).toBe(0);
  });

  it('leaves the next answer readable', () => {
    const existing = [turn('a')];
    const seen = seenTurnIds(existing);

    expect(nextTurnToMap([...existing, turn('b')], seen)?.id).toBe('b');
  });
});
