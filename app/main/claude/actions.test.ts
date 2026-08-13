/**
 * Every cell action must be wired end to end.
 *
 * Written after a real failure: `distill-import` was added to the CellAction
 * union, given a prompt, a merge mode, a label and a system-prompt file — but
 * left out of CELL_ACTIONS, which is the list the IPC boundary validates
 * against. Every layer typechecked, and the feature failed at runtime with
 * 'claude:invoke: "action" is not a known cell action'.
 *
 * The union is the source of truth here. These tests enumerate it and demand
 * that each layer knows about every member, so the next action added cannot
 * ship half-wired.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CELL_ACTIONS,
  CELL_ACTION_LABELS,
  MENU_CELL_ACTIONS,
  type CellAction,
} from '../../../shared/types/claude';
import { isCellAction } from '../guards';
import { CELL_ACTION_MERGE_MODES } from '../../renderer/editor/stream-preview';

/**
 * The union, written out by hand.
 *
 * Deliberately NOT derived from CELL_ACTIONS — that is one of the lists under
 * test, and deriving from it would make the test pass by construction. Adding
 * a member to CellAction without adding it here is a compile error, because
 * the satisfies clause below requires exhaustiveness.
 */
const ALL_ACTIONS = [
  'enhance',
  'continue',
  'critique',
  'distill',
  'distill-import',
] as const satisfies readonly CellAction[];

/** Compile-time exhaustiveness: fails to build if the union grows past the list. */
type Missing = Exclude<CellAction, (typeof ALL_ACTIONS)[number]>;
const _exhaustive: Missing extends never ? true : never = true;
void _exhaustive;

const SYSTEM_PROMPT_DIR = path.resolve(__dirname, '../../../resources/knowledge/_system');

describe('every cell action is fully wired', () => {
  it.each(ALL_ACTIONS)('%s passes IPC validation', (action) => {
    // The exact check that rejected distill-import in production.
    expect(isCellAction(action)).toBe(true);
  });

  it.each(ALL_ACTIONS)('%s is listed in CELL_ACTIONS', (action) => {
    expect(CELL_ACTIONS).toContain(action);
  });

  it.each(ALL_ACTIONS)('%s has a human-facing label', (action) => {
    expect(CELL_ACTION_LABELS[action]).toBeTruthy();
  });

  it.each(ALL_ACTIONS)('%s has a merge mode', (action) => {
    expect(CELL_ACTION_MERGE_MODES[action]).toBeTruthy();
  });

  it.each(ALL_ACTIONS)('%s has a system prompt file on disk', (action) => {
    // The bridge resolves _system/<action>.md; a missing file degrades the
    // output silently rather than failing loudly, so assert it exists.
    expect(existsSync(path.join(SYSTEM_PROMPT_DIR, `${action}.md`))).toBe(true);
  });

  it('offers only document-free actions in the ✦ menu', () => {
    // distill-import needs a file, so it cannot be launched from a cell menu.
    expect(MENU_CELL_ACTIONS).not.toContain('distill-import');
    for (const action of MENU_CELL_ACTIONS) {
      expect(CELL_ACTIONS).toContain(action);
    }
  });

  it('rejects an action that is not in the union', () => {
    expect(isCellAction('summarise')).toBe(false);
    expect(isCellAction('')).toBe(false);
    expect(isCellAction(undefined)).toBe(false);
  });
});
