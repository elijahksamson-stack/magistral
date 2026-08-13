// @vitest-environment jsdom
/**
 * The review pane.
 *
 * Queried by ACCESSIBLE NAME throughout. Three controls in this app have
 * shipped present-but-invisible — the ✦ menu, the editor's collapse, and the
 * group rename — and each time a test that queried by class or test-id passed
 * while the author could not find the control. If a name cannot be read off
 * the rendered output, a person cannot read it off the screen either.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import MapReview from './MapReview';
import type { ValidatedCompletion } from '../../../shared/types/completion';

const PROPOSAL: ValidatedCompletion = {
  accepted: {
    newNodes: [
      { label: 'Interconnect Queue', kind: 'concept', note: 'The wait to energise.' },
      { label: 'Capacity Ceiling', kind: 'concept' },
    ],
    newEdges: [{ source: 'Interconnect Queue', target: 'Capacity Ceiling', relation: 'causes' }],
    edgeChanges: [],
    groupAdditions: [],
    rationale: 'The map jumps from financing to output with no bottleneck in between.',
  },
  rejected: [
    { kind: 'node', subject: 'EUV', reason: 'a concept with this name already exists' },
  ],
};

function renderReview(overrides: Partial<Parameters<typeof MapReview>[0]> = {}) {
  const onApply = vi.fn();
  const onDismiss = vi.fn();
  render(
    <MapReview
      completion={PROPOSAL}
      isApplying={false}
      onApply={onApply}
      onDismiss={onDismiss}
      {...overrides}
    />,
  );
  return { onApply, onDismiss };
}

describe('showing a proposal', () => {
  it('names every change in a way a person can read', () => {
    renderReview();
    expect(screen.getByRole('checkbox', { name: 'Interconnect Queue' })).toBeTruthy();
    expect(
      screen.getByRole('checkbox', { name: 'Interconnect Queue causes Capacity Ceiling' }),
    ).toBeTruthy();
  });

  it('shows the model’s reasoning', () => {
    renderReview();
    expect(screen.getByText(/jumps from financing to output/)).toBeTruthy();
    expect(screen.getByText('The wait to energise.')).toBeTruthy();
  });

  it('says what was refused instead of quietly showing a shorter list', () => {
    renderReview();
    expect(screen.getByText(/1 change could not be proposed/)).toBeTruthy();
    expect(screen.getByText(/already exists/)).toBeTruthy();
  });

  it('starts with everything checked and offers to add all of it', () => {
    renderReview();
    for (const box of screen.getAllByRole('checkbox')) {
      expect((box as HTMLInputElement).checked).toBe(true);
    }
    expect(screen.getByRole('button', { name: 'Add 3 to the map' })).toBeTruthy();
  });
});

describe('choosing what to accept', () => {
  it('unchecking a concept unchecks the relationship that needs it', () => {
    renderReview();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Capacity Ceiling' }));

    const edge = screen.getByRole('checkbox', {
      name: 'Interconnect Queue causes Capacity Ceiling',
    }) as HTMLInputElement;
    expect(edge.checked).toBe(false);
    expect(screen.getByRole('button', { name: 'Add 1 to the map' })).toBeTruthy();
  });

  it('hands back exactly what is checked', () => {
    const { onApply } = renderReview();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Capacity Ceiling' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 to the map' }));

    const selected = onApply.mock.calls[0]?.[0] as Set<string>;
    expect([...selected]).toEqual(['node:interconnect queue']);
  });

  it('cannot add nothing', () => {
    renderReview();
    fireEvent.click(screen.getByRole('button', { name: 'Select none' }));
    expect(
      (screen.getByRole('button', { name: 'Add 0 to the map' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('discards without applying', () => {
    const { onApply, onDismiss } = renderReview();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onDismiss).toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
  });
});

describe('while applying', () => {
  it('locks both actions so a double click cannot apply twice', () => {
    renderReview({ isApplying: true });
    expect((screen.getByRole('button', { name: 'Adding…' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole('button', { name: 'Discard' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

describe('an empty proposal', () => {
  it('says the map looks complete rather than showing an empty list', () => {
    renderReview({
      completion: {
        accepted: { newNodes: [], newEdges: [], edgeChanges: [], groupAdditions: [] },
        rejected: [],
      },
    });
    expect(screen.getByText(/map looks complete/)).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('explains itself when everything it proposed was refused', () => {
    renderReview({
      completion: {
        accepted: { newNodes: [], newEdges: [], edgeChanges: [], groupAdditions: [] },
        rejected: [{ kind: 'node', subject: 'EUV', reason: 'already exists' }],
      },
    });
    expect(screen.getByText(/Nothing in that proposal could be applied/)).toBeTruthy();
    expect(screen.getByText(/already exists/)).toBeTruthy();
  });
});
