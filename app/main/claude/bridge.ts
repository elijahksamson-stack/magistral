/**
 * The Claude CLI bridge — spawns the LOCAL `claude` binary, one child per
 * request, and turns its stream-json output into ClaudeStreamEvents.
 *
 * Three invariants this file defends:
 *   1. The child environment never carries ANTHROPIC_API_KEY or any other key
 *      in STRIPPED_ENV_KEYS. See ./env.ts — a leak silently moves billing off
 *      the subscription and onto API credits.
 *   2. `--dangerously-skip-permissions` is never passed. The child gets
 *      read-only tools and --add-dir scoped to knowledge + vault.
 *   3. Nothing unvalidated reaches the graph. A "Complete the map" reply is
 *      parsed and permission-checked into a PROPOSAL; the author applies it.
 *
 * Electron is deliberately not imported here: the bridge takes a config and an
 * emit callback, which is what makes it unit-testable with an injected spawn.
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  ClaudeBridgeConfig,
  ClaudeErrorCode,
  ClaudeInvokeRequest,
  ClaudeStreamEvent,
  ClaudeUsage,
  CliProvider,
  CliProviderSelection,
  CliProviderSnapshot,
} from '../../../shared/types/claude';
import type { MapSnapshot } from '../../../shared/types/completion';
import { createLogger, errorMessage } from '../logger';
import { buildClaudeArgs } from './args';
import {
  buildCodexArgs,
  interpretCodex,
  isClaudeAllowanceLimit,
  isCodexSessionId,
  tagCodexSessionId,
  unwrapCodexSessionId,
  type CodexSignal,
} from './codex';
import {
  buildChildEnv,
  buildCodexChildEnv,
  hasBillingLeak,
  hasCodexBillingLeak,
} from './env';
import { checkCodexSubscription } from './health';
import {
  CliProviderRegistry,
  type ProviderDetector,
} from './providers';
import { parseCompletion, validateCompletion } from './completion';
import { NdjsonParser, type NdjsonLine } from './ndjson';
import { loadKnowledgeIndex, renderSections, selectSections, type PackSelection } from './packs';
import { buildPrompt, requestRoutingText } from './prompt';
import { EMPTY_USAGE, interpret, readAssistantText, type StreamSignal } from './stream-events';

/** The `result` arm of StreamSignal — the record that ends a run. */
type ResultSignal = Extract<StreamSignal, { kind: 'result' }>;

const log = createLogger('claude-bridge');

/** How long a SIGTERM'd child gets to exit before SIGKILL. */
export const KILL_GRACE_MS = 4_000;

/**
 * Absolute ceiling on one invocation, regardless of activity.
 *
 * Generous: the idle timer is what catches a genuinely stuck process, and this
 * only exists so a pathological one cannot run until the app quits.
 */
export const HARD_TIMEOUT_MS = 20 * 60_000;

const SYSTEM_PROMPT_DIR = '_system';

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export type EmitFn = (event: ClaudeStreamEvent) => void;

/** Runtime-only executable paths resolved before the first provider refresh. */
export interface ClaudeBridgeRuntimeConfig extends ClaudeBridgeConfig {
  /** False when startup positively established that Claude is absent. */
  readonly claudeAvailable?: boolean;
  /** A detected local Codex CLI; subscription auth is rechecked before use. */
  readonly codexBinaryPath?: string;
}

export interface ClaudeBridgeDeps {
  readonly spawn?: SpawnFn;
  /** Source environment the child env is derived from. Defaults to process.env. */
  readonly sourceEnv?: NodeJS.ProcessEnv;
  /**
   * The current graph, for "Complete the map".
   *
   * A callback rather than a constructor argument because the graph changes
   * under the bridge every time the author types, and a proposal must be
   * judged against the map as it is at the moment it is judged. Injected here
   * rather than imported so the bridge still knows nothing about Electron or
   * the native addon, which is what keeps it unit-testable.
   */
  readonly getMap?: () => MapSnapshot;
  /** Zero-token subscription-auth check, injectable for bridge tests. */
  readonly codexSubscriptionReady?: (binaryPath: string) => Promise<boolean>;
  /** Detect available subscription CLIs, injectable for provider tests. */
  readonly detectProviders?: ProviderDetector;
}

/**
 * What `done` must validate before it is allowed to carry a payload.
 *
 * Only completions. `extract-concepts` was the other structured action and it
 * is gone — every ✦ cell action now streams prose into the cell and nothing
 * else.
 */
type StructuredKind = 'none' | 'completion';

function structuredKindFor(request: ClaudeInvokeRequest): StructuredKind {
  return request.kind === 'complete' ? 'completion' : 'none';
}

function isMissingBinaryError(error: unknown): boolean {
  const record = typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException) : null;
  return record?.code === 'ENOENT' || /\bENOENT\b|not found/i.test(errorMessage(error));
}

interface RunState {
  readonly spec: RunSpec;
  readonly requestId: string;
  readonly provider: CliProvider;
  readonly structured: StructuredKind;
  /** The map a completion is validated against. Absent for every other kind. */
  readonly map?: MapSnapshot;
  readonly child: ChildProcess;
  readonly parser: NdjsonParser;
  /** Idle timer. Restarted on every byte the CLI produces. */
  timeout: NodeJS.Timeout;
  /** Absolute backstop, never restarted. */
  readonly hardTimeout: NodeJS.Timeout;
  sessionId: string;
  deltaText: string;
  assistantText: string;
  stderr: string;
  settled: boolean;
  cancelled: boolean;
  fallbackPending: boolean;
  killTimer: NodeJS.Timeout | null;
}

interface RunSpec {
  readonly request: ClaudeInvokeRequest;
  readonly structured: StructuredKind;
  readonly selection: PackSelection;
  readonly prompt: string;
  readonly systemPromptFile?: string;
  readonly systemPromptText?: string;
  readonly map?: MapSnapshot;
  /** Captured at click time so changing the selector does not reroute an active run. */
  readonly allowFallback: boolean;
}

export class ClaudeBridge {
  private readonly emit: EmitFn;
  private readonly spawnFn: SpawnFn;
  private readonly sourceEnv: NodeJS.ProcessEnv;
  private readonly getMap: (() => MapSnapshot) | null;
  private readonly codexSubscriptionReady: (binaryPath: string) => Promise<boolean>;
  private readonly providers: CliProviderRegistry;
  private readonly runs = new Map<string, RunState>();
  private config: ClaudeBridgeRuntimeConfig;

  constructor(config: ClaudeBridgeRuntimeConfig, emit: EmitFn, deps: ClaudeBridgeDeps = {}) {
    this.config = config;
    this.emit = emit;
    this.spawnFn = deps.spawn ?? (nodeSpawn as SpawnFn);
    this.sourceEnv = deps.sourceEnv ?? process.env;
    this.getMap = deps.getMap ?? null;
    this.codexSubscriptionReady =
      deps.codexSubscriptionReady ??
      (async (binaryPath) => (await checkCodexSubscription(binaryPath, this.sourceEnv)).authenticated);
    this.providers = new CliProviderRegistry(
      {
        claudeBinaryPath: config.binaryPath,
        claudeAvailable: config.claudeAvailable,
        ...(config.codexBinaryPath ? { codexBinaryPath: config.codexBinaryPath } : {}),
      },
      deps.detectProviders,
    );
  }

  /** Point the bridge at a different vault / binary / model. */
  updateConfig(patch: Partial<ClaudeBridgeRuntimeConfig>): void {
    this.config = { ...this.config, ...patch };
  }

  currentConfig(): ClaudeBridgeRuntimeConfig {
    return this.config;
  }

  activeRequestIds(): string[] {
    return [...this.runs.keys()];
  }

  providerSnapshot(): Promise<CliProviderSnapshot> {
    return this.providers.snapshot();
  }

  selectProvider(provider: CliProviderSelection): Promise<CliProviderSnapshot> {
    return this.providers.select(provider);
  }

  // -- invoke ---------------------------------------------------------------

  async invoke(request: ClaudeInvokeRequest): Promise<void> {
    if (this.runs.has(request.requestId)) {
      throw new Error(`Request ${request.requestId} is already running`);
    }

    const selection = await this.selectPacks(request);
    const packText = await renderSections(this.config.knowledgeDir, selection);

    // Read once, here, and kept for validation: the proposal must be judged
    // against the same map the model was shown, or a concurrent edit would
    // make a rejection unexplainable.
    const map = request.kind === 'complete' ? this.currentMap() : undefined;
    if (request.kind === 'complete' && !map) {
      this.emitFailure(
        request.requestId,
        'UNKNOWN',
        'Complete the map needs an open vault to read the graph from.',
      );
      return;
    }

    const resumeSessionId = 'resumeSessionId' in request ? request.resumeSessionId : undefined;

    const systemPrompt = await this.systemPromptFor(request);
    const route = this.providers.route(resumeSessionId);
    const spec: RunSpec = {
      request,
      structured: structuredKindFor(request),
      selection,
      prompt: buildPrompt({ request, packText, ...(map ? { map } : {}) }),
      allowFallback: route.allowFallback,
      ...systemPrompt,
      ...(map ? { map } : {}),
    };
    await this.startRun(spec, route.provider, true);
  }

  async cancel(requestId: string): Promise<boolean> {
    const run = this.runs.get(requestId);
    if (!run) return false;
    run.cancelled = true;
    if (run.fallbackPending) {
      this.runs.delete(requestId);
      clearTimeout(run.timeout);
      clearTimeout(run.hardTimeout);
      this.terminate(run);
      this.emit({ type: 'cancelled', requestId });
      return true;
    }
    this.terminate(run);
    return true;
  }

  /** Called on app quit. No child outlives the app. */
  disposeAll(): void {
    for (const run of this.runs.values()) {
      run.cancelled = true;
      this.terminate(run);
    }
    this.runs.clear();
  }

  // -- setup ----------------------------------------------------------------

  private async selectPacks(request: ClaudeInvokeRequest): Promise<PackSelection> {
    const index = await loadKnowledgeIndex(this.config.knowledgeDir);
    return selectSections(index, requestRoutingText(request));
  }

  /** Null when no vault is open, which is the one case completion cannot run. */
  private currentMap(): MapSnapshot | undefined {
    if (!this.getMap) return undefined;
    try {
      return this.getMap();
    } catch (error: unknown) {
      log.warn('could not read the graph for a completion', errorMessage(error));
      return undefined;
    }
  }

  /** Missing prompt files are normal before agent 6 lands them — omit the flag. */
  private async systemPromptFor(
    request: ClaudeInvokeRequest,
  ): Promise<{ systemPromptFile?: string; systemPromptText?: string }> {
    const name =
      request.kind === 'cell'
        ? request.action
        : request.kind === 'complete'
          ? 'complete-map'
          : request.kind === 'describe'
            ? 'describe'
            : 'chat';
    const file = path.join(this.config.knowledgeDir, SYSTEM_PROMPT_DIR, `${name}.md`);
    try {
      const text = await fs.readFile(file, 'utf8');
      return { systemPromptFile: file, systemPromptText: text };
    } catch {
      log.debug('no system prompt file, continuing without one', file);
      return {};
    }
  }

  private async startRun(
    spec: RunSpec,
    provider: CliProvider,
    emitPacks: boolean,
    replacing?: RunState,
  ): Promise<void> {
    const command = this.providers.binaryPath(provider);
    if (!command) {
      this.failStart(
        spec.request.requestId,
        replacing,
        'CLI_NOT_FOUND',
        provider === 'codex'
          ? 'No subscription-authenticated local Codex CLI is available.'
          : 'The local Claude CLI was not found.',
      );
      return;
    }

    if (provider === 'codex') {
      let ready = false;
      try {
        ready = await this.codexSubscriptionReady(command);
      } catch (error: unknown) {
        log.warn('could not verify Codex subscription authentication', errorMessage(error));
      }
      if (!ready) {
        this.failStart(
          spec.request.requestId,
          replacing,
          'NOT_AUTHENTICATED',
          'Codex is not signed in with ChatGPT. Run `codex login`; API-key logins are not used.',
        );
        return;
      }
    }
    if (replacing && (this.runs.get(replacing.requestId) !== replacing || replacing.cancelled)) return;

    const requestedSessionId =
      'resumeSessionId' in spec.request ? spec.request.resumeSessionId : undefined;
    const resumeSessionId =
      provider === 'codex'
        ? unwrapCodexSessionId(requestedSessionId)
        : isCodexSessionId(requestedSessionId)
          ? undefined
          : requestedSessionId;
    const args =
      provider === 'claude'
        ? buildClaudeArgs({
            prompt: spec.prompt,
            config: this.config,
            ...(spec.systemPromptFile ? { systemPromptFile: spec.systemPromptFile } : {}),
            ...(resumeSessionId ? { resumeSessionId } : {}),
          })
        : buildCodexArgs({
            prompt: [spec.systemPromptText, spec.prompt].filter(Boolean).join('\n\n---\n\n'),
            ...(resumeSessionId ? { resumeSessionId } : {}),
          });
    const env =
      provider === 'claude' ? buildChildEnv(this.sourceEnv) : buildCodexChildEnv(this.sourceEnv);
    if (provider === 'claude' ? hasBillingLeak(env) : hasCodexBillingLeak(env)) {
      throw new Error('Refusing to spawn: the child environment still carries a billing key.');
    }

    try {
      const child = this.spawnFn(command, args, {
        env,
        cwd: this.config.vaultDir,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.registerRun(spec, child, provider, emitPacks);
    } catch (error: unknown) {
      if (
        provider === 'claude' &&
        spec.allowFallback &&
        isMissingBinaryError(error) &&
        this.providers.binaryPath('codex')
      ) {
        await this.startRun(spec, 'codex', emitPacks, replacing);
        return;
      }
      this.failStart(spec.request.requestId, replacing, 'SPAWN_FAILED', errorMessage(error));
    }
  }

  private failStart(
    requestId: string,
    replacing: RunState | undefined,
    code: ClaudeErrorCode,
    message: string,
  ): void {
    if (replacing) {
      if (this.runs.get(requestId) !== replacing || replacing.cancelled) return;
      this.runs.delete(requestId);
    }
    this.emitFailure(requestId, code, message);
  }

  private registerRun(
    spec: RunSpec,
    child: ChildProcess,
    provider: CliProvider,
    emitPacks: boolean,
  ): void {
    const { request, selection, map } = spec;
    const { requestId } = request;

    /**
     * IDLE timeout, not a cap on the whole request.
     *
     * A wall-clock cap kills a long answer that is streaming perfectly well,
     * which is exactly what happened: a thorough reply to a graph-aware
     * question ran past 120s and was reported as a failure with most of it
     * already on screen. What actually indicates a problem is SILENCE — the
     * CLI producing nothing at all — so the timer restarts on every byte.
     */
    const timeout = setTimeout(() => this.onIdle(requestId), this.config.timeoutMs);
    timeout.unref?.();

    /**
     * Absolute ceiling, never restarted. A process that streams a byte every
     * few seconds forever would otherwise live as long as the app does.
     */
    const hardTimeout = setTimeout(() => {
      const current = this.runs.get(requestId);
      if (!current) return;
      this.settle(
        current,
        'TIMEOUT',
        `Still running after ${Math.round(HARD_TIMEOUT_MS / 60_000)} minutes. Stopped.`,
      );
      this.terminate(current);
    }, HARD_TIMEOUT_MS);
    hardTimeout.unref?.();

    const run: RunState = {
      spec,
      requestId,
      provider,
      structured: spec.structured,
      ...(map ? { map } : {}),
      child,
      parser: new NdjsonParser(),
      timeout,
      hardTimeout,
      sessionId:
        provider === 'codex'
          ? isCodexSessionId('resumeSessionId' in request ? request.resumeSessionId : undefined)
            ? (request as { resumeSessionId?: string }).resumeSessionId ?? ''
            : ''
          : isCodexSessionId('resumeSessionId' in request ? request.resumeSessionId : undefined)
            ? ''
            : ('resumeSessionId' in request ? request.resumeSessionId : undefined) ?? '',
      deltaText: '',
      assistantText: '',
      stderr: '',
      settled: false,
      cancelled: false,
      fallbackPending: false,
      killTimer: null,
    };
    this.runs.set(requestId, run);

    this.emit({ type: 'started', requestId, sessionId: run.sessionId, provider: run.provider });
    if (emitPacks) {
      this.emit({
        type: 'packs',
        requestId,
        sections: [...selection.ids],
        approxTokens: selection.approxTokens,
      });
    }

    this.wireChild(run);
  }

  private wireChild(run: RunState): void {
    run.child.stdout?.on('data', (chunk: Buffer) => {
      // Any output means the run is alive, whether or not the line parses.
      this.resetIdleTimer(run);
      for (const line of run.parser.push(chunk)) this.handleLine(run, line);
    });

    run.child.stderr?.on('data', (chunk: Buffer) => {
      this.resetIdleTimer(run);
      run.stderr += chunk.toString('utf8');
    });

    run.child.on('error', (error: Error) => {
      // A killed CLI may report its termination as a spawn/runtime error
      // before `close`. Stop is an author decision, not a failed request.
      if (run.cancelled) return;
      if (
        run.provider === 'claude' &&
        run.spec.allowFallback &&
        isMissingBinaryError(error) &&
        this.providers.binaryPath('codex')
      ) {
        this.beginCodexFallback(run, 'Claude executable disappeared before it could start.');
        return;
      }
      this.settle(run, 'SPAWN_FAILED', errorMessage(error));
    });

    run.child.on('close', (code: number | null) => {
      for (const line of run.parser.flush()) this.handleLine(run, line);
      this.finish(run, code);
    });
  }

  // -- streaming ------------------------------------------------------------

  private handleLine(run: RunState, line: NdjsonLine): void {
    // Some CLIs flush an error_during_execution record while handling SIGTERM.
    // Once Stop was requested, `close` owns the terminal cancelled event.
    if (run.cancelled) return;
    if (!line.ok) {
      // One unreadable line is not fatal — the `result` record still decides.
      log.warn('unparseable stream-json line', line.error);
      return;
    }

    if (run.provider === 'codex') {
      this.handleCodexSignal(run, interpretCodex(line.value));
      return;
    }

    const signal = interpret(line.value);
    switch (signal.kind) {
      case 'init':
        run.sessionId = signal.sessionId;
        this.emit({
          type: 'started',
          requestId: run.requestId,
          sessionId: signal.sessionId,
          provider: run.provider,
        });
        return;

      case 'text':
        run.deltaText += signal.text;
        this.emit({ type: 'delta', requestId: run.requestId, text: signal.text });
        return;

      case 'thinking':
        this.emit({ type: 'thinking', requestId: run.requestId, text: signal.text });
        return;

      case 'tool':
        this.emit({ type: 'tool', requestId: run.requestId, name: signal.name });
        return;

      case 'result':
        this.handleResult(run, signal);
        return;

      case 'ignored':
      default:
        // `assistant` records carry whole text blocks; keep them as the fallback
        // for a CLI build that does not emit partial deltas.
        run.assistantText += readAssistantText(line.value);
    }
  }

  private handleResult(run: RunState, result: ResultSignal): void {
    if (result.sessionId) run.sessionId = result.sessionId;
    if (result.isError) {
      if (isClaudeAllowanceLimit(result.errorText ?? '')) {
        this.beginCodexFallback(run, result.errorText ?? 'Claude allowance exhausted.');
        return;
      }
      this.settle(run, 'SPAWN_FAILED', result.errorText ?? 'The CLI reported an error.');
      return;
    }
    this.emitDone(run, result.text || run.deltaText || run.assistantText, result.usage);
  }

  private handleCodexSignal(run: RunState, signal: CodexSignal): void {
    switch (signal.kind) {
      case 'init':
        run.sessionId = tagCodexSessionId(signal.sessionId);
        this.emit({
          type: 'started',
          requestId: run.requestId,
          sessionId: run.sessionId,
          provider: run.provider,
        });
        return;
      case 'text':
        run.deltaText += signal.text;
        this.emit({ type: 'delta', requestId: run.requestId, text: signal.text });
        return;
      case 'thinking':
        this.emit({ type: 'thinking', requestId: run.requestId, text: signal.text });
        return;
      case 'tool':
        this.emit({ type: 'tool', requestId: run.requestId, name: signal.name });
        return;
      case 'result':
        this.emitDone(run, run.deltaText || run.assistantText, signal.usage);
        return;
      case 'error':
        this.settle(run, 'SPAWN_FAILED', signal.message);
        return;
      case 'ignored':
      default:
        return;
    }
  }

  private beginCodexFallback(run: RunState, reason: string): void {
    if (run.settled) return;
    // Only emitted deltas count as a response already shown to the author.
    // Claude also mirrors terminal failures (including the session-limit
    // notice) through an `assistant` record before its error result. That text
    // is kept only as a no-delta success fallback and must not block failover.
    if (!run.spec.allowFallback || !this.providers.binaryPath('codex') || run.deltaText) {
      this.settle(run, 'SPAWN_FAILED', reason);
      return;
    }

    run.settled = true;
    run.fallbackPending = true;
    clearTimeout(run.timeout);
    clearTimeout(run.hardTimeout);
    this.terminate(run);
    log.info(`request ${run.requestId} falling back from Claude to Codex`, reason);

    void this.startRun(run.spec, 'codex', false, run).catch((error: unknown) => {
      this.failStart(run.requestId, run, 'SPAWN_FAILED', errorMessage(error));
    });
  }

  /** Restart the idle countdown. Called on every byte from the child. */
  private resetIdleTimer(run: RunState): void {
    if (run.settled || run.cancelled) return;
    clearTimeout(run.timeout);
    run.timeout = setTimeout(() => this.onIdle(run.requestId), this.config.timeoutMs);
    run.timeout.unref?.();
  }

  private onIdle(requestId: string): void {
    const current = this.runs.get(requestId);
    if (!current) return;
    const seconds = Math.round(this.config.timeoutMs / 1000);
    this.settle(
      current,
      'TIMEOUT',
      `The CLI went quiet for ${seconds}s with no output. Stopped.`,
    );
    this.terminate(current);
  }

  private emitDone(run: RunState, fullText: string, usage: ClaudeUsage): void {
    if (run.settled) return;
    run.settled = true;
    clearTimeout(run.timeout);
    clearTimeout(run.hardTimeout);

    if (run.structured === 'none') {
      this.emit({
        type: 'done',
        requestId: run.requestId,
        sessionId: run.sessionId,
        fullText,
        usage,
      });
      return;
    }

    this.emitCompletion(run, fullText, usage);
  }

  /**
   * Validate a proposal and emit it, or say plainly that it was unreadable.
   *
   * Nothing is applied here. The bridge only ever produces a PROPOSAL — the
   * author accepts it in the review pane, and the renderer applies it through
   * the ordinary graph channels. There is no path from a model's reply to a
   * mutated graph that does not pass through a person.
   */
  private emitCompletion(run: RunState, fullText: string, usage: ClaudeUsage): void {
    const parsed = parseCompletion(fullText);
    if (!parsed.ok) {
      log.error(`completion rejected for ${run.requestId}`, parsed.reason);
      this.emit({
        type: 'error',
        requestId: run.requestId,
        code: 'INVALID_COMPLETION',
        message:
          `Complete the map returned something unreadable: ${parsed.reason}. ` +
          'Nothing was changed.',
      });
      return;
    }

    this.emit({
      type: 'done',
      requestId: run.requestId,
      sessionId: run.sessionId,
      fullText,
      usage,
      // `map` is guaranteed present: invoke refuses a completion without one.
      completion: validateCompletion(
        parsed.value,
        run.map ?? { name: '', nodes: [], edges: [] },
        run.spec.request.kind === 'complete'
          ? (run.spec.request.connectionScope ?? 'all')
          : 'all',
      ),
    });
  }

  // -- teardown -------------------------------------------------------------

  private finish(run: RunState, code: number | null): void {
    clearTimeout(run.timeout);
    clearTimeout(run.hardTimeout);
    if (run.killTimer) clearTimeout(run.killTimer);

    const ownsRequest = this.runs.get(run.requestId) === run;
    if (run.settled) {
      if (ownsRequest && !run.fallbackPending) this.runs.delete(run.requestId);
      return;
    }

    if (run.cancelled) {
      if (ownsRequest) this.runs.delete(run.requestId);
      run.settled = true;
      this.emit({ type: 'cancelled', requestId: run.requestId });
      return;
    }

    if (code === 0) {
      if (ownsRequest) this.runs.delete(run.requestId);
      // Clean exit without a `result` record: use whatever text accumulated
      // rather than reporting a failure that did not happen.
      const text = run.deltaText || run.assistantText;
      if (text) {
        this.emitDone(run, text, EMPTY_USAGE);
        return;
      }
      this.settle(run, 'PARSE_FAILED', 'The CLI exited successfully but produced no output.');
      return;
    }

    const failure =
      run.stderr.trim() ||
      `\`${run.provider}\` exited with code ${code === null ? 'unknown' : code}.`;
    if (run.provider === 'claude' && isClaudeAllowanceLimit(failure)) {
      this.beginCodexFallback(run, failure);
      return;
    }

    if (ownsRequest) this.runs.delete(run.requestId);
    this.settle(run, 'SPAWN_FAILED', failure);
  }

  private settle(run: RunState, code: ClaudeErrorCode, message: string): void {
    if (run.settled) return;
    run.settled = true;
    clearTimeout(run.timeout);
    clearTimeout(run.hardTimeout);
    this.emitFailure(run.requestId, code, message);
  }

  private emitFailure(requestId: string, code: ClaudeErrorCode, message: string): void {
    log.error(`request ${requestId} failed (${code})`, message);
    this.emit({ type: 'error', requestId, code, message });
  }

  /** SIGTERM, then SIGKILL if the child is still alive after the grace period. */
  private terminate(run: RunState): void {
    if (run.child.exitCode !== null || run.child.signalCode !== null) return;
    if (run.killTimer) return;

    run.child.kill('SIGTERM');
    run.killTimer = setTimeout(() => {
      if (run.child.exitCode === null && run.child.signalCode === null) {
        log.warn(`request ${run.requestId} ignored SIGTERM, sending SIGKILL`);
        run.child.kill('SIGKILL');
      }
    }, KILL_GRACE_MS);
    run.killTimer.unref?.();
  }
}
