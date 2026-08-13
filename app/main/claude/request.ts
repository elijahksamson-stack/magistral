/**
 * Validation for `claude:invoke` payloads.
 *
 * This is the one boundary where bad input costs the user tokens, so it is
 * checked field by field and normalised into an immutable request before the
 * bridge sees it.
 */

import {
  DOCUMENT_CHAR_LIMIT,
  type CellInvokeRequest,
  type ChatInvokeRequest,
  type ClaudeInvokeRequest,
  type DescribeInvokeRequest,
  type GraphContext,
  type MapCompletionRequest,
  type SourceDocument,
} from '../../../shared/types/claude';
import {
  CONNECTION_SCOPES,
  type ConnectionScope,
} from '../../../shared/types/completion';
import { InvalidPayloadError, isCellAction } from '../guards';

const CHANNEL = 'claude:invoke';
const MAX_LABELS = 200;

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidPayloadError(`${CHANNEL}: expected an object payload`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidPayloadError(`${CHANNEL}: "${field}" must be a non-empty string`);
  }
  return value;
}

function labelList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string').slice(0, MAX_LABELS);
}

function readGraphContext(value: unknown): GraphContext | undefined {
  if (value === undefined || value === null) return undefined;
  const source = asRecord(value);
  return {
    graphName: typeof source.graphName === 'string' ? source.graphName : 'Untitled',
    nodeCount: typeof source.nodeCount === 'number' ? source.nodeCount : 0,
    edgeCount: typeof source.edgeCount === 'number' ? source.edgeCount : 0,
    topNodeLabels: labelList(source.topNodeLabels),
    linkedNodeLabels: labelList(source.linkedNodeLabels),
  };
}

function optional(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new InvalidPayloadError(`${CHANNEL}: "${field}" must be a string when present`);
  }
  return value.length > 0 ? value : undefined;
}

/**
 * Validate an imported document. A boundary: the renderer sends it, but the
 * text originated in a file on disk, and the char limit is re-enforced here
 * rather than trusted — a payload over ARG_MAX fails at spawn with an opaque
 * E2BIG that no one can act on.
 */
function readSourceDocument(value: unknown): SourceDocument | undefined {
  if (value === undefined || value === null) return undefined;
  const source = asRecord(value);

  const name = typeof source.name === 'string' && source.name.length > 0 ? source.name : 'document';
  if (typeof source.text !== 'string' || source.text.trim().length === 0) {
    throw new InvalidPayloadError(`${CHANNEL}: "sourceDocument.text" must be non-empty`);
  }

  const wasTruncatedUpstream = source.isTruncated === true;
  const isOverLimit = source.text.length > DOCUMENT_CHAR_LIMIT;
  return {
    name,
    text: isOverLimit ? source.text.slice(0, DOCUMENT_CHAR_LIMIT) : source.text,
    isTruncated: wasTruncatedUpstream || isOverLimit,
  };
}

function parseCell(source: Record<string, unknown>, requestId: string): CellInvokeRequest {
  if (!isCellAction(source.action)) {
    throw new InvalidPayloadError(`${CHANNEL}: "action" is not a known cell action`);
  }
  if (typeof source.cellMarkdown !== 'string') {
    throw new InvalidPayloadError(`${CHANNEL}: "cellMarkdown" must be a string`);
  }

  const sourceDocument = readSourceDocument(source.sourceDocument);
  if (source.action === 'distill-import' && !sourceDocument) {
    throw new InvalidPayloadError(`${CHANNEL}: "distill-import" requires a sourceDocument`);
  }

  return {
    requestId,
    kind: 'cell',
    action: source.action,
    cellId: nonEmptyString(source.cellId, 'cellId'),
    cellMarkdown: source.cellMarkdown,
    ...(sourceDocument ? { sourceDocument } : {}),
    ...(optional(source.selectionText, 'selectionText')
      ? { selectionText: source.selectionText as string }
      : {}),
    ...(readGraphContext(source.graphContext)
      ? { graphContext: readGraphContext(source.graphContext) }
      : {}),
    ...(optional(source.resumeSessionId, 'resumeSessionId')
      ? { resumeSessionId: source.resumeSessionId as string }
      : {}),
  };
}

function parseChat(source: Record<string, unknown>, requestId: string): ChatInvokeRequest {
  return {
    requestId,
    kind: 'chat',
    message: nonEmptyString(source.message, 'message'),
    ...(readGraphContext(source.graphContext)
      ? { graphContext: readGraphContext(source.graphContext) }
      : {}),
    ...(optional(source.resumeSessionId, 'resumeSessionId')
      ? { resumeSessionId: source.resumeSessionId as string }
      : {}),
  };
}

/**
 * A completion request carries almost nothing.
 *
 * Notably NOT the map: that is attached in the main process from the core, so
 * the renderer cannot assert what the graph contains. Every permission check
 * downstream compares the proposal against the map, and a caller-supplied map
 * would let a stale one wave through a "new" concept that already exists.
 */
function parseComplete(
  source: Record<string, unknown>,
  requestId: string,
): MapCompletionRequest {
  const instruction = optional(source.instruction, 'instruction');
  const connectionScope = optional(source.connectionScope, 'connectionScope');
  if (connectionScope && !CONNECTION_SCOPES.includes(connectionScope as ConnectionScope)) {
    throw new InvalidPayloadError(`${CHANNEL}: "connectionScope" is not recognized`);
  }
  return {
    requestId,
    kind: 'complete',
    ...(connectionScope ? { connectionScope: connectionScope as ConnectionScope } : {}),
    ...(instruction ? { instruction } : {}),
    ...(readGraphContext(source.graphContext)
      ? { graphContext: readGraphContext(source.graphContext) }
      : {}),
  };
}

/** Every string the renderer supplies is checked; none of it is trusted. */
function stringList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new InvalidPayloadError(`${CHANNEL}: "${field}" must be an array of strings`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string') {
      throw new InvalidPayloadError(`${CHANNEL}: "${field}[${index}]" must be a string`);
    }
    return entry;
  });
}

function parseDescribe(
  source: Record<string, unknown>,
  requestId: string,
): DescribeInvokeRequest {
  const parentLabel = optional(source.parentLabel, 'parentLabel');
  const existing = optional(source.existing, 'existing');
  return {
    requestId,
    kind: 'describe',
    label: nonEmptyString(source.label, 'label'),
    neighbours: stringList(source.neighbours, 'neighbours'),
    subConcepts: stringList(source.subConcepts, 'subConcepts'),
    ...(parentLabel ? { parentLabel } : {}),
    ...(existing ? { existing } : {}),
    ...(readGraphContext(source.graphContext)
      ? { graphContext: readGraphContext(source.graphContext) }
      : {}),
  };
}

export function parseInvokeRequest(payload: unknown): ClaudeInvokeRequest {
  const source = asRecord(payload);
  const requestId = nonEmptyString(source.requestId, 'requestId');

  if (source.kind === 'cell') return parseCell(source, requestId);
  if (source.kind === 'chat') return parseChat(source, requestId);
  if (source.kind === 'complete') return parseComplete(source, requestId);
  if (source.kind === 'describe') return parseDescribe(source, requestId);

  throw new InvalidPayloadError(
    `${CHANNEL}: "kind" must be "cell", "chat", "complete" or "describe"`,
  );
}
