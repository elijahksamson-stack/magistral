/**
 * Main process entry point — window lifecycle and wiring.
 *
 * Security posture, non-negotiable: contextIsolation on, nodeIntegration off,
 * sandbox on, and no remote content ever loaded. The renderer's only route to
 * the outside is the preload's whitelisted contextBridge surface.
 *
 * The window is created hidden with a #0d0d0f backgroundColor and shown on
 * `ready-to-show`, so a dark app never opens with a white flash.
 */

import path from 'node:path';
import { BrowserWindow, app, shell } from 'electron';
import { DEFAULT_BRIDGE_CONFIG } from '../../shared/types/claude';
import { ClaudeBridge, type ClaudeBridgeRuntimeConfig } from './claude/bridge';
import { buildMapSnapshot } from './claude/mapSnapshot';
import { resolveClaudeBinary, resolveCodexBinary } from './claude/health';
import { GraphService } from './graph-service';
import { registerIpcHandlers, sendEvent } from './ipc';
import { createLogger, errorMessage } from './logger';
import { installApplicationMenu } from './menu';
import { resolveAppPaths } from './paths';
import { FileVaultStorage } from './vault';

const log = createLogger('main');

const BACKGROUND_COLOR = '#0d0d0f';
const MIN_WIDTH = 900;
const MIN_HEIGHT = 600;
const DEFAULT_WIDTH = 1440;
const DEFAULT_HEIGHT = 900;

let mainWindow: BrowserWindow | null = null;
let bridge: ClaudeBridge | null = null;

function getWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    backgroundColor: BACKGROUND_COLOR,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true,
    },
  });

  const reportFullScreen = (): void => {
    sendEvent(window, 'window:fullscreen', { fullScreen: window.isFullScreen() });
  };

  window.once('ready-to-show', () => {
    window.show();
    reportFullScreen();
  });
  window.on('enter-full-screen', reportFullScreen);
  window.on('leave-full-screen', reportFullScreen);

  // Nothing in this app opens a second window or navigates away.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event) => event.preventDefault());

  window.webContents.on('render-process-gone', (_event, details) => {
    log.error('renderer process gone', details.reason);
  });

  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  const loading = devServerUrl
    ? window.loadURL(devServerUrl)
    : window.loadFile(path.join(__dirname, '../renderer/index.html'));

  loading.catch((error: unknown) => log.error('failed to load renderer', error));

  window.on('closed', () => {
    mainWindow = null;
  });

  return window;
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

async function buildBridgeConfig(
  knowledgeDir: string,
  vaultDir: string,
): Promise<ClaudeBridgeRuntimeConfig> {
  const [claudeBinaryPath, codexBinaryPath] = await Promise.all([
    resolveClaudeBinary(),
    resolveCodexBinary(),
  ]);
  log.info('CLI provider chain configured', {
    claude: claudeBinaryPath ?? 'not found',
    codex: codexBinaryPath ?? 'not found',
  });
  return {
    ...DEFAULT_BRIDGE_CONFIG,
    binaryPath: claudeBinaryPath ?? 'claude',
    claudeAvailable: claudeBinaryPath !== null,
    ...(codexBinaryPath ? { codexBinaryPath } : {}),
    knowledgeDir,
    vaultDir,
  };
}

async function bootstrap(): Promise<void> {
  // A sandboxed preload cannot reach `app`, so hand it the version this way.
  process.env.BRAINDUMP_APP_VERSION = app.getVersion();

  const paths = resolveAppPaths();
  const vaults = new FileVaultStorage(paths.vaultsDir);
  const graphs = new GraphService(paths.addonCandidates);

  bridge = new ClaudeBridge(
    await buildBridgeConfig(paths.knowledgeDir, paths.vaultsDir),
    (event) => sendEvent(getWindow(), 'claude:stream', event),
    {
      // Read from the core on demand, not captured once: "Complete the map"
      // must see the graph as it is when the author clicks, and its proposal
      // must be checked against that same graph.
      getMap: () => buildMapSnapshot(graphs.snapshot()),
    },
  );

  registerIpcHandlers({
    vaults,
    graphs,
    bridge,
    getWindow,
    markDirty: () => sendEvent(getWindow(), 'vault:dirty', { dirty: true }),
    onVaultOpened: (vaultId) => {
      bridge?.updateConfig({ vaultDir: vaults.directoryFor(vaultId) });
      sendEvent(getWindow(), 'vault:dirty', { dirty: false });
    },
  });

  installApplicationMenu({ getWindow });
  mainWindow = createWindow();

  const status = graphs.status();
  if (!status.ready) {
    // Degraded, not dead: the window is up and says exactly what to do next.
    mainWindow.webContents.once('did-finish-load', () => {
      sendEvent(getWindow(), 'app:error', {
        message: 'The Magistral native core is unavailable.',
        detail: status.reason ?? 'Unknown reason.',
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const window = getWindow();
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  app
    .whenReady()
    .then(bootstrap)
    .catch((error: unknown) => log.error('startup failed', errorMessage(error)));

  app.on('window-all-closed', () => {
    // Standard macOS behaviour: the app stays resident with no windows.
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });

  app.on('before-quit', () => {
    // No spawned `claude` may outlive the app.
    bridge?.disposeAll();
  });
}

process.on('uncaughtException', (error: unknown) => {
  log.error('uncaught exception in main', error);
  sendEvent(getWindow(), 'app:error', {
    message: 'Magistral hit an unexpected error.',
    detail: errorMessage(error),
  });
});

process.on('unhandledRejection', (reason: unknown) => {
  log.error('unhandled rejection in main', reason);
});
