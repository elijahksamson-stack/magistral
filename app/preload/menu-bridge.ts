/**
 * The menu's route from main to renderer, defined once.
 *
 * It lives in app/preload/ because the preload IS this boundary: main sends on
 * `MENU_COMMAND_CHANNEL`, the preload re-emits as the `MENU_DOM_EVENT` DOM
 * event, and the renderer listens for that. Keeping the two names in one file
 * means a rename cannot desynchronise the three sides.
 *
 * The indirection buys something specific: the menu never becomes a method on
 * the exposed API object, so `window.braindump` stays exactly `BrainDumpApi`.
 *
 * This module imports nothing. It is safe in the main, preload and renderer
 * bundles alike.
 */

export const MENU_COMMAND_CHANNEL = 'menu:command';

export const MENU_DOM_EVENT = 'braindump:menu';

export type MenuCommand =
  | 'new-vault'
  /**
   * Bring an exported knowledge map in as a new vault. Replaced 'open-vault',
   * which had nothing left to do once vaults were switched from the header.
   */
  | 'import-vault'
  | 'save-vault'
  | 'export-yaml';

export const MENU_COMMANDS: readonly MenuCommand[] = [
  'new-vault',
  'import-vault',
  'save-vault',
  'export-yaml',
] as const;
