/**
 * YAML export — the only export format besides the interactive page.
 *
 * Replaced both JSON exports. The canonical one carried `"damping": 0.85` and
 * node coordinates, which is the right content for a save file and the wrong
 * content for anything a person or a model reads. The outline one had the right
 * content in a format nobody wants to read a nested tree in.
 *
 * The document is the flat knowledge-only projection `outline.ts` builds: four
 * tables — nodes, notes, relationships, relationship notes — each fact stated
 * once and referenced by id. YAML just renders it without the punctuation.
 * Nothing here is re-importable, by design — the vault on disk is the
 * round-trip artefact.
 */

import { stringify } from 'yaml';

import type { KnowledgeGraph } from '../../../shared/types/graph';
import type { ExportResult } from '../../../shared/types/ipc';
import { fetchSnapshot, invoke } from '../graph/ipcClient';
import { buildKnowledgeMap, type KnowledgeMapDocument } from './outline';

const YAML_EXTENSION = '.yaml';
const UNSAFE_FILENAME_CHARS = /[\\/:*?"<>|]/g;
const FALLBACK_EXPORT_NAME = 'magistral';

/**
 * Wrap descriptions at a width that reads like prose in an editor rather than
 * running to one enormous line. Notes are the longest strings in the document.
 */
const LINE_WIDTH = 96;

export interface YamlExportOptions {
  readonly suggestedName?: string;
}

export function toYamlFileName(graphName: string): string {
  const cleaned = graphName.replace(UNSAFE_FILENAME_CHARS, '-').trim();
  const base = cleaned.length > 0 ? cleaned : FALLBACK_EXPORT_NAME;
  return base.toLowerCase().endsWith(YAML_EXTENSION) ? base : `${base}${YAML_EXTENSION}`;
}

export function isExportable(graph: KnowledgeGraph): boolean {
  return graph.nodes.length > 0 || graph.cells.length > 0;
}

/**
 * Render the knowledge map as YAML.
 *
 * Serialized by the `yaml` package rather than by hand: concept labels and
 * notes are arbitrary author text, and a label containing a colon, a leading
 * dash, or a `#` needs quoting that is easy to get subtly wrong. A file that
 * parses back to something slightly different from what was exported is worse
 * than one that fails outright.
 */
export function serializeMapYaml(document: KnowledgeMapDocument): string {
  return stringify(document, {
    lineWidth: LINE_WIDTH,
    // Long descriptions become readable block scalars instead of one quoted
    // line with \n escapes in it.
    blockQuote: 'literal',
    // A document that ends without a newline annoys every diff tool there is.
    indent: 2,
  });
}

/**
 * Resolves to the save result. Rejects — never resolves with a quiet failure —
 * when there is nothing worth writing. A dismissed save dialog is not an
 * error: it comes back as `{ saved: false }`.
 */
export async function exportGraphYaml(
  options: YamlExportOptions = {},
): Promise<ExportResult> {
  const graph = await fetchSnapshot();
  if (!isExportable(graph)) {
    throw new Error('Nothing to export — this vault has no cells or nodes yet.');
  }

  const map = buildKnowledgeMap(graph, new Date().toISOString());
  const suggestedName = options.suggestedName ?? toYamlFileName(graph.name);
  return invoke('export:yaml', { suggestedName, text: serializeMapYaml(map) });
}
