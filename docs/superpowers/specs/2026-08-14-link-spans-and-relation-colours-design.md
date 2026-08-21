# Link spans and relation colours

Slice A and A′ of the five-part improvement programme. A rewrites how a
`[[wikilink]]` acquires its description; A′ gives each relation kind a colour and
puts the relations present in the map into the legend.

Status: design approved 2026-08-14. Baseline before work: 109 C++ test cases,
`tsc --noEmit` clean, 877 vitest tests, all green.

---

## A · A link owns everything until the next link

### The problem

`flattenLine` (`core/src/wikilink.cpp:65`) takes a sub-concept's note from the
whole LINE its link sits on. A soft-wrapped paragraph is one line, so several
links in one paragraph all receive the same paragraph as their description.

Authoring this cell:

```markdown
[[Sports]]

[[Basketball]] scores by shot distance... [[Volleyball]] keeps its scoring
constant... [[Baseball]] paces itself over 9 innings...
```

gives Basketball, Volleyball and Baseball an identical description — the entire
paragraph. `app/renderer/graph/subConceptNote.ts:13` documents this as intended.
It is not what an author expects, and it makes every multi-concept paragraph
unreadable in the detail panel.

A second, independent defect in the same code path: `subConceptNote.ts:34`
builds `/\[\[\s*Label\s*\]\]/i`, which cannot match `[[Volleyball|the net game]]`.
`setSubConceptNote` then returns the markdown unchanged and `GraphPane.tsx:911`
bails on `rewritten === markdown` without an error, silently discarding what the
author typed. `conceptSection.ts:43` already tolerates the alias, so the two
halves of the same feature disagree.

### The rule

One rule replaces both `flattenLine` and `findConceptSection`:

> Scanning a cell in document order, each `[[link]]` owns the text from the end
> of its own `]]` until the start of the next `[[link]]`, or the end of the cell.
> The first link names the node and its span is the node's description. Every
> later link is a sub-concept and its span is that sub-concept's description.

Line boundaries stop mattering. A link alone on a line owns the prose beneath it
because nothing intervenes before the next link — the heading case falls out of
the general rule instead of needing its own function.

### Worked examples

The author's own example, all on one line:

```markdown
[[Greeting]] hi how are you [[Response]] good and you? [[Final Response]] Kinda tired, ready for bed.
```

| Link | Role | Description |
|---|---|---|
| Greeting | node | `hi how are you` |
| Response | sub-concept | `good and you?` |
| Final Response | sub-concept | `Kinda tired, ready for bed.` |

The `test` vault cell:

| Link | Role | Description |
|---|---|---|
| Sports | node | *(empty — nothing sits between it and `[[Basketball]]`)* |
| Basketball | sub-concept | `scores by shot distance… the attempt.` |
| Volleyball | sub-concept | `keeps its scoring… the rules of the game.` |
| Baseball | sub-concept | `paces itself over 9 innings… while you eat.` |

Section-style authoring keeps working unchanged:

```markdown
## [[Direct Versus Embedded Material Demand]]

Data-center demand reaches materials through two channels.
* Concrete

## [[Next Concept]]
```

The first link owns the prose and the bullet; `Next Concept` owns nothing yet.

### Span edges

Two trims, and no others. The span is otherwise the author's raw text —
matching what `conceptSectionText` already returns for sections today.

**Leading separator.** A run of whitespace and `-`, `–`, `—`, `:`, `,`, `|`, `>`
immediately after `]]` is dropped, so `[[X]] — foo` and `[[X]]: foo` both
describe X as `foo`.

**Trailing orphaned prefix.** A span ends at the *next link's* first `[`, which
means the next link's own line prefix falls inside it. In the section example
above, the first span would otherwise end with `\n\n## `. If the text after the
final newline is only heading marks, a list marker, a blockquote mark or an
ordinal, that whole trailing line is dropped.

Deliberately **not** carried over from `flattenLine`: the global stripping of
`*`, `_`, `` ` `` and `#` characters. It mangles ordinary prose (`2*3` became
`23`) and sections never had it applied. Spans contain no complete link by
construction, so the link-unwrapping `flattenLine` did is also unnecessary.

Duplicate labels keep today's behaviour: dedup by normalized label, first
occurrence wins. This matches `setSubConceptNote`'s documented rule that only
the first occurrence is editable.

Fenced code blocks are still skipped. Because spans cross lines, the scanner
first masks fenced regions to spaces — preserving length and newlines so offsets
stay valid — then scans the masked text. Code inside a fence can therefore never
become part of a description.

### The write path must agree

Descriptions are derived, never stored: `reconcileCellLinks` rebuilds them from
the markdown on every edit. So narrowing the read without narrowing the write
would make the first panel edit clobber the neighbouring concepts' prose.

`conceptSection.ts` and `subConceptNote.ts` collapse into one module,
`app/renderer/graph/linkSpan.ts`:

```ts
export interface LinkSpan {
  readonly label: string;
  readonly linkStart: number;
  readonly linkEnd: number;
  /** After the leading separator run, so the author's `— ` survives a rewrite. */
  readonly bodyStart: number;
  /** Before the trailing orphaned prefix, so the next link's `## ` survives. */
  readonly bodyEnd: number;
}

export function findLinkSpans(markdown: string): LinkSpan[];
export function linkSpanText(markdown: string, label: string): string | null;
export function setLinkSpanText(markdown: string, label: string, text: string): string;
```

`bodyStart` and `bodyEnd` are deliberately narrower than the raw span so a
rewrite preserves formatting that belongs to the author or to the next link.

Writing picks its shape from the shape the author used: block form
(`\n\n` … `\n\n`) when a newline separates the link from its old body or when the
link sits alone on its line, inline form (one space) otherwise.

**The alias bug dies structurally.** Spans are located by scanning and comparing
parsed link targets, not by building a regex per label, so `[[Volleyball|the net
game]]` is found the same way as `[[Volleyball]]`. The class of bug cannot recur
because the regex it depended on is gone.

`GraphPane.tsx` loses its heading-vs-inline branch at both call sites (lines
861–871 and 907–910). The silent `if (rewritten === markdown) return;` becomes an
error surfaced through `setPaneError`, since after this change an unchanged
result means the label genuinely is not in the cell — a real failure worth
saying out loud. Nodes with no cell at all keep the `setNodeNote` fallback.

### Existing vaults need a re-parse

`note` and `subConcepts` are persisted in the graph JSON, and
`installGraph` (`graph-service.ts:270`) hands that JSON straight to
`addon.graphFromJSON` without re-parsing. Ship the parser change alone and the
`economy` vault still shows its old descriptions until every cell is retyped —
the fix would be invisible on real data.

`openFromJSON` therefore re-syncs every cell after installing the graph, beside
the existing `logCoverageRepair` hook. `syncCell` is idempotent, so re-running it
is safe; the count of cells whose description changed is logged the way coverage
repair already logs.

This goes in `openFromJSON` only. `installGraph` is shared with the snapshot path
at line 133, which must not pay for a re-parse on every read.

### Files

| File | Change |
|---|---|
| `core/src/wikilink.cpp` | Span scanner replaces `flattenLine`; `parseWikiLinks` refactored onto the same scanner |
| `core/src/wikilink.hpp` | Unchanged — `WikiLinkHit` already carries label + note |
| `core/tests/test_index.cpp` | Span cases, including both worked examples above |
| `app/renderer/graph/linkSpan.ts` | New; replaces `conceptSection.ts` + `subConceptNote.ts` |
| `app/renderer/graph/GraphPane.tsx` | Single write path; silent bail becomes a reported error |
| `app/main/graph-service.ts` | Re-sync every cell in `openFromJSON` |

### Testing

C++ doctest covers the rule: both worked examples, an empty span, a span ending
at a fence, an aliased link, a duplicate label, and the trailing-prefix trim.
Vitest covers `linkSpan.ts` round-tripping — read a description, write it back
unchanged, and assert the markdown is byte-identical — plus the aliased-link
write that silently failed before. A `graph-service` test asserts a vault
carrying stale notes comes back with corrected ones after open.

---

## A′ · A colour per relation, and a legend that lists them

### The problem

`EDGE_COLOR = '#263437'` is flat for all ten `RelationKind`s
(`constants.ts:56`), so the Filters panel already offers ten relation checkboxes
with nothing on the canvas to tell them apart. The Legend panel
(`GraphToolbar.tsx:186`) lists node kinds only.

### The change

`RELATION_COLORS: Record<RelationKind, string>` in `constants.ts`, exhaustive by
type so adding a relation kind fails the build rather than silently drawing grey.
`drawEdges` (`renderer.ts:437`) uses it, keeping the existing highlight override
so hover and selection still win.

Cyan (`#45c6d4`) and lime stay reserved — selection and AI findings mean those
colours already, and a relation wearing one would read as state, not type.
`relates_to` and `mentions` stay deliberately quiet: they are the untyped
defaults and the map should not shout them.

The Legend gains a Relationships section listing **only the relations present in
the graph**, as requested, so a map using three relation kinds shows three rows
rather than ten. The Filters checkboxes get the matching swatch, so the two
panels agree.

### Files

| File | Change |
|---|---|
| `app/renderer/graph/constants.ts` | `RELATION_COLORS` |
| `app/renderer/graph/renderer.ts` | Colour edges by relation |
| `app/renderer/graph/GraphToolbar.tsx` | Legend section + filter swatches |

### Testing

A renderer test asserts two edges of different kinds are stroked in different
colours and that highlight still overrides. A toolbar test asserts the legend
lists exactly the relations present — not all ten — and that swatches match
`RELATION_COLORS`.

---

## Out of scope

Slices B (chat "no node for X" → create), C (live auto-map toggle), D (folder
import) and E (Obsidian parity) are specified separately. B carries a contract
change to `shared/types/completion.ts` — `ProposedNode` has no `subConcepts`
field — which needs its own decision under CLAUDE.md rule 5.
