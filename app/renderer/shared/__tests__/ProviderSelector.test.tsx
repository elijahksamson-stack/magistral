// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliProviderSnapshot } from '../../../../shared/types/claude';
import type { BrainDumpApi } from '../../../../shared/types/ipc';
import ProviderSelector from '../ProviderSelector';

const BOTH: CliProviderSnapshot = {
  selected: 'auto',
  providers: [
    { id: 'claude', label: 'Claude', available: true, authenticated: true },
    { id: 'codex', label: 'ChatGPT', available: true, authenticated: true },
  ],
};

const invokeMock = vi.fn();

beforeEach(() => {
  invokeMock.mockReset();
  Object.defineProperty(window, 'braindump', {
    configurable: true,
    value: {
      invoke: invokeMock,
      on: vi.fn(() => () => undefined),
      platform: 'darwin',
      appVersion: '0.1.0',
    } satisfies BrainDumpApi,
  });
});

describe('ProviderSelector', () => {
  it('offers every usable detected CLI plus automatic fallback', async () => {
    invokeMock.mockResolvedValue(BOTH);
    render(<ProviderSelector />);

    expect(await screen.findByRole('button', { name: 'Claude' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'ChatGPT' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Auto' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('sends the selected provider to the main process', async () => {
    invokeMock
      .mockResolvedValueOnce(BOTH)
      .mockResolvedValueOnce({ ...BOTH, selected: 'codex' });
    render(<ProviderSelector />);

    fireEvent.click(await screen.findByRole('button', { name: 'ChatGPT' }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenLastCalledWith('llm:select', { provider: 'codex' }),
    );
    expect(screen.getByRole('button', { name: 'ChatGPT' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('shows an explicit empty state when no authenticated CLI is usable', async () => {
    invokeMock.mockResolvedValue({
      selected: 'auto',
      providers: [
        {
          id: 'claude',
          label: 'Claude',
          available: false,
          authenticated: false,
          reason: 'not installed',
        },
        {
          id: 'codex',
          label: 'ChatGPT',
          available: true,
          authenticated: false,
          reason: 'signed out',
        },
      ],
    } satisfies CliProviderSnapshot);
    render(<ProviderSelector />);

    expect(await screen.findByText('No local LLM')).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('can detect silently when unavailable capabilities should disappear', async () => {
    invokeMock.mockResolvedValue({
      selected: 'auto',
      providers: [
        { id: 'claude', label: 'Claude', available: false, authenticated: false },
        { id: 'codex', label: 'ChatGPT', available: false, authenticated: false },
      ],
    } satisfies CliProviderSnapshot);

    render(<ProviderSelector hideWhenUnavailable />);

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('llm:providers', undefined));
    expect(screen.queryByText(/local llm/i)).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
