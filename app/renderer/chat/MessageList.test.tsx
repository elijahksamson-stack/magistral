import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { ClaudeUsage } from '../../../shared/types/claude';
import { renderTranscript, type ChatTurn, type ClaudeRunSnapshot } from './chatState';
import MessageList from './MessageList';

const USAGE: ClaudeUsage = {
  inputTokens: 1200,
  outputTokens: 300,
  cacheReadTokens: 8000,
  cacheCreationTokens: 0,
  notionalCostUsd: 0.07,
};

function turn(id: string, prompt: string): ChatTurn {
  return { id, prompt, askedAt: '2026-08-06T12:00:00.000Z' };
}

function run(overrides: Partial<ClaudeRunSnapshot>): ClaudeRunSnapshot {
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

const renderList = (turns: ChatTurn[], runs: Record<string, ClaudeRunSnapshot>) =>
  renderToStaticMarkup(
    <MessageList turns={renderTranscript(turns, runs)} labels={[]} />,
  );

describe('streaming', () => {
  it('renders each delta snapshot in order, extending the previous one', () => {
    const deltas = ['The', 'The binding', 'The binding constraint moves.'];

    const bodies = deltas.map((text, index) => {
      const isLast = index === deltas.length - 1;
      const html = renderList(
        [turn('req-1', 'why?')],
        { 'req-1': run({ text, streaming: !isLast, ...(isLast ? { usage: USAGE } : {}) }) },
      );
      return html;
    });

    expect(bodies[0]).toContain('The');
    expect(bodies[1]).toContain('The binding');
    expect(bodies[2]).toContain('The binding constraint moves.');
    expect(bodies[0]).toContain('data-status="streaming"');
    expect(bodies[2]).toContain('data-status="complete"');
  });

  it('renders turns in the order they were asked', () => {
    const html = renderList(
      [turn('req-1', 'first question'), turn('req-2', 'second question')],
      {
        'req-2': run({ requestId: 'req-2', text: 'answered first', usage: USAGE }),
        'req-1': run({ requestId: 'req-1', text: 'slower', streaming: true }),
      },
    );

    expect(html.indexOf('first question')).toBeLessThan(html.indexOf('second question'));
    expect(html.indexOf('slower')).toBeLessThan(html.indexOf('answered first'));
  });

  it('shows a placeholder before the first delta arrives', () => {
    const html = renderList([turn('req-1', 'why?')], {});
    expect(html).toContain('Waiting for the bridge');
    expect(html).toContain('data-status="pending"');
  });
});

describe('cancelled and failed turns', () => {
  it('marks a cancelled turn as stopped and keeps its partial text', () => {
    const html = renderList(
      [turn('req-1', 'why?')],
      { 'req-1': run({ text: 'The binding const' }) },
    );

    expect(html).toContain('data-status="interrupted"');
    expect(html).toContain('Stopped before finishing');
    expect(html).toContain('The binding const');
  });

  it('shows an error instead of the body when the bridge failed', () => {
    const html = renderList(
      [turn('req-1', 'why?')],
      { 'req-1': run({ error: 'claude was not found on PATH', text: 'ignored' }) },
    );

    expect(html).toContain('claude was not found on PATH');
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('ignored');
  });
});

describe('answer metadata', () => {
  it('keeps internal knowledge-routing details out of the transcript', () => {
    const html = renderList(
      [turn('req-1', 'why?')],
      {
        'req-1': run({
          text: 'answer',
          usage: USAGE,
          packs: ['mindset/seeing-clearly', 'sector/technology/semiconductors#2'],
        }),
      },
    );

    expect(html).not.toContain('Knowledge injected');
    expect(html).not.toContain('mindset/seeing-clearly');
    expect(html).not.toContain('sector/technology/semiconductors#2');
  });

  it('reports tokens, never a price — this rides a subscription', () => {
    const html = renderList([turn('req-1', 'why?')], { 'req-1': run({ text: 'a', usage: USAGE }) });

    expect(html).toContain('1,200 in');
    expect(html).toContain('300 out');
    expect(html).toContain('8,000 cached');
    expect(html).not.toContain('$');
    expect(html).not.toContain('0.07');
    expect(html).toContain('aria-label="Copy response"');
  });
});

describe('node labels', () => {
  it('makes a known label in the answer clickable', () => {
    const html = renderToStaticMarkup(
      <MessageList
        turns={renderTranscript([turn('req-1', 'why?')], {
          'req-1': run({ text: 'HBM supply binds first.', usage: USAGE }),
        })}
        labels={['HBM supply']}
        onSelectLabel={() => undefined}
      />,
    );

    expect(html).toContain('data-node-label="HBM supply"');
  });
});

describe('empty state', () => {
  it('renders the supplied empty state when there are no turns', () => {
    const html = renderToStaticMarkup(
      <MessageList turns={[]} labels={[]} emptyState={<p>Nothing yet</p>} />,
    );

    expect(html).toContain('Nothing yet');
    expect(html).not.toContain('message-list');
  });
});
