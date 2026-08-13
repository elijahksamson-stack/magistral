/**
 * The renderer's only door to the main process.
 *
 * Nothing in app/renderer/ touches `window.braindump` directly — it goes
 * through here so a missing preload produces one readable message instead of
 * `Cannot read properties of undefined` in a dozen places.
 */

import type { BrainDumpApi, IpcInvokeChannel, IpcRequest, IpcResponse } from '../../../shared/types/ipc';

const MISSING_PRELOAD =
  'The Magistral bridge is unavailable — the preload script did not load. Restart the app.';

export function getApi(): BrainDumpApi {
  const api = window.braindump;
  if (!api) throw new Error(MISSING_PRELOAD);
  return api;
}

export function hasApi(): boolean {
  return typeof window !== 'undefined' && Boolean(window.braindump);
}

export function invoke<C extends IpcInvokeChannel>(
  channel: C,
  payload: IpcRequest<C>,
): Promise<IpcResponse<C>> {
  return getApi().invoke(channel, payload);
}

/** Narrow anything thrown by an IPC round-trip to a message worth showing. */
export function toMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    // Electron prefixes rejections with "Error invoking remote method '…':".
    return error.message.replace(/^Error invoking remote method '[^']*':\s*/, '');
  }
  if (typeof error === 'string' && error.length > 0) return error;
  return 'Unexpected error';
}
