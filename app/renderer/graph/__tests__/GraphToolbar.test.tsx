// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { NODE_KINDS, RELATION_KINDS } from '../../../../shared/types/graph';
import { RELATION_COLORS } from '../constants';
import GraphToolbar from '../GraphToolbar';

function renderToolbar(overrides: Partial<React.ComponentProps<typeof GraphToolbar>> = {}) {
  const props: React.ComponentProps<typeof GraphToolbar> = {
    focusOnly: false,
    hasFocus: false,
    isFlowing: false,
    onFlowingChange: vi.fn(),
    connectMode: false,
    nodeKinds: new Set(NODE_KINDS),
    relations: new Set(RELATION_KINDS),
    presentRelations: [],
    connectionScope: 'subnode-subnode',
    onFocusOnlyChange: vi.fn(),
    onConnectModeChange: vi.fn(),
    onOpenConnectionBuilder: vi.fn(),
    onFindConnections: vi.fn(),
    onToggleNodeKind: vi.fn(),
    onToggleRelation: vi.fn(),
    onConnectionScopeChange: vi.fn(),
    onReset: vi.fn(),
    ...overrides,
  };
  render(<GraphToolbar {...props} />);
  return props;
}

describe('GraphToolbar connection levels', () => {
  it('shows the active level and asks discovery for that exact scope', () => {
    const props = renderToolbar();

    expect(screen.getByLabelText('Connection level view')).toHaveValue('subnode-subnode');
    fireEvent.click(screen.getByRole('button', { name: /find relationships/i }));

    expect(props.onFindConnections).toHaveBeenCalledWith('subnode-subnode');
  });

  it('opens the endpoint builder as the easy manual path', () => {
    const props = renderToolbar({ connectionScope: 'all' });

    fireEvent.click(screen.getByRole('button', { name: /^add relationship$/i }));

    expect(props.onOpenConnectionBuilder).toHaveBeenCalledOnce();
    expect(props.onConnectModeChange).not.toHaveBeenCalled();
  });
});

/** Reading the map: which colour on the canvas means which relationship. */
describe('GraphToolbar relationship legend', () => {
  function legendEntries(): string[] {
    const heading = screen.queryByText(/relationships on this map/i);
    if (!heading) return [];
    return [...(heading.parentElement?.querySelectorAll('span') ?? [])]
      .map((entry) => entry.textContent?.trim() ?? '')
      .filter((text) => text.length > 0);
  }

  it('lists only the relations the map actually uses', () => {
    renderToolbar({ presentRelations: ['causes', 'supports'] });

    const entries = legendEntries();
    expect(entries).toContain('causes');
    expect(entries).toContain('supports');
    // The whole point: a map with two relation kinds does not print ten rows.
    expect(entries).not.toContain('contradicts');
    expect(entries).not.toContain('relates to');
  });

  it('shows each relation in the colour the canvas draws it', () => {
    renderToolbar({ presentRelations: ['contradicts'] });

    const swatch = screen
      .getByText(/relationships on this map/i)
      .parentElement?.querySelector('i[class*="legendEdge"]');

    expect(swatch).toBeTruthy();
    expect((swatch as HTMLElement).style.background).toBe(
      hexToRgb(RELATION_COLORS.contradicts),
    );
  });

  it('says nothing at all when the map has no relationships yet', () => {
    renderToolbar({ presentRelations: [] });

    expect(screen.queryByText(/relationships on this map/i)).toBeNull();
  });
});

/** jsdom normalises inline colours to rgb(), so the expectation must too. */
function hexToRgb(hex: string): string {
  const value = hex.replace('#', '');
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `rgb(${r}, ${g}, ${b})`;
}
