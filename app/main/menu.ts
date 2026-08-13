/**
 * The native application menu.
 *
 * File items do not reimplement anything: they send a command to the renderer,
 * which runs the same store action the on-screen affordance runs. One code
 * path, so the menu can never drift from the UI.
 *
 * The command travels on its own channel and the preload turns it into a
 * `braindump:menu` DOM CustomEvent — that keeps the contextBridge surface
 * exactly `BrainDumpApi` while still giving the menu a real, whitelisted route
 * into the renderer.
 */

import { Menu, app, shell, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import { MENU_COMMAND_CHANNEL, type MenuCommand } from '../preload/menu-bridge';

const IS_MAC = process.platform === 'darwin';

const DOCS_URL = 'https://github.com/anthropics/claude-code';

export interface MenuDeps {
  readonly getWindow: () => BrowserWindow | null;
}

function send(deps: MenuDeps, command: MenuCommand): void {
  const window = deps.getWindow();
  if (!window || window.isDestroyed()) return;
  window.webContents.send(MENU_COMMAND_CHANNEL, { command });
}

function fileMenu(deps: MenuDeps): MenuItemConstructorOptions {
  return {
    label: 'File',
    submenu: [
      {
        label: 'New Vault',
        accelerator: 'CmdOrCtrl+N',
        click: () => send(deps, 'new-vault'),
      },
      {
        // Vaults are switched from the picker in the header, so "open" had
        // nothing left to do. Bringing a map in from outside does.
        label: 'Import Vault…',
        accelerator: 'CmdOrCtrl+O',
        click: () => send(deps, 'import-vault'),
      },
      { type: 'separator' },
      {
        label: 'Save',
        accelerator: 'CmdOrCtrl+S',
        click: () => send(deps, 'save-vault'),
      },
      { type: 'separator' },
      {
        label: 'Export Knowledge Map…',
        accelerator: 'CmdOrCtrl+Shift+E',
        click: () => send(deps, 'export-yaml'),
      },
      { type: 'separator' },
      IS_MAC ? { role: 'close' } : { role: 'quit' },
    ],
  };
}

function appMenu(): MenuItemConstructorOptions[] {
  if (!IS_MAC) return [];
  return [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
  ];
}

export function buildMenuTemplate(deps: MenuDeps): MenuItemConstructorOptions[] {
  return [
    ...appMenu(),
    fileMenu(deps),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: IS_MAC
        ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
        : [{ role: 'minimize' }, { role: 'close' }],
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'Claude Code Documentation',
          click: () => {
            void shell.openExternal(DOCS_URL);
          },
        },
      ],
    },
  ];
}

export function installApplicationMenu(deps: MenuDeps): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate(deps)));
}
