/**
 * Where things live, in dev and in a packaged .app.
 *
 * Kept separate from index.ts so the resolution rules are readable on their own
 * — they are the thing most likely to differ between the two, and the thing
 * most annoying to debug when they do.
 */

import path from 'node:path';
import { app } from 'electron';

const NATIVE_ADDON_FILE = 'braindump.node';

export interface AppPaths {
  readonly vaultsDir: string;
  readonly knowledgeDir: string;
  readonly addonCandidates: readonly string[];
}

export function resolveAppPaths(): AppPaths {
  const isPackaged = app.isPackaged;
  const appPath = app.getAppPath();
  // In a packaged app, appPath is .../Resources/app.asar; its parent holds
  // extraResources. In dev it is the repo root.
  const projectRoot = isPackaged ? path.dirname(appPath) : appPath;

  return {
    vaultsDir: path.join(app.getPath('userData'), 'vaults'),
    knowledgeDir: isPackaged
      ? path.join(process.resourcesPath, 'knowledge')
      : path.join(projectRoot, 'resources', 'knowledge'),
    addonCandidates: [
      // A .node file cannot be loaded from inside an asar, so the unpacked
      // copy is tried first in a packaged build. This needs
      // build.asarUnpack: ["build/Release/*.node"] in package.json — see the
      // note in this agent's handover.
      path.join(`${appPath}.unpacked`, 'build', 'Release', NATIVE_ADDON_FILE),
      path.join(projectRoot, 'build', 'Release', NATIVE_ADDON_FILE),
      path.join(projectRoot, 'build', 'Debug', NATIVE_ADDON_FILE),
      path.join(appPath, 'build', 'Release', NATIVE_ADDON_FILE),
    ],
  };
}
