/**
 * Validation entry points bound to shared/schema/graph.schema.json.
 *
 * Two boundaries depend on these and neither may trust its input:
 *   - vault.ts, loading graph.json off disk (it may be truncated or hand-edited)
 *   - the core's mergeExtraction payload (no app path reaches it today; see
 *     graph-service.mergeExtraction)
 */

import rawSchema from '../../../shared/schema/graph.schema.json';
import type { ExtractionResult, KnowledgeGraph } from '../../../shared/types/graph';
import { validateAgainstSchema, type SchemaNode, type ValidationResult } from './validator';

const GRAPH_SCHEMA = rawSchema as unknown as SchemaNode;

const DEFS = (GRAPH_SCHEMA.$defs ?? {}) as Record<string, SchemaNode>;

const EXTRACTION_RESULT_SCHEMA = DEFS.extractionResult;

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

function describe(result: ValidationResult): string {
  return result.valid ? '' : result.errors.join('; ');
}

/** Validate a full KnowledgeGraph document. */
export function validateKnowledgeGraph(value: unknown): ParseResult<KnowledgeGraph> {
  const result = validateAgainstSchema(value, GRAPH_SCHEMA, GRAPH_SCHEMA);
  if (!result.valid) return { ok: false, reason: describe(result) };
  return { ok: true, value: value as KnowledgeGraph };
}

/** Validate a mergeExtraction payload against $defs/extractionResult. */
export function validateExtractionResult(value: unknown): ParseResult<ExtractionResult> {
  if (!EXTRACTION_RESULT_SCHEMA) {
    return { ok: false, reason: 'graph.schema.json is missing $defs/extractionResult' };
  }
  const result = validateAgainstSchema(value, EXTRACTION_RESULT_SCHEMA, GRAPH_SCHEMA);
  if (!result.valid) return { ok: false, reason: describe(result) };
  return { ok: true, value: value as ExtractionResult };
}

/** Parse JSON text, then validate it as a KnowledgeGraph. Never throws. */
export function parseKnowledgeGraph(text: string): ParseResult<KnowledgeGraph> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error: unknown) {
    return {
      ok: false,
      reason: `not valid JSON (${error instanceof Error ? error.message : 'parse failed'})`,
    };
  }
  return validateKnowledgeGraph(parsed);
}
