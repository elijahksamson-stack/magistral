/**
 * Assembles the single `-p` prompt string.
 *
 * Instruction wording lives in resources/knowledge/_system/<action>.md and is
 * appended by the CLI itself via --append-system-prompt-file. What is built
 * here is only the per-request material: corpus slices, graph context, and the
 * text being acted on. Keeping the two apart means prompt copy can be edited
 * without touching TypeScript.
 */

import type { CellAction, ClaudeInvokeRequest, GraphContext } from '../../../shared/types/claude';
import type { MapSnapshot } from '../../../shared/types/completion';
import { RELATION_KINDS } from '../../../shared/types/graph';
import { renderMap } from './mapSnapshot';

/** Enough context to be graph-aware without spending the budget on labels. */
const MAX_CONTEXT_LABELS = 40;

/**
 * The completion output contract.
 *
 * States the permissions in words as well, even though the schema already
 * makes the forbidden ones unrepresentable. Belt and braces on purpose: a
 * model told it may not delete writes better proposals than one that merely
 * finds no field for it, and the schema is still what actually guarantees it.
 */
export const COMPLETION_OUTPUT_CONTRACT = [
  'Respond with a single JSON object and nothing else — no prose, no code fence.',
  'Shape: {"newNodes":[{"label":string,"kind":"concept"|"entity"|"claim"|"question"|"source"|"metric","note"?:string,"group"?:string,"subConcepts"?:[{"label":string,"note"?:string}]}],',
  '"newEdges":[{"source":string,"target":string,"sourceParent"?:string,"targetParent"?:string,"relation":RelationKind,"note"?:string}],',
  '"edgeChanges":[{"source":string,"target":string,"sourceParent"?:string,"targetParent"?:string,"relation":RelationKind,"note"?:string,"reason"?:string}],',
  '"groupAdditions":[{"node":string,"group":string}],',
  '"rationale":string}',
  `RelationKind is one of: ${RELATION_KINDS.join(', ')}.`,
  'Refer to every concept by its exact label. You may create concepts, draw relationships,',
  'retype or redescribe a relationship that already exists, and place a concept in an existing group.',
  'Existing group labels may be endpoints of newEdges when the group itself has a semantic relationship',
  'beyond containment. Existing subnodes may be endpoints, but they remain nested. Use the exact child',
  'label and set sourceParent or targetParent to the exact existing parent that contains that child.',
  'Never put an existing subnode in newNodes. A child without an existing parent-child pair is invalid.',
  'You may NOT rename, delete, or reword an existing concept, and you may NOT delete a relationship.',
  'A label in "newNodes" that already exists in the map will be refused, so do not use it to revise one.',
  'Use "subConcepts" only when a new concept genuinely arrives with named parts, and give each part its own',
  'note. Do not invent facets to pad a concept, and never use it for something that deserves to be a concept',
  'in its own right — a sub-concept is detail recorded beneath its parent, not a node on the canvas.',
  '"edgeChanges" applies only to a pair that is already connected; use "newEdges" for a new connection.',
].join(' ');

function renderGraphContext(context: GraphContext | undefined): string {
  if (!context) return '';
  const lines = [
    `Graph: "${context.graphName}" — ${context.nodeCount} nodes, ${context.edgeCount} edges.`,
  ];
  const top = context.topNodeLabels.slice(0, MAX_CONTEXT_LABELS);
  if (top.length > 0) lines.push(`Most central concepts: ${top.join(', ')}.`);

  const linked = context.linkedNodeLabels.slice(0, MAX_CONTEXT_LABELS);
  if (linked.length > 0) lines.push(`Already linked from this passage: ${linked.join(', ')}.`);

  return lines.join('\n');
}

function section(title: string, body: string): string {
  return body.trim().length === 0 ? '' : `## ${title}\n${body.trim()}`;
}

export interface PromptInput {
  readonly request: ClaudeInvokeRequest;
  /** Rendered corpus slices, already budgeted. */
  readonly packText: string;
  /** The graph, for a completion request. Attached by main from the core. */
  readonly map?: MapSnapshot;
}

/** The text a request is routed on: what the packs are matched against. */
export function requestRoutingText(request: ClaudeInvokeRequest): string {
  const graphTerms = request.graphContext
    ? [...request.graphContext.topNodeLabels, ...request.graphContext.linkedNodeLabels].join(' ')
    : '';
  // A completion has no body of its own — the graph IS the subject, so the
  // labels alone decide which corpus sections it gets.
  const body =
    request.kind === 'cell'
      ? request.sourceDocument?.text || request.selectionText || request.cellMarkdown
      : request.kind === 'chat'
        ? request.message
        : request.kind === 'describe'
          ? // The concept and what it touches: the words the description will be
            // built from are the ones that should choose the corpus sections.
            [request.label, ...request.neighbours, ...(request.subConcepts ?? [])].join(' ')
          : (request.instruction ?? '');
  return `${body}\n${graphTerms}`;
}

const COMPLETION_TASK_LINE = [
  'Find the high-value cross-connections this map is missing and propose them for review.',
  'Audit node-to-node, node-to-subnode, subnode-to-subnode, cross-group, and meaningful',
  'group-to-node or group-to-subnode relationships. Prefer a small number of load-bearing',
  'bridges. Subnode-to-subnode includes subnodes under entirely different parent nodes; parent',
  'provenance is never a boundary. If the author narrows the connection level, return only that level.',
  'Prefer these over a long list of adjacent ideas. Every new edge needs a note that explains',
  'the mechanism, shared constraint, condition, or tension—not merely that the endpoints relate.',
  'Create a new concept only when it is the missing middle required to explain a bridge.',
].join(' ');

/*
 * Two or three sentences, no preamble. The answer is written straight into a
 * narrow detail panel, so anything conversational around it ("Certainly! Here
 * is…") has to be deleted by hand before the text is usable.
 */
/*
 * Deepening, not redrafting. A concept the author has already described is one
 * they have already thought about — the existing prose carries their judgement,
 * their emphasis and often a claim the map cannot show. Replacing it with a
 * fresh generic paragraph is a loss even when the new paragraph reads better,
 * so the instruction is explicit that the current text is the starting point
 * and its claims survive.
 */
const DEEPEN_TASK_LINE = [
  'Deepen the existing description below. It is the author\'s own, so keep its claims, its',
  'emphasis and its voice: sharpen the reasoning, make the mechanism explicit, and extend it',
  'using the relationships around this concept where they add something the text is missing.',
  'Do not restate it more elegantly and do not start over. Do not contradict it.',
  'Return the improved description only: no preamble, no heading, no bullet list, no quotation marks.',
].join(' ');

const DESCRIBE_TASK_LINE = [
  'Write a short description of the concept named below — two or three sentences, no more.',
  'Ground it in what this concept connects to and what sits beneath it: in this map a concept',
  'is largely defined by the relationships the author drew around it. Say what it IS and what',
  'work it does in this particular map, not what the words generically mean.',
  'Return the description only: no preamble, no heading, no bullet list, no quotation marks.',
].join(' ');

/*
 * A folder arrives with the hierarchy already decided. The author made those
 * directories; inferring a different shape from the prose inside them would
 * throw away the one piece of structure that is not a guess.
 *
 * The wikilink rules do the rest: the FIRST link in a cell names its node and
 * every later link becomes a sub-concept, so "folder first, one link per
 * subfolder" is all that is needed for the map to come out right.
 */
const FOLDER_STRUCTURE_LINE = [
  'This is a folder, not a single document. Its shape is the map:',
  'write [[Folder name]] FIRST, as the very first wikilink, with a short description of what the',
  'folder is about as a whole. Then write one [[Subfolder name]] link per subfolder, in the order',
  'given, each followed by a description distilled from the files inside that subfolder — what it',
  'covers, what it claims, and what it is for.',
  'Use the subfolder names as written. Do not invent subfolders, do not merge two into one, and do',
  'not promote a file to a subfolder. A subfolder with no readable documents still gets its link,',
  'described from its name alone.',
].join(' ');

const CELL_TASK_LINE: Record<CellAction, string> = {
  enhance: 'Sharpen the passage below. Keep every claim it makes; change only how clearly it lands.',
  continue: "Write the next paragraph, in the author's voice, continuing the passage below.",
  critique: 'Attack the reasoning in the passage below. Name the weakest link first.',
  distill: 'Compress the passage below to its load-bearing sentences.',
  'distill-import':
    'Read the imported document below and write the note the author would have written after reading it: takeaways, the logic behind them, conclusions, and open questions — with every concept wrapped in [[wikilinks]].',
};

export function buildPrompt({ request, packText, map }: PromptInput): string {
  const parts: string[] = [];

  parts.push(section('Reference material', packText));
  parts.push(section('Graph context', renderGraphContext(request.graphContext)));

  if (request.kind === 'chat') {
    parts.push(section('Question', request.message));
    return parts.filter(Boolean).join('\n\n');
  }

  if (request.kind === 'describe') {
    const existing = request.existing?.trim() ?? '';
    parts.push(section('Task', existing.length > 0 ? DEEPEN_TASK_LINE : DESCRIBE_TASK_LINE));
    parts.push(section('The concept to describe', request.label));
    if (existing.length > 0) {
      parts.push(section('The description as it stands', existing));
    }
    if (request.parentLabel) {
      parts.push(section('It sits underneath', request.parentLabel));
    }
    parts.push(
      section(
        'What it connects to',
        request.neighbours.length > 0
          ? request.neighbours.join('\n')
          : '(nothing yet — describe it on its own terms)',
      ),
    );
    if (request.subConcepts && request.subConcepts.length > 0) {
      parts.push(section('Sub-concepts beneath it', request.subConcepts.join('\n')));
    }
    return parts.filter(Boolean).join('\n\n');
  }

  if (request.kind === 'complete') {
    parts.push(section('Task', COMPLETION_TASK_LINE));
    // The map goes in even when empty. An author who clicks this on a blank
    // graph should get a starting structure, not a refusal.
    parts.push(section('The map as it stands', map ? renderMap(map) : '(the map is empty)'));
    if (request.instruction) {
      parts.push(section('What the author asked you to focus on', request.instruction));
    }
    parts.push(section('Output format', COMPLETION_OUTPUT_CONTRACT));
    return parts.filter(Boolean).join('\n\n');
  }

  parts.push(section('Task', CELL_TASK_LINE[request.action]));

  // An import reads a document rather than the cell: the cell is created empty
  // to receive the result, so there is no passage to act on.
  if (request.action === 'distill-import' && request.sourceDocument) {
    const { name, text, isTruncated, isFolder } = request.sourceDocument;
    // A second "## Task" would compete with the one already pushed above; the
    // folder rule is an additional constraint on that task, not a new one.
    if (isFolder) parts.push(section('Structure to preserve', FOLDER_STRUCTURE_LINE));
    parts.push(
      section(
        isFolder ? 'Imported folder' : 'Imported document',
        `${isFolder ? 'Folder' : 'File'}: ${name}`,
      ),
    );
    if (isTruncated) {
      parts.push(
        section(
          'Note',
          'This document was longer than the import limit and has been truncated. Distil what is here; do not speculate about the remainder.',
        ),
      );
    }
    parts.push(section('Document text', text));
    return parts.filter(Boolean).join('\n\n');
  }

  const target = request.selectionText?.trim();
  parts.push(section('Passage', request.cellMarkdown));
  if (target) parts.push(section('Act on this selection only', target));

  return parts.filter(Boolean).join('\n\n');
}
