/**
 * Bridges native menu items to renderer actions.
 *
 * The preload re-emits main's `menu:command` as a DOM event, which keeps the
 * contextBridge surface exactly BrainDumpApi. This hook is the other half of
 * that trade. Both sides read the channel names from one file so they cannot
 * drift apart.
 */

import { useEffect } from 'react';
import { MENU_COMMANDS, MENU_DOM_EVENT, type MenuCommand } from '../../preload/menu-bridge';

export type { MenuCommand };

function readCommand(event: Event): MenuCommand | null {
  const detail = (event as CustomEvent<unknown>).detail;
  if (typeof detail !== 'object' || detail === null) return null;
  const command = (detail as { command?: unknown }).command;
  return MENU_COMMANDS.includes(command as MenuCommand) ? (command as MenuCommand) : null;
}

export function useMenuCommands(handler: (command: MenuCommand) => void): void {
  useEffect(() => {
    const listener = (event: Event): void => {
      const command = readCommand(event);
      if (command) handler(command);
    };
    window.addEventListener(MENU_DOM_EVENT, listener);
    return () => window.removeEventListener(MENU_DOM_EVENT, listener);
  }, [handler]);
}
