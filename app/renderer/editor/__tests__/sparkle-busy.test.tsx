// @vitest-environment jsdom
/**
 * The ✦ button while a run is in flight.
 *
 * The behaviour under test is that "busy" is PER CELL. Several cells can have
 * Claude working on them at once, and each has to say so on its own — a single
 * app-wide indicator would claim every cell was busy when one was, and
 * disabling every ✦ would make the second request impossible to start.
 *
 * Queried by accessible name, not by class: the aria-label is what tells a
 * person which cell is working, and it has to change with the state.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import SparkleMenu from '../SparkleMenu';

function renderPair(states: readonly boolean[]) {
  render(
    <>
      {states.map((isBusy, index) => (
        <SparkleMenu
          key={index}
          isOpen={false}
          isBusy={isBusy}
          hasSelection={false}
          onToggle={vi.fn()}
          onClose={vi.fn()}
          onChoose={vi.fn()}
        />
      ))}
    </>,
  );
}

const IDLE = 'Claude actions for this cell';
const BUSY = 'Claude is working';

describe('an idle cell', () => {
  it('offers its actions and carries no animation', () => {
    renderPair([false]);
    const button = screen.getByRole('button', { name: IDLE });

    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(button.className).not.toMatch(/busy/);
  });
});

describe('a cell with a run in flight', () => {
  it('animates and says what it is doing', () => {
    renderPair([true]);
    const button = screen.getByRole('button', { name: BUSY });

    // The class is what carries the spin and the breathing edge.
    expect(button.className).toMatch(/busy/);
    // Motion is decoration; the label and the disabled state carry the meaning.
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute('title')).toMatch(/working on this cell/i);
  });

  it('does not open its menu — the run owns the cell until it settles', () => {
    renderPair([true]);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('several cells at once', () => {
  it('animates only the ones that are actually working', () => {
    // Two busy, one idle. This is the case a global busy flag gets wrong.
    renderPair([true, false, true]);

    expect(screen.getAllByRole('button', { name: BUSY })).toHaveLength(2);

    const idle = screen.getByRole('button', { name: IDLE });
    expect(idle.className).not.toMatch(/busy/);
    // The idle cell must stay clickable, or a second run could never be started
    // while a first one was going.
    expect((idle as HTMLButtonElement).disabled).toBe(false);
  });

  it('leaves every cell still when none is working', () => {
    renderPair([false, false]);
    for (const button of screen.getAllByRole('button', { name: IDLE })) {
      expect(button.className).not.toMatch(/busy/);
    }
  });
});
