// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { NODE_KINDS, RELATION_KINDS } from '../../../../shared/types/graph';
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
