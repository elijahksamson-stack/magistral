/**
 * The contextBridge surface — exactly `BrainDumpApi`, nothing more.
 *
 * `ipcRenderer` itself is never exposed. Both directions are whitelisted:
 * `invoke` only forwards channels present in IpcInvokeMap, and `on` only
 * subscribes to channels present in IpcEventMap. A renderer bug — or a
 * compromised renderer — therefore cannot reach a channel this file does not
 * name.
 *
 * The menu's `menu:command` is deliberately NOT part of the exposed object. It
 * is re-emitted as a `braindump:menu` DOM CustomEvent so the shell can listen
 * for it without widening the API contract.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { MENU_COMMAND_CHANNEL, MENU_DOM_EVENT } from './menu-bridge';
import type {
  BrainDumpApi,
  IpcEventChannel,
  IpcEventMap,
  IpcInvokeChannel,
  IpcRequest,
  IpcResponse,
} from '../../shared/types/ipc';

/**
 * Every invoke channel, written out.
 *
 * `satisfies` rather than a type ANNOTATION, because `readonly
 * IpcInvokeChannel[]` accepts a SUBSET — which is how `graph:set-node-note`
 * shipped in the contract, the handler and the renderer client but not here,
 * and only announced itself at runtime as "Blocked IPC invoke on unknown
 * channel". The exhaustiveness check below now makes that a build error.
 */
const INVOKE_CHANNELS = [
  'vault:list',
  'vault:create',
  'vault:open',
  'vault:save',
  'vault:delete',
  'vault:rename',
  'cell:upsert',
  'cell:remove',
  'cell:reorder',
  'graph:add-node',
  'graph:set-node-label',
  'graph:set-node-group',
  'graph:remove-node',
  'graph:add-edge',
  'graph:remove-edge',
  'graph:set-edge-note',
  'graph:set-node-note',
  'graph:snapshot',
  'graph:replace',
  'graph:set-name',
  'layout:configure',
  'layout:tick',
  'layout:settle',
  'layout:pin',
  'layout:unpin',
  'layout:reset',
  'layout:node-order',
  'graph:compute-metrics',
  'graph:components',
  'graph:shortest-path',
  'graph:backlinks',
  'graph:search',
  'export:yaml',

  'import:yaml',
  'import:document',
  'import:folder',
  'image:attach',
  'image:read',
  'claude:invoke',
  'claude:cancel',
  'claude:active',
  'claude:health',
  'llm:providers',
  'llm:select',
] as const satisfies readonly IpcInvokeChannel[];

const EVENT_CHANNELS = [
  'claude:stream',
  'vault:dirty',
  'app:error',
  'window:fullscreen',
] as const satisfies readonly IpcEventChannel[];

/**
 * Compile-time exhaustiveness.
 *
 * A channel added to IpcInvokeMap but not listed above makes `Missing…`
 * something other than `never`, and the assignment below fails to build. The
 * contract's promise — "adding a channel without implementing it is a compile
 * error" — held for the main process and silently did not hold here.
 */
type MissingInvokeChannel = Exclude<IpcInvokeChannel, (typeof INVOKE_CHANNELS)[number]>;
type MissingEventChannel = Exclude<IpcEventChannel, (typeof EVENT_CHANNELS)[number]>;

const _invokeExhaustive: MissingInvokeChannel extends never ? true : never = true;
const _eventExhaustive: MissingEventChannel extends never ? true : never = true;
void _invokeExhaustive;
void _eventExhaustive;

const invokeAllowed = new Set<string>(INVOKE_CHANNELS);
const eventAllowed = new Set<string>(EVENT_CHANNELS);

const api: BrainDumpApi = {
  invoke<C extends IpcInvokeChannel>(channel: C, payload: IpcRequest<C>): Promise<IpcResponse<C>> {
    if (!invokeAllowed.has(channel)) {
      return Promise.reject(new Error(`Blocked IPC invoke on unknown channel: ${String(channel)}`));
    }
    return ipcRenderer.invoke(channel, payload) as Promise<IpcResponse<C>>;
  },

  on<C extends IpcEventChannel>(channel: C, listener: (payload: IpcEventMap[C]) => void): () => void {
    if (!eventAllowed.has(channel)) {
      throw new Error(`Blocked IPC subscription on unknown channel: ${String(channel)}`);
    }
    const wrapped = (_event: IpcRendererEvent, payload: IpcEventMap[C]): void => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  },

  platform: process.platform,
  // Set by the main process before the window is created — a sandboxed preload
  // cannot call app.getVersion() itself.
  appVersion: process.env.BRAINDUMP_APP_VERSION ?? '0.0.0',
};

/**
 * Menu commands become a DOM event rather than a new API method, which keeps
 * the exposed object identical to the BrainDumpApi contract.
 */
ipcRenderer.on(MENU_COMMAND_CHANNEL, (_event: IpcRendererEvent, payload: unknown) => {
  window.dispatchEvent(new CustomEvent(MENU_DOM_EVENT, { detail: payload }));
});

contextBridge.exposeInMainWorld('braindump', api);
