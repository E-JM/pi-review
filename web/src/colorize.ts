// Pure helpers for stateful per-line colorization of unified diff rows.
// No DOM and no monaco imports so this stays unit-testable under node:test.

export type DiffSide = "original" | "modified";

export interface ColorizableRow {
  type: "equal" | "add" | "del";
  oldLine: number | null;
  newLine: number | null;
}

export interface SideEligibility {
  original: boolean;
  modified: boolean;
}

export interface WordSpanLike {
  text: string;
  kind: "equal" | "add" | "del";
}

export interface WordBound {
  start: number;
  end: number;
  className: string;
}

export interface WordPiece {
  text: string;
  className: string | null;
}

// Changed-fragment extents over the concatenated word-diff span text, for
// boxing pieces of a tokenized line without touching its non-text markup.
export function wordBounds(spans: readonly WordSpanLike[]): WordBound[] {
  const bounds: WordBound[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.kind !== "equal" && span.text.length > 0) {
      bounds.push({ start: cursor, end: cursor + span.text.length, className: `u-w-${span.kind}` });
    }
    cursor += span.text.length;
  }
  return bounds;
}

// Splits one text run at word-diff boundaries. `offset` is the run's position
// within the concatenated span text and `startIndex` the first bound that
// could overlap it. Piece texts concatenate back to `value`; pieces inside a
// changed fragment carry its box class. Every loop step consumes text or a
// bound, so degenerate bounds cannot stall the split.
export function splitAtWordBounds(value: string, offset: number, bounds: readonly WordBound[], startIndex: number): { pieces: WordPiece[]; nextIndex: number } {
  const pieces: WordPiece[] = [];
  let index = startIndex;
  let local = 0;
  while (local < value.length) {
    const bound = bounds[index];
    if (bound == null || offset + local < bound.start) {
      const end = bound == null ? value.length : Math.min(value.length, local + bound.start - (offset + local));
      pieces.push({ text: value.slice(local, end), className: null });
      local = end;
      continue;
    }
    if (offset + local >= bound.end) {
      index += 1;
      continue;
    }
    const end = Math.min(value.length, local + bound.end - (offset + local));
    pieces.push({ text: value.slice(local, end), className: bound.className });
    local = end;
    if (offset + local >= bound.end) index += 1;
  }
  return { pieces, nextIndex: index };
}

// Which file side supplies a row's stateful colorization. Additions exist only
// in the modified file and deletions only in the original; equal rows exist in
// both and prefer whichever side is colorizable (their contents are identical).
export function colorizeSourceFor(row: ColorizableRow, eligible: SideEligibility): { side: DiffSide; line: number } | null {
  if (row.type === "del") {
    return eligible.original && row.oldLine != null ? { side: "original", line: row.oldLine } : null;
  }
  if (row.type === "add") {
    return eligible.modified && row.newLine != null ? { side: "modified", line: row.newLine } : null;
  }
  if (eligible.modified && row.newLine != null) return { side: "modified", line: row.newLine };
  if (eligible.original && row.oldLine != null) return { side: "original", line: row.oldLine };
  return null;
}

// monaco.editor.colorize tokenizes with state carried across lines and joins
// the per-line HTML with "<br/>". Token text is HTML-escaped, so the separator
// cannot occur inside a chunk, and chunk i is exactly line i+1 of the colorized
// text. colorize terminates every line — including the last — with "<br/>",
// making the final split chunk empty; tolerate a renderer without the
// terminator by only dropping that trailing empty chunk.
export function splitColorizedLines(html: string): string[] {
  const chunks = html.split("<br/>");
  if (chunks[chunks.length - 1] === "") chunks.pop();
  return chunks;
}
