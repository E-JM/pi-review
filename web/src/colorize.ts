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
