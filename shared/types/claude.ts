/**
 * Claude CLI bridge — CONTRACT.
 *
 * The bridge shells out to the LOCAL `claude` binary. It rides the user's
 * logged-in Claude Code subscription. It must never consume API credits.
 *
 * Implemented by: app/main/claude/bridge.ts   (agent 3)
 * Consumed by:    app/renderer/editor/        (agent 4)
 *                 app/renderer/chat/          (agent 6)
 */

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * The per-cell ✦ actions offered in the Editor pane.
 *
 * `extract-concepts` used to live here. It returned strict JSON of nodes and
 * edges to merge into the graph, which is the same job "Complete the map" now
 * does from the chat pane — but against the WHOLE graph rather than one cell,
 * and behind a review the author approves change by change. Two paths writing
 * to the graph with different safety properties was one too many.
 */
export type CellAction =
  /** Sharpen the existing prose without changing its claims. */
  | 'enhance'
  /** Write the next paragraph in the author's voice. */
  | 'continue'
  /** Attack the reasoning. Name the weakest link. */
  | 'critique'
  /** Compress to its load-bearing sentences. */
  | 'distill'
  /**
   * Read an imported document and write a condensed set of takeaways with the
   * concepts already wrapped in [[wikilinks]], so the graph builds itself from
   * the import. Carries `sourceDocument`; every other action acts on the cell.
   */
  | 'distill-import';

/**
 * EVERY cell action. This is the set the IPC boundary validates against, so an
 * action missing here is rejected as unknown however well it is wired
 * elsewhere — which is exactly what happened when `distill-import` was added
 * to the union but not to this list.
 */
export const CELL_ACTIONS: readonly CellAction[] = [
  'enhance',
  'continue',
  'critique',
  'distill',
  'distill-import',
] as const;

/**
 * The subset offered in the per-cell ✦ menu.
 *
 * `distill-import` is deliberately absent: it needs a document, so it is
 * reached from the editor's Import control rather than from a cell's menu.
 */
export const MENU_CELL_ACTIONS: readonly CellAction[] = [
  'enhance',
  'continue',
  'critique',
  'distill',
] as const;

// ---------------------------------------------------------------------------
// Local CLI providers
// ---------------------------------------------------------------------------

/** The subscription-authenticated local CLIs BrainDump knows how to run. */
export type CliProvider = 'claude' | 'codex';

/** `auto` preserves Claude-first routing with Codex as an allowance fallback. */
export type CliProviderSelection = 'auto' | CliProvider;

export interface CliProviderStatus {
  id: CliProvider;
  /** Product name shown in the selector; Codex is ChatGPT's local CLI. */
  label: 'Claude' | 'ChatGPT';
  /** The executable exists and answers its zero-token version check. */
  available: boolean;
  /** The CLI is signed into a subscription, rather than an API key. */
  authenticated: boolean;
  version?: string;
  reason?: string;
}

export interface CliProviderSnapshot {
  providers: CliProviderStatus[];
  selected: CliProviderSelection;
}

/** Human-facing labels for the ✦ menu. */
export const CELL_ACTION_LABELS: Record<CellAction, string> = {
  enhance: 'Enhance',
  continue: 'Continue',
  critique: 'Critique',
  distill: 'Distill',
  'distill-import': 'Distill import',
};

/**
 * Every cell action now returns prose to be streamed into the cell.
 *
 * Kept as a function rather than deleted at the call sites: the editor's run
 * state still branches on it, and a constant `false` there says plainly that
 * no ✦ action writes to the graph any more. "Complete the map" is the one path
 * that does, and it goes through a review.
 */
export function isStructuredAction(_action: CellAction): boolean {
  return false;
}

// ---------------------------------------------------------------------------
// Knowledge pack selection
// ---------------------------------------------------------------------------

export type PackKind = 'mindset' | 'sector' | 'macroman';

/**
 * One addressable slice of the bundled corpus.
 *
 * Sector modules run 45-69 KB (~15k tokens) each, so they are indexed at
 * SECTION level, never whole-file. `byteStart`/`byteEnd` slice the section out
 * of `relPath` without reading the whole file into memory.
 */
export interface PackSection {
  id: string;
  kind: PackKind;
  /** e.g. "Technology" — absent for mindset/macroman. */
  sector?: string;
  /** e.g. "Semiconductors" */
  module: string;
  /** e.g. "2. Inputs and Dependencies" */
  section: string;
  /** Relative to resources/knowledge/ */
  relPath: string;
  byteStart: number;
  byteEnd: number;
  /** Rough token estimate, for budgeting. */
  approxTokens: number;
  /** Lowercased terms that should route a query to this section. */
  keywords: string[];
}

export interface KnowledgeIndex {
  generatedAt: string;
  fileCount: number;
  sections: PackSection[];
}

/** How much corpus a single invocation is allowed to inject. */
export const PACK_TOKEN_BUDGET = 12_000;

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** Compact graph summary handed to Claude so answers are graph-aware. */
export interface GraphContext {
  graphName: string;
  nodeCount: number;
  edgeCount: number;
  /** Highest-centrality node labels, capped for context economy. */
  topNodeLabels: string[];
  /** Labels of nodes the cell currently references. */
  linkedNodeLabels: string[];
}

/** A file the author imported, already read and converted to plain text. */
export interface SourceDocument {
  /** File name as chosen, e.g. "Q3 strategy.docx". Shown in the UI. */
  name: string;
  /** Plain text. Truncated to DOCUMENT_CHAR_LIMIT before it gets here. */
  text: string;
  /** True when the file was longer than the limit and was cut. */
  isTruncated: boolean;
}

/**
 * How much imported text a single distillation may carry.
 *
 * The prompt travels as an argv entry, and macOS caps a process's whole
 * argument list around 1MB — a long report would otherwise fail at spawn with
 * an opaque E2BIG rather than a message anyone can act on. 60k characters is
 * roughly 15k tokens, comfortably more than any document worth distilling in
 * one pass.
 */
export const DOCUMENT_CHAR_LIMIT = 60_000;

export interface CellInvokeRequest {
  requestId: string;
  kind: 'cell';
  action: CellAction;
  cellId: string;
  /** Full markdown of the cell being acted on. */
  cellMarkdown: string;
  /** Present only for `distill-import` — the document being read. */
  sourceDocument?: SourceDocument;
  /** When the user has a selection, act on this rather than the whole cell. */
  selectionText?: string;
  graphContext?: GraphContext;
  /** Resume this cell's prior session, if one exists. */
  resumeSessionId?: string;
}

export interface ChatInvokeRequest {
  requestId: string;
  kind: 'chat';
  /** The user's message. */
  message: string;
  graphContext?: GraphContext;
  /** The persistent chat session. */
  resumeSessionId?: string;
}

/**
 * "Complete the map" — the model proposes additions to the graph.
 *
 * Deliberately does NOT resume the chat session. The reply is a JSON proposal,
 * and folding that into the conversation would leave every later chat turn
 * reasoning over a wall of machine output. What it needs instead is the map
 * itself, which the MAIN process attaches from the core — never the renderer.
 * A snapshot supplied by the caller is a snapshot that can be stale or wrong,
 * and every permission check here is a comparison against what the graph
 * actually holds.
 */
export interface MapCompletionRequest {
  requestId: string;
  kind: 'complete';
  /** Enforced after generation too; prompt wording is not the safety boundary. */
  connectionScope?: import('./completion').ConnectionScope;
  /** Optional focus the author typed, e.g. "concentrate on the demand side". */
  instruction?: string;
  graphContext?: GraphContext;
}

/**
 * A description for one concept, written from its own name and what it touches.
 *
 * Deliberately not a cell action. The subject may be a sub-concept, which has
 * no cell of its own, and the answer is a sentence or two for a detail panel
 * rather than prose to stream into the Editor. It carries its neighbourhood
 * explicitly because that neighbourhood IS the material: a concept in this
 * graph is largely defined by what the author connected it to.
 *
 * Returns prose, never JSON — nothing here writes to the graph. The author
 * still has to keep the text, so no review gate is needed.
 */
export interface DescribeInvokeRequest {
  requestId: string;
  kind: 'describe';
  /** The concept being described. */
  label: string;
  /** Already-phrased relationships, e.g. "causes → Hardware Demand". */
  neighbours: readonly string[];
  /** Sub-concepts beneath it, when the subject is a node. */
  subConcepts?: readonly string[];
  /** The concept this sits under, when the subject is a sub-concept. */
  parentLabel?: string;
  /**
   * The description the author already has, when there is one.
   *
   * Its presence changes the task from writing to deepening: a concept the
   * author has already described is one they have already thought about, and
   * replacing that with a fresh generic paragraph destroys the reasoning that
   * made it worth keeping.
   */
  existing?: string;
  graphContext?: GraphContext;
}

export type ClaudeInvokeRequest =
  | CellInvokeRequest
  | ChatInvokeRequest
  | MapCompletionRequest
  | DescribeInvokeRequest;

// ---------------------------------------------------------------------------
// Streaming events (main -> renderer)
// ---------------------------------------------------------------------------

export interface ClaudeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /**
   * The CLI's notional cost weighting. This rides the subscription — it is a
   * token weighting, NOT money leaving an account. Never present it as a price.
   */
  notionalCostUsd: number;
}

export type ClaudeStreamEvent =
  | { type: 'started'; requestId: string; sessionId: string; provider?: CliProvider }
  /** Internal corpus-routing metadata retained for diagnostics, not rendered in response UI. */
  | { type: 'packs'; requestId: string; sections: string[]; approxTokens: number }
  | { type: 'delta'; requestId: string; text: string }
  | { type: 'thinking'; requestId: string; text: string }
  | { type: 'tool'; requestId: string; name: string }
  | {
      type: 'done';
      requestId: string;
      sessionId: string;
      fullText: string;
      usage: ClaudeUsage;
      /**
       * Present and validated only when kind === 'complete'. Carries what was
       * refused alongside what was accepted, so the review can say why a
       * proposal is smaller than the model's reply implied.
       */
      completion?: import('./completion').ValidatedCompletion;
    }
  | { type: 'error'; requestId: string; message: string; code: ClaudeErrorCode }
  | { type: 'cancelled'; requestId: string };

export type ClaudeErrorCode =
  /** `claude` not on PATH. */
  | 'CLI_NOT_FOUND'
  /** CLI present but not logged in. */
  | 'NOT_AUTHENTICATED'
  /** Process exited non-zero. */
  | 'SPAWN_FAILED'
  /** stream-json emitted something we could not parse. */
  | 'PARSE_FAILED'
  /** complete-the-map returned something that was not a readable proposal. */
  | 'INVALID_COMPLETION'
  /** Exceeded the wall-clock cap. */
  | 'TIMEOUT'
  | 'UNKNOWN';

// ---------------------------------------------------------------------------
// Spawn configuration
// ---------------------------------------------------------------------------

export interface ClaudeBridgeConfig {
  /** Resolved absolute path to the `claude` binary. */
  binaryPath: string;
  /** Alias ('sonnet' | 'opus' | 'haiku') or full model id. */
  model: string;
  /** Hard wall-clock cap per invocation. */
  timeoutMs: number;
  /** Absolute path to resources/knowledge. */
  knowledgeDir: string;
  /** Absolute path to the open vault. */
  vaultDir: string;
}

/**
 * The newest Sonnet, pinned by id rather than by the `sonnet` alias.
 *
 * The alias resolves to whatever the installed CLI considers current, which
 * varies between machines and CLI versions — an older install quietly answers
 * with an older model and nothing in the app says so. A pinned id is one line
 * to bump and leaves no doubt about what answered.
 */
export const DEFAULT_MODEL = 'claude-sonnet-5';

export const DEFAULT_BRIDGE_CONFIG: Omit<
  ClaudeBridgeConfig,
  'binaryPath' | 'knowledgeDir' | 'vaultDir'
> = {
  model: DEFAULT_MODEL,
  timeoutMs: 120_000,
};

/**
 * Environment variables that MUST be stripped before spawning `claude`.
 *
 * If ANTHROPIC_API_KEY survives into the child environment, the CLI silently
 * bills the API instead of the subscription. That is the exact failure this
 * app is built to avoid, so it is covered by a dedicated unit test in
 * app/main/claude/bridge.test.ts.
 */
export const STRIPPED_ENV_KEYS: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'AWS_BEARER_TOKEN_BEDROCK',
] as const;

/**
 * Tools the spawned CLI is permitted to use. Read-only, deliberately.
 * `--dangerously-skip-permissions` is NEVER passed.
 */
export const ALLOWED_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob'] as const;
