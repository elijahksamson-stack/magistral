// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import RelationPicker from '../RelationPicker';

describe('creating a cross-level relationship', () => {
  it('shows endpoint levels and submits the explanation with the relation', () => {
    const onPick = vi.fn();
    render(
      <RelationPicker
        sourceLabel="Financing"
        targetLabel="Power demand"
        sourceKind="group"
        targetKind="subnode"
        promotesTarget
        x={0}
        y={0}
        onPick={onPick}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText('group')).toBeTruthy();
    expect(screen.getByText('subnode')).toBeTruthy();
    expect(screen.getByText(/without moving it out from under the parent/i)).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/how do they cross-connect/i), {
      target: { value: 'Financing terms determine whether capacity can be built.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /affects/i }));

    expect(onPick).toHaveBeenCalledWith(
      'affects',
      'Financing terms determine whether capacity can be built.',
    );
  });
});
