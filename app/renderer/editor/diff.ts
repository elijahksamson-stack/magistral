/**
 * Line diff for the ✦ preview.
 *
 * The author never sees a silent overwrite. Before anything Claude produced can
 * touch a cell, it is shown against the current text as an explicit
 * added/removed/context list that the author accepts or rejects.
 */

export type DiffKind = 'context' | 'added' | 'removed';

export interface DiffLine {
  kind: DiffKind;
  text: string;
}

/**
 * Above this line count the O(n·m) table stops being worth it. Cells are
 * paragraphs, not files, so this only ever trips on pathological input.
 */
export const MAX_DIFF_LINES = 400;

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.split('\n');
}

function wholeBlockDiff(before: string[], after: string[]): DiffLine[] {
  return [
    ...before.map((text): DiffLine => ({ kind: 'removed', text })),
    ...after.map((text): DiffLine => ({ kind: 'added', text })),
  ];
}

/** Longest-common-subsequence lengths, `table[i][j]` for suffixes i.. and j.. */
function buildLcsTable(before: string[], after: string[]): number[][] {
  const table: number[][] = Array.from({ length: before.length + 1 }, () =>
    new Array<number>(after.length + 1).fill(0),
  );

  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      const row = table[i];
      const nextRow = table[i + 1];
      if (row === undefined || nextRow === undefined) continue;
      row[j] =
        before[i] === after[j]
          ? (nextRow[j + 1] ?? 0) + 1
          : Math.max(nextRow[j] ?? 0, row[j + 1] ?? 0);
    }
  }

  return table;
}

/**
 * A line-level diff of `before` -> `after`.
 *
 * Unchanged lines come back as `context` so the preview can show the edit in
 * place rather than as two disconnected blobs.
 */
export function diffLines(before: string, after: string): readonly DiffLine[] {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);

  if (beforeLines.length + afterLines.length > MAX_DIFF_LINES) {
    return wholeBlockDiff(beforeLines, afterLines);
  }

  const table = buildLcsTable(beforeLines, afterLines);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;

  while (i < beforeLines.length && j < afterLines.length) {
    const beforeLine = beforeLines[i] ?? '';
    const afterLine = afterLines[j] ?? '';

    if (beforeLine === afterLine) {
      out.push({ kind: 'context', text: beforeLine });
      i += 1;
      j += 1;
      continue;
    }

    const dropBefore = table[i + 1]?.[j] ?? 0;
    const dropAfter = table[i]?.[j + 1] ?? 0;

    if (dropBefore >= dropAfter) {
      out.push({ kind: 'removed', text: beforeLine });
      i += 1;
    } else {
      out.push({ kind: 'added', text: afterLine });
      j += 1;
    }
  }

  while (i < beforeLines.length) {
    out.push({ kind: 'removed', text: beforeLines[i] ?? '' });
    i += 1;
  }
  while (j < afterLines.length) {
    out.push({ kind: 'added', text: afterLines[j] ?? '' });
    j += 1;
  }

  return out;
}

export interface DiffStats {
  added: number;
  removed: number;
}

export function summarizeDiff(lines: readonly DiffLine[]): DiffStats {
  return lines.reduce<DiffStats>(
    (stats, line) => ({
      added: stats.added + (line.kind === 'added' ? 1 : 0),
      removed: stats.removed + (line.kind === 'removed' ? 1 : 0),
    }),
    { added: 0, removed: 0 },
  );
}
