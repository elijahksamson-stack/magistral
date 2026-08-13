// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RenderedTurn } from './chatState';
import MessageList from './MessageList';

const RESPONSE = '## Answer\n\n**Power** binds supply.';

function completedTurn(overrides: Partial<RenderedTurn> = {}): RenderedTurn {
  return {
    id: 'turn-1',
    prompt: 'What binds?',
    askedAt: '2026-08-09T20:00:00.000Z',
    status: 'complete',
    text: RESPONSE,
    error: null,
    usage: null,
    packs: ['mindset/seeing-clearly'],
    provider: 'codex',
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('copy response', () => {
  it('copies the complete raw response with one click and confirms success', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(<MessageList turns={[completedTurn()]} labels={[]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy response' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(RESPONSE));
    expect(screen.getByRole('button', { name: 'Response copied' })).toHaveTextContent('Copied');
  });

  it('waits until streaming finishes before offering the copy action', () => {
    render(<MessageList turns={[completedTurn({ status: 'streaming' })]} labels={[]} />);

    expect(screen.queryByRole('button', { name: 'Copy response' })).toBeNull();
  });
});
