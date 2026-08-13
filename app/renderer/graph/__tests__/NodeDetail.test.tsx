// @vitest-environment jsdom
/**
 * The group panel's controls must be findable BY NAME.
 *
 * Rename shipped as a small pencil glyph at low opacity beside the close
 * button and was reported as missing — the third control in this app to be
 * present, working, and invisible. Querying by accessible name is the closest
 * a test gets to "could a person find this".
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import NodeDetail from '../NodeDetail';
import type { GraphNode } from '../../../../shared/types/graph';

function node(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: 'g1',
    label: 'AI Investing',
    normalizedLabel: 'ai investing',
    kind: 'group',
    cellIds: [],
    x: 0,
    y: 0,
    pinned: false,
    degree: 0,
    centrality: 0,
    cluster: 0,
    ...overrides,
  } as GraphNode;
}

function renderPanel(overrides: Partial<Parameters<typeof NodeDetail>[0]> = {}) {
  const props = {
    node: node(),
    edges: [],
    allNodes: [node()],
    labelOf: (id: string) => id,
    onOpenCell: vi.fn(),
    onSelectNode: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    onWriteCell: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<NodeDetail {...props} />);
  return props;
}

describe('the group panel', () => {
  it('offers rename and delete as named controls', () => {
    renderPanel();
    expect(screen.getByRole('button', { name: /rename group/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /delete group/i })).toBeInTheDocument();
  });

  it('renames on submit', async () => {
    const user = userEvent.setup();
    const props = renderPanel();

    await user.click(screen.getByRole('button', { name: /rename group/i }));
    const field = screen.getByRole('textbox', { name: /group name/i });
    await user.clear(field);
    await user.type(field, 'AI Economy{Enter}');

    expect(props.onRename).toHaveBeenCalledWith('AI Economy');
  });

  it('does not rename to an empty name', async () => {
    const user = userEvent.setup();
    const props = renderPanel();

    await user.click(screen.getByRole('button', { name: /rename group/i }));
    const field = screen.getByRole('textbox', { name: /group name/i });
    await user.clear(field);
    await user.type(field, '   {Enter}');

    // Blank would leave the group unlabelled on the canvas.
    expect(props.onRename).not.toHaveBeenCalled();
  });

  it('confirms before deleting, and says what happens to members', async () => {
    const user = userEvent.setup();
    const members = [node({ id: 'n1', label: 'EUV', kind: 'concept', groupId: 'g1' })];
    const props = renderPanel({ allNodes: [node(), ...members] });

    await user.click(screen.getByRole('button', { name: /delete group/i }));
    expect(props.onDelete).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toHaveTextContent(/member.*stay in the graph/i);

    await user.click(screen.getByRole('button', { name: /^delete group$/i }));
    expect(props.onDelete).toHaveBeenCalled();
  });

  it('can back out of a delete', async () => {
    const user = userEvent.setup();
    const props = renderPanel();

    await user.click(screen.getByRole('button', { name: /delete group/i }));
    await user.click(screen.getByRole('button', { name: /cancel/i }));

    expect(props.onDelete).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('offers neither control on an ordinary concept', () => {
    // A concept's name IS its [[wikilink]], and it is removed by deleting that
    // link. A second route here would leave the text and the graph disagreeing.
    renderPanel({ node: node({ kind: 'concept', label: 'EUV' }) });

    expect(screen.queryByRole('button', { name: /rename group/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete group/i })).not.toBeInTheDocument();
  });

  it('does not tell a group to add [[links]] to a cell it does not have', () => {
    renderPanel();
    expect(screen.queryByText(/add more/i)).not.toBeInTheDocument();
  });
});

/**
 * A concept with no cell is the one state this app cannot otherwise escape.
 *
 * Editing and deleting a concept both go through the cell whose [[wikilink]]
 * asserts it. When no cell does, the Editor cannot list it and the panel offers
 * no delete — the node is stranded. Reported as "I can't edit or delete the
 * financing and capex nodes". Writing the missing cell puts it back on the
 * normal route rather than adding a second one.
 */
describe('a concept with no cell', () => {
  const orphan = () => node({ id: 'n129', label: 'AI Financing', kind: 'concept', cellIds: [] });

  it('says so, and offers to write the cell', () => {
    renderPanel({ node: orphan() });

    expect(screen.getByRole('button', { name: /write its cell/i })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/no cell/i);
  });

  it('writes the cell when asked', async () => {
    const user = userEvent.setup();
    const props = renderPanel({ node: orphan() });

    await user.click(screen.getByRole('button', { name: /write its cell/i }));

    expect(props.onWriteCell).toHaveBeenCalledTimes(1);
  });

  it('says nothing on a concept that already has one', () => {
    renderPanel({ node: node({ kind: 'concept', label: 'EUV', cellIds: ['c1'] }) });

    expect(screen.queryByRole('button', { name: /write its cell/i })).not.toBeInTheDocument();
  });

  it('says nothing on a group, which is never meant to have one', () => {
    // A group is authored by the ✦ panel, not by a cell. Offering to write it
    // one would manufacture the very orphan-shaped confusion this fixes.
    renderPanel({ node: node({ kind: 'group' }) });

    expect(screen.queryByRole('button', { name: /write its cell/i })).not.toBeInTheDocument();
  });

  it('does not tell it to add [[links]] to the cell it does not have', () => {
    renderPanel({ node: orphan() });
    expect(screen.queryByText(/add more/i)).not.toBeInTheDocument();
  });
});

describe('authored subnodes', () => {
  it('opens a child as its own focused detail target', async () => {
    const user = userEvent.setup();
    const child = { label: 'Power demand', note: 'Grid capacity constrains deployment.' };
    const onSelectSubnode = vi.fn();
    renderPanel({
      node: node({ kind: 'concept', cellIds: ['c1'], subConcepts: [child] }),
      onSelectSubnode,
    });

    await user.click(screen.getByRole('button', { name: /open power demand subnode/i }));
    expect(onSelectSubnode).toHaveBeenCalledWith(child);
  });
});
