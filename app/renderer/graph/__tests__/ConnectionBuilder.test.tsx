// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import ConnectionBuilder from '../ConnectionBuilder';
import type { ConnectionEndpoint } from '../connectionTypes';

const ENDPOINTS: ConnectionEndpoint[] = [
  { id: 'n1', label: 'Alpha', kind: 'node', parentIds: [], parentLabels: [], isVirtual: false },
  { id: 'n2', label: 'Beta', kind: 'node', parentIds: [], parentLabels: [], isVirtual: false },
  {
    id: 's1',
    label: 'Alpha facet',
    kind: 'subnode',
    parentIds: ['n1'],
    parentLabels: ['Alpha'],
    isVirtual: true,
  },
  {
    id: 's2',
    label: 'Beta facet',
    kind: 'subnode',
    parentIds: ['n2'],
    parentLabels: ['Beta'],
    isVirtual: true,
  },
];

describe('ConnectionBuilder', () => {
  it('creates a subnode connection across different parents without expanding either one', () => {
    const onConnect = vi.fn();
    render(
      <ConnectionBuilder
        endpoints={ENDPOINTS}
        initialScope="subnode-subnode"
        onConnect={onConnect}
        onPickOnCanvas={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('From endpoint'), { target: { value: 's1' } });
    fireEvent.change(screen.getByLabelText('To endpoint'), { target: { value: 's2' } });
    fireEvent.click(screen.getByRole('button', { name: /choose relationship/i }));

    expect(onConnect).toHaveBeenCalledWith('s1', 's2');
    expect(screen.getAllByText(/Alpha facet — subnode under Alpha/i)).toHaveLength(2);
    expect(screen.getAllByText(/Beta facet — subnode under Beta/i)).toHaveLength(2);
  });
});
