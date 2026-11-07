import { diffLines, diffWordsWithSpace, type Change } from "diff";

// Pure diff geometry shared by the unified view. No DOM here so it stays unit-testable.

export type RowType = "equal" | "add" | "del";

export interface WordSpan {
  text: string;
  kind: RowType;
}

export interface DiffRow {
  type: RowType;
  oldLine: number | null;
  newLine: number | null;
  text: string;
  // Intra-line word diff, precomputed for paired del/add rows.
  spans?: WordSpan[];
  // Set when the source line exceeded MAX_LINE_DISPLAY and was truncated for
  // display; carries the original length so the renderer can say how much
  // is hidden. Display truncation keeps megabyte-long lines (minified
  // bundles, base64 blobs) out of the DOM and out of the layout engine.
  fullLength?: number;
}

// [start, end) over row indexes.
export interface Interval {
  start: number;
  end: number;
}

export interface DiffStats {
  additions: number;
  deletions: number;
}

export interface DiffModel {
  rows: DiffRow[];
  hunks: Interval[];
  stats: DiffStats;
  binary: boolean;
  oldNoEol: boolean;
  newNoEol: boolean;
  oldLastLine: number;
  newLastLine: number;
}

export type LayoutItem =
  | { kind: "gap"; start: number; end: number; above: boolean; below: boolean }
  | { kind: "hunk"; start: number; end: number; header: string };

const CONTEXT = 3;
export const EXPAND_STEP = 10;
// Initial render bound per contiguous hunk. DOM size is governed by visible
// intervals (equal rows between hunks are never built), so this only caps a
// single oversized hunk — a whole-file rewrite — whose remainder becomes an
// ordinary expandable gap.
const ROW_CAP = 20000;
// Display cap per line. Lines beyond this (minified bundles, embedded base64)
// are shown truncated; their full length is reported by a marker.
const MAX_LINE_DISPLAY = 2000;
// jsdiff's Myers core is O((N+M)·D). Past these budgets a near-total rewrite
// would freeze the tab for minutes, so it degrades to whole-file del/add.
const DIFF_FAST_TOTAL = 10000;
const DIFF_FALLBACK_UNSHARED = 5000;
const FUNC_SCAN_LIMIT = 200;
const FUNC_NAME_MAX = 100;
const WORD_DIFF_MAX_CHARS = 500;
const SIMILARITY_THRESHOLD = 0.5;

// Anchored per-language patterns for the @@ hunk-header function context.
const FUNC_PATTERNS: Record<string, RegExp[]> = {
  python: [/^\s*(?:async\s+)?def\b/, /^\s*class\b/],
  typescript: [
    /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?function\b/,
    /^\s*(?:export\s+)?(?:abstract\s+)?(?:declare\s+)?class\b/,
    /^\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?(?:\(|function\b)/,
    /^\s*(?:export\s+)?(?:interface|enum|namespace|type)\b/,
  ],
  javascript: [
    /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\b/,
    /^\s*(?:export\s+)?class\b/,
    /^\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?(?:\(|function\b)/,
  ],
  rust: [
    /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:unsafe\s+)?(?:async\s+)?fn\b/,
    /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|impl|mod|macro_rules)\b/,
  ],
  go: [/^\s*func\b/, /^\s*type\b/],
  java: [/^\s*(?:public|private|protected)\s[\w<>\[\],\s]*\s+\w+\s*\(/],
  kotlin: [/^\s*(?:private|internal|public)?\s*(?:suspend\s+)?fun\b/, /^\s*(?:data\s+)?class\b/, /^\s*object\b/],
  shell: [/^\s*function\s+\w+/, /^\s*\w+\s*\(\)\s*\{/],
};

function splitLines(value: string): string[] {
  // Line tokens include their trailing newline; a lookbehind split keeps them
  // attached so the part count matches the change's `count` exactly.
  const parts = value.split(/(?<=\n)/);
  if (parts.length > 0 && parts[parts.length - 1] === "" && parts.length > 1) parts.pop();
  return parts;
}

function cleanText(raw: string): string {
  return raw.replace(/\r?\n$/, "");
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length > WORD_DIFF_MAX_CHARS || b.length > WORD_DIFF_MAX_CHARS) return 0;
  const count = (text: string) => {
    const counts = new Map<string, number>();
    for (const token of text.toLowerCase().match(/[a-z0-9_]+/g) ?? []) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
    return counts;
  };
  const left = count(a);
  const right = count(b);
  let leftTotal = 0;
  let rightTotal = 0;
  let shared = 0;
  for (const [token, n] of left) {
    leftTotal += n;
    const m = right.get(token);
    if (m != null) shared += Math.min(n, m);
  }
  for (const n of right.values()) rightTotal += n;
  const largest = Math.max(leftTotal, rightTotal);
  return largest === 0 ? 1 : shared / largest;
}

function spansFor(changes: Change[], side: "del" | "add"): WordSpan[] {
  const spans: WordSpan[] = [];
  for (const change of changes) {
    if (side === "del" && change.added) continue;
    if (side === "add" && change.removed) continue;
    if (!change.value) continue;
    spans.push({ text: change.value, kind: change.added ? "add" : change.removed ? "del" : "equal" });
  }
  return spans;
}

function pairBlocks(rows: DiffRow[], delStart: number, delEnd: number, addStart: number, addEnd: number): void {
  const pairs = Math.min(delEnd - delStart, addEnd - addStart);
  for (let offset = 0; offset < pairs; offset += 1) {
    const del = rows[delStart + offset];
    const add = rows[addStart + offset];
    if (del.text === add.text) continue;
    if (similarity(del.text, add.text) < SIMILARITY_THRESHOLD) continue;
    const changes = diffWordsWithSpace(del.text, add.text);
    del.spans = spansFor(changes, "del");
    add.spans = spansFor(changes, "add");
  }
}

// Word-diff adjacent del/add blocks. jsdiff v6+ emits deletions before
// insertions, but handle either order so a swapped algorithm stays correct.
function pairWordSpans(rows: DiffRow[]): void {
  let i = 0;
  while (i < rows.length) {
    const type = rows[i].type;
    if (type === "equal") {
      i += 1;
      continue;
    }
    let sameEnd = i;
    while (sameEnd < rows.length && rows[sameEnd].type === type) sameEnd += 1;
    const other: RowType = type === "del" ? "add" : "del";
    let otherEnd = sameEnd;
    while (otherEnd < rows.length && rows[otherEnd].type === other) otherEnd += 1;
    const first = { start: i, end: sameEnd };
    const second = { start: sameEnd, end: otherEnd };
    if (type === "del") pairBlocks(rows, first.start, first.end, second.start, second.end);
    else pairBlocks(rows, second.start, second.end, first.start, first.end);
    i = otherEnd;
  }
}

export function groupHunks(rows: DiffRow[], context = CONTEXT): Interval[] {
  const hunks: Interval[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].type === "equal") continue;
    const start = Math.max(0, i - context);
    const end = Math.min(rows.length, i + context + 1);
    const last = hunks[hunks.length - 1];
    // Merge overlapping AND touching windows; a zero-row gap would render a
    // bogus "0 unchanged lines" row.
    if (last != null && start <= last.end) last.end = Math.max(last.end, end);
    else hunks.push({ start, end });
  }
  return hunks;
}

export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    if (interval.end <= interval.start) continue;
    const last = merged[merged.length - 1];
    if (last != null && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}

// Reveal `count` rows beginning at `start`, merging into existing visibility.
export function revealRange(visible: Interval[], start: number, count: number, total: number): Interval[] {
  const from = Math.max(0, start);
  const to = Math.min(total, start + count);
  if (to <= from) return visible;
  return mergeIntervals([...visible, { start: from, end: to }]);
}

export function clampIntervals(visible: Interval[], total: number): Interval[] {
  return mergeIntervals(visible.map((interval) => ({
    start: Math.max(0, Math.min(interval.start, total)),
    end: Math.max(0, Math.min(interval.end, total)),
  })));
}

export function initialIntervals(model: DiffModel): Interval[] {
  // A hunk larger than ROW_CAP (a whole-file rewrite) starts clamped; its
  // remainder turns into an ordinary expandable gap in the renderer.
  return model.hunks.map((hunk) => ({ start: hunk.start, end: Math.min(hunk.end, hunk.start + ROW_CAP) }));
}

export function rowIndexMap(rows: DiffRow[]): Map<string, number> {
  const map = new Map<string, number>();
  rows.forEach((row, index) => {
    if (row.oldLine != null) map.set(`original:${row.oldLine}`, index);
    if (row.newLine != null) map.set(`modified:${row.newLine}`, index);
  });
  return map;
}

export function hunkHeader(rows: DiffRow[], start: number, end: number, language: string): string {
  let oldCount = 0;
  let newCount = 0;
  let oldStart: number | null = null;
  let newStart: number | null = null;
  for (let i = start; i < end; i += 1) {
    if (rows[i].oldLine != null) {
      oldCount += 1;
      if (oldStart == null) oldStart = rows[i].oldLine;
    }
    if (rows[i].newLine != null) {
      newCount += 1;
      if (newStart == null) newStart = rows[i].newLine;
    }
  }
  if (oldStart == null) oldStart = nearestLine(rows, start, "oldLine");
  if (newStart == null) newStart = nearestLine(rows, start, "newLine");
  const oldPart = oldCount === 1 ? `${oldStart}` : `${oldStart},${oldCount}`;
  const newPart = newCount === 1 ? `${newStart}` : `${newStart},${newCount}`;
  const name = hunkFunctionName(rows, start, end, language);
  return `@@ -${oldPart} +${newPart} @@${name ? ` ${name}` : ""}`;
}

function nearestLine(rows: DiffRow[], from: number, side: "oldLine" | "newLine"): number {
  for (let i = from - 1; i >= 0; i -= 1) {
    const line = rows[i][side];
    if (line != null) return line;
  }
  return 0;
}

function hunkFunctionName(rows: DiffRow[], start: number, end: number, language: string): string | null {
  const patterns = FUNC_PATTERNS[language];
  if (patterns == null || patterns.length === 0) return null;
  let hasNew = false;
  for (let i = start; i < end; i += 1) {
    if (rows[i].newLine != null) {
      hasNew = true;
      break;
    }
  }
  const side = hasNew ? "newLine" : "oldLine";
  let scanned = 0;
  for (let i = start; i >= 0 && scanned < FUNC_SCAN_LIMIT; i -= 1) {
    // Changed lines are never function context — an added "def inner():" must
    // not report itself as its own enclosing function. Only equal rows count.
    if (rows[i].type !== "equal") continue;
    if (rows[i][side] == null) continue;
    scanned += 1;
    const text = rows[i].text;
    if (!text.trim()) continue;
    if (patterns.some((pattern) => pattern.test(text))) {
      const trimmed = text.trim();
      return trimmed.length > FUNC_NAME_MAX ? `${trimmed.slice(0, FUNC_NAME_MAX)}…` : trimmed;
    }
  }
  return null;
}

export function computeLayout(rows: DiffRow[], visible: Interval[], commentRows: ReadonlySet<number>, language: string): LayoutItem[] {
  const forced: Interval[] = [];
  for (const index of commentRows) {
    if (index >= 0 && index < rows.length) forced.push({ start: index, end: index + 1 });
  }
  const effective = mergeIntervals([...visible, ...forced].map((interval) => ({
    start: Math.max(0, interval.start),
    end: Math.min(rows.length, interval.end),
  })));
  const items: LayoutItem[] = [];
  let cursor = 0;
  for (const interval of effective) {
    if (interval.start > cursor) {
      items.push({ kind: "gap", start: cursor, end: interval.start, above: cursor > 0, below: true });
    }
    items.push({ kind: "hunk", start: interval.start, end: interval.end, header: hunkHeader(rows, interval.start, interval.end, language) });
    cursor = interval.end;
  }
  if (cursor < rows.length) {
    items.push({ kind: "gap", start: cursor, end: rows.length, above: cursor > 0, below: false });
  }
  return items;
}

export function buildDiffModel(original: string, modified: string): DiffModel {
  if (original.includes("\u0000") || modified.includes("\u0000")) {
    return { rows: [], hunks: [], stats: { additions: 0, deletions: 0 }, binary: true, oldNoEol: false, newNoEol: false, oldLastLine: 0, newLastLine: 0 };
  }
  let changes = guardedDiff(original, modified);
  if (changes == null) {
    // Near-total rewrite of a large file: skip jsdiff's quadratic core and
    // emit the whole file as one del block + one add block.
    changes = [];
    if (original !== "") changes.push({ count: countLines(original), value: original, added: false, removed: true });
    if (modified !== "") changes.push({ count: countLines(modified), value: modified, added: true, removed: false });
  }
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const change of changes) {
    if (!change.value) continue;
    const type: RowType = change.added ? "add" : change.removed ? "del" : "equal";
    const parts = splitLines(change.value);
    for (const raw of parts) {
      if (type !== "add") oldLine += 1;
      if (type !== "del") newLine += 1;
      const full = cleanText(raw);
      const truncated = full.length > MAX_LINE_DISPLAY;
      rows.push({
        type,
        oldLine: type === "add" ? null : oldLine,
        newLine: type === "del" ? null : newLine,
        text: truncated ? full.slice(0, MAX_LINE_DISPLAY) : full,
        ...(truncated ? { fullLength: full.length } : {}),
      });
    }
  }
  const stats: DiffStats = { additions: 0, deletions: 0 };
  for (const row of rows) {
    if (row.type === "add") stats.additions += 1;
    else if (row.type === "del") stats.deletions += 1;
  }
  const hunks = groupHunks(rows, CONTEXT);
  pairWordSpans(rows);
  return {
    rows,
    hunks,
    stats,
    binary: false,
    oldNoEol: original.length > 0 && !original.endsWith("\n"),
    newNoEol: modified.length > 0 && !modified.endsWith("\n"),
    oldLastLine: original === "" ? 0 : countLines(original),
    newLastLine: modified === "" ? 0 : countLines(modified),
  };
}

// Returns null when the diff shape would make jsdiff quadratic past the
// budget; the caller then degrades to whole-file del/add blocks.
function guardedDiff(original: string, modified: string): Change[] | null {
  if (countLines(original) + countLines(modified) <= DIFF_FAST_TOTAL) {
    return diffLines(original, modified, { ignoreNewlineAtEof: true, stripTrailingCr: true });
  }
  const oldArr = original.split("\n");
  const newArr = modified.split("\n");
  const prefix = commonRun(oldArr, newArr, 0);
  const suffix = commonSuffix(oldArr, newArr, prefix);
  const unshared = Math.min(oldArr.length, newArr.length) - prefix - suffix;
  if (unshared <= DIFF_FALLBACK_UNSHARED) {
    return diffLines(original, modified, { ignoreNewlineAtEof: true, stripTrailingCr: true });
  }
  return null;
}

function commonRun(a: string[], b: string[], skip: number): number {
  const limit = Math.min(a.length, b.length) - skip;
  let i = 0;
  while (i < limit && a[skip + i] === b[skip + i]) i += 1;
  return i;
}

function commonSuffix(a: string[], b: string[], prefix: number): number {
  const limit = Math.min(a.length, b.length) - prefix;
  let i = 0;
  while (i < limit && a[a.length - 1 - i] === b[b.length - 1 - i]) i += 1;
  return i;
}

function countLines(text: string): number {
  let total = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") total += 1;
  }
  return text.endsWith("\n") ? total : total + 1;
}
