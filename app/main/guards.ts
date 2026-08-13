/**
 * Boundary guards for IPC payloads.
 *
 * Everything crossing the contextBridge is untrusted by policy, even though
 * the renderer is our own code — a compromised renderer must not be able to
 * hand the main process a path, an id, or a number it did not check.
 */

import { NODE_KINDS, RELATION_KINDS, type NodeKind, type RelationKind } from '../../shared/types/graph';
import { CELL_ACTIONS, type CellAction } from '../../shared/types/claude';

export class InvalidPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPayloadError';
  }
}

function record(payload: unknown, channel: string): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new InvalidPayloadError(`${channel}: expected an object payload`);
  }
  return payload as Record<string, unknown>;
}

export function requireString(payload: unknown, key: string, channel: string): string {
  const value = record(payload, channel)[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidPayloadError(`${channel}: "${key}" must be a non-empty string`);
  }
  return value;
}

export function optionalString(payload: unknown, key: string, channel: string): string | undefined {
  const value = record(payload, channel)[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new InvalidPayloadError(`${channel}: "${key}" must be a string when present`);
  }
  return value;
}

/** Markdown may legitimately be empty, so this only checks the type. */
export function requireText(payload: unknown, key: string, channel: string): string {
  const value = record(payload, channel)[key];
  if (typeof value !== 'string') {
    throw new InvalidPayloadError(`${channel}: "${key}" must be a string`);
  }
  return value;
}

export function requireFiniteNumber(payload: unknown, key: string, channel: string): number {
  const value = record(payload, channel)[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InvalidPayloadError(`${channel}: "${key}" must be a finite number`);
  }
  return value;
}

export function optionalPositiveInt(
  payload: unknown,
  key: string,
  channel: string,
): number | undefined {
  const value = record(payload, channel)[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new InvalidPayloadError(`${channel}: "${key}" must be a positive integer when present`);
  }
  return value;
}

/** For values where 0 is meaningful — a layout seed, for instance. */
export function optionalNonNegativeInt(
  payload: unknown,
  key: string,
  channel: string,
): number | undefined {
  const value = record(payload, channel)[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new InvalidPayloadError(
      `${channel}: "${key}" must be a non-negative integer when present`,
    );
  }
  return value;
}

export function optionalPositiveNumber(
  payload: unknown,
  key: string,
  channel: string,
): number | undefined {
  const value = record(payload, channel)[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new InvalidPayloadError(`${channel}: "${key}" must be a positive number when present`);
  }
  return value;
}

export function requireStringArray(payload: unknown, key: string, channel: string): string[] {
  const value = record(payload, channel)[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new InvalidPayloadError(`${channel}: "${key}" must be an array of strings`);
  }
  return value as string[];
}

export function requireNodeKind(payload: unknown, key: string, channel: string): NodeKind {
  const value = record(payload, channel)[key];
  if (!NODE_KINDS.includes(value as NodeKind)) {
    throw new InvalidPayloadError(`${channel}: "${key}" must be one of ${NODE_KINDS.join(', ')}`);
  }
  return value as NodeKind;
}

export function requireRelationKind(payload: unknown, key: string, channel: string): RelationKind {
  const value = record(payload, channel)[key];
  if (!RELATION_KINDS.includes(value as RelationKind)) {
    throw new InvalidPayloadError(
      `${channel}: "${key}" must be one of ${RELATION_KINDS.join(', ')}`,
    );
  }
  return value as RelationKind;
}

export function isCellAction(value: unknown): value is CellAction {
  return CELL_ACTIONS.includes(value as CellAction);
}

/** Numeric layout params only; unknown keys are dropped rather than trusted. */
export function sanitizeLayoutParams(payload: unknown, channel: string): Record<string, number> {
  const source = record(payload, channel);
  const allowed = ['repulsion', 'attraction', 'gravity', 'damping', 'theta', 'linkDistance'];
  const result: Record<string, number> = {};

  for (const key of allowed) {
    const value = source[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new InvalidPayloadError(`${channel}: "${key}" must be a finite number`);
    }
    result[key] = value;
  }
  return result;
}
