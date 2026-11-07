import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDiffModel,
  clampIntervals,
  computeLayout,
  groupHunks,
  hunkHeader,
  initialIntervals,
  mergeIntervals,
  revealRange,
  rowIndexMap,
  type DiffRow,
} from "../web/src/diff-model.js";

function lines(from: number, to: number, prefix = "L"): string {
  const out: string[] = [];
  for (let i = from; i <= to; i += 1) out.push(`${prefix}${i}`);
  return out.join("\n") + "\n";
}

test("rows: line numbers stay continuous across blocks (no phantom rows)", () => {
  const model = buildDiffModel("a\nb\nc\n", "a\nX\nc\n");
  assert.deepEqual(
    model.rows.map((row) => [row.type, row.oldLine, row.newLine, row.text]),
    [
      ["equal", 1, 1, "a"],
      ["del", 2, null, "b"],
      ["add", null, 2, "X"],
      ["equal", 3, 3, "c"],
    ],
  );
  assert.deepEqual(model.stats, { additions: 1, deletions: 1 });
});

test("rows: identical content produces only equal rows and no hunks", () => {
  const model = buildDiffModel("a\nb\n", "a\nb\n");
  assert.equal(model.rows.length, 2);
  assert.ok(model.rows.every((row) => row.type === "equal"));
  assert.equal(model.hunks.length, 0);
  assert.deepEqual(model.stats, { additions: 0, deletions: 0 });
});

test("rows: missing trailing newline does not fake a change (ignoreNewlineAtEof)", () => {
  const model = buildDiffModel("a\nb\nc\n", "a\nb\nc");
  assert.equal(model.rows.length, 3);
  assert.deepEqual(model.stats, { additions: 0, deletions: 0 });
  assert.equal(model.oldNoEol, false);
  assert.equal(model.newNoEol, true);
  assert.equal(model.newLastLine, 3);
});

test("rows: CRLF content is stripped of carriage returns", () => {
  const model = buildDiffModel("foo\r\nbar\r\n", "foo\r\nbaz\r\n");
  assert.deepEqual(model.rows.map((row) => [row.type, row.text]), [
    ["equal", "foo"],
    ["del", "bar"],
    ["add", "baz"],
  ]);
  assert.deepEqual(model.stats, { additions: 1, deletions: 1 });
});

test("rows: added file is all-add with @@ -0,0 header", () => {
  const model = buildDiffModel("", "x\ny\n");
  assert.ok(model.rows.every((row) => row.type === "add"));
  assert.equal(model.hunks.length, 1);
  assert.equal(hunkHeader(model.rows, model.hunks[0].start, model.hunks[0].end, "plaintext"), "@@ -0,0 +1,2 @@");
  assert.deepEqual(model.stats, { additions: 2, deletions: 0 });
});

test("rows: deleted file is all-del with @@ +0,0 header", () => {
  const model = buildDiffModel("x\ny\n", "");
  assert.ok(model.rows.every((row) => row.type === "del"));
  assert.equal(hunkHeader(model.rows, model.hunks[0].start, model.hunks[0].end, "plaintext"), "@@ -1,2 +0,0 @@");
  assert.deepEqual(model.stats, { additions: 0, deletions: 2 });
});

test("hunk header omits ,1 for single-line sides", () => {
  const model = buildDiffModel("a\n", "b\n");
  assert.equal(hunkHeader(model.rows, 0, model.rows.length, "plaintext"), "@@ -1 +1 @@");
});

test("hunk header picks up the enclosing function (python)", () => {
  const original = ["def foo():", "    return 1", "    return 2", "    return 3", "    return 4", "x = 1", "y = 2", "z = 3", ""].join("\n");
  const modified = original.replace("    return 3", "    return 42");
  const model = buildDiffModel(original, modified);
  const header = hunkHeader(model.rows, model.hunks[0].start, model.hunks[0].end, "python");
  assert.match(header, /^@@ -\d+,\d+ \+\d+,\d+ @@ def foo\(\):$/);
});

test("hunk header has no function section without a match", () => {
  const model = buildDiffModel("a\nb\nc\n", "a\nX\nc\n");
  const header = hunkHeader(model.rows, model.hunks[0].start, model.hunks[0].end, "plaintext");
  assert.doesNotMatch(header, /@@ .+ @@ .+/);
});

test("groupHunks merges touching windows into one hunk", () => {
  // Hand-built rows: single-row changes at index 4 and 11 → windows [1,8) and
  // [8,15) touch exactly (gap of zero). `<` instead of `<=` would leave two
  // hunks with a bogus zero-row gap between them.
  const rows: DiffRow[] = [];
  for (let i = 0; i < 15; i += 1) {
    const type = i === 4 || i === 11 ? "del" : "equal";
    rows.push({ type, oldLine: i + 1, newLine: i + 1, text: `L${i}` });
  }
  assert.deepEqual(groupHunks(rows), [{ start: 1, end: 15 }]);
});

test("groupHunks keeps distant changes separate", () => {
  const original = lines(0, 29);
  const modified = original.replace("L5", "A5").replace("L25", "A25");
  const model = buildDiffModel(original, modified);
  assert.equal(model.hunks.length, 2);
});

test("mergeIntervals merges overlapping and adjacent intervals", () => {
  assert.deepEqual(mergeIntervals([{ start: 0, end: 4 }, { start: 4, end: 8 }, { start: 10, end: 12 }]), [
    { start: 0, end: 8 },
    { start: 10, end: 12 },
  ]);
  assert.deepEqual(mergeIntervals([{ start: 5, end: 6 }, { start: 0, end: 5 }]), [{ start: 0, end: 6 }]);
});

test("revealRange reveals and merges without duplicates", () => {
  const visible = [{ start: 5, end: 10 }];
  assert.deepEqual(revealRange(visible, 8, 3, 20), [{ start: 5, end: 11 }]);
  assert.deepEqual(revealRange(visible, 0, 5, 20), [{ start: 0, end: 10 }]);
  assert.deepEqual(revealRange(visible, 10, 10, 20), [{ start: 5, end: 20 }]);
  assert.deepEqual(revealRange(visible, 12, 0, 20), visible);
});

test("clampIntervals clips out-of-range state after content changes", () => {
  assert.deepEqual(clampIntervals([{ start: 0, end: 50 }, { start: 60, end: 80 }], 30), [{ start: 0, end: 30 }]);
});

test("computeLayout emits gaps, hunks, and forces comment rows visible", () => {
  const model = buildDiffModel(lines(0, 29), lines(0, 29));
  const rows: DiffRow[] = model.rows;
  const items = computeLayout(rows, [{ start: 2, end: 6 }, { start: 10, end: 14 }], new Set([7]), "plaintext");
  assert.deepEqual(
    items.map((item) => item.kind),
    ["gap", "hunk", "gap", "hunk", "gap", "hunk", "gap"],
  );
  const firstGap = items[0];
  assert.equal(firstGap.kind === "gap" && firstGap.above, false);
  assert.equal(firstGap.kind === "gap" && firstGap.below, true);
  // The forced row at index 7 splits the [6,10) gap into [6,7) + [8,10) and
  // renders as a single-row hunk between them.
  const forced = items[3];
  assert.equal(forced.kind === "hunk" && forced.end - forced.start, 1);
  const lastGap = items[items.length - 1];
  assert.equal(lastGap.kind === "gap" && lastGap.below, false);
});

test("rowIndexMap indexes both sides", () => {
  const model = buildDiffModel("a\nb\nc\n", "a\nX\nc\n");
  const map = rowIndexMap(model.rows);
  assert.equal(map.get("original:2"), 1);
  assert.equal(map.get("modified:2"), 2);
  assert.equal(map.get("original:3"), 3);
});

test("word pairing: similar lines get intra-line spans, dissimilar stay whole-line", () => {
  const model = buildDiffModel("foo bar;\nkeep\n", "foo baz;\nkeep\n");
  const del = model.rows.find((row) => row.type === "del");
  const add = model.rows.find((row) => row.type === "add");
  assert.ok(del?.spans?.some((span) => span.kind === "del" && span.text.includes("bar")));
  assert.ok(add?.spans?.some((span) => span.kind === "add" && span.text.includes("baz")));

  const far = buildDiffModel("alpha beta gamma\nc\n", "one two three\nc\n");
  const farDel = far.rows.find((row) => row.type === "del");
  const farAdd = far.rows.find((row) => row.type === "add");
  assert.equal(farDel?.spans, undefined);
  assert.equal(farAdd?.spans, undefined);
});

test("oversized lines are truncated for display and keep their line numbers", () => {
  const long = "x".repeat(5000);
  const model = buildDiffModel(`keep\n${long}\n`, `keep\n${long}changed\n`);
  assert.equal(model.rows.length, 3);
  const del = model.rows.find((row) => row.type === "del")!;
  const add = model.rows.find((row) => row.type === "add")!;
  assert.equal(del.text.length, 2000);
  assert.equal(del.fullLength, 5000);
  assert.equal(add.text.length, 2000);
  assert.equal(add.fullLength, 5007);
  assert.equal(del.newLine, null);
  assert.equal(add.oldLine, null);
  assert.equal(del.spans, undefined, "over-length pairs skip word diff");
  assert.equal(model.rows[0].fullLength, undefined, "short rows are untouched");
  assert.deepEqual(model.stats, { additions: 1, deletions: 1 });
});

test("binary content is detected and produces an empty model", () => {
  const model = buildDiffModel("a\u0000b\n", "a\u0000c\n");
  assert.equal(model.binary, true);
  assert.equal(model.rows.length, 0);
});

test("interval edges: negative starts clamp to zero, overflow clamps to total", () => {
  assert.deepEqual(revealRange([{ start: 5, end: 10 }], -3, 5, 20), [{ start: 0, end: 2 }, { start: 5, end: 10 }]);
  assert.deepEqual(revealRange([{ start: 5, end: 10 }], 15, 10, 20), [{ start: 5, end: 10 }, { start: 15, end: 20 }]);
  assert.deepEqual(clampIntervals([{ start: 40, end: 50 }], 30), []);
  assert.deepEqual(clampIntervals([{ start: 0, end: 50 }], 30), [{ start: 0, end: 30 }]);
});

test("oversized rewrite: jsdiff is bypassed, one hunk, initial view clamped", () => {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (let i = 0; i < 12000; i += 1) {
    oldLines.push(`old-${i}`);
    newLines.push(`new-${i}`);
  }
  const model = buildDiffModel(oldLines.join("\n") + "\n", newLines.join("\n") + "\n");
  // The guarded-diff fallback emits one del block + one add block.
  assert.equal(model.rows.length, 24000);
  assert.equal(model.rows[0].type, "del");
  assert.equal(model.rows[12000].type, "add");
  assert.deepEqual(model.stats, { additions: 12000, deletions: 12000 });
  assert.deepEqual(model.hunks, [{ start: 0, end: 24000 }]);
  // Initial view is clamped per hunk; the remainder becomes an expandable gap.
  assert.deepEqual(initialIntervals(model), [{ start: 0, end: 20000 }]);
});

test("changes beyond ROW_CAP are never stranded", () => {
  const lines: string[] = [];
  for (let i = 0; i < 22000; i += 1) lines.push(`L${i}`);
  const original = lines.join("\n") + "\n";
  const modified = original.replace("L21999", "A21999");
  const model = buildDiffModel(original, modified);
  // Equal rows in between stay in the model (never rendered) but the far
  // hunk is fully reachable through its initial interval.
  assert.equal(model.rows.length, 22001);
  assert.deepEqual(model.hunks, [{ start: 21996, end: 22001 }]);
  assert.deepEqual(initialIntervals(model), [{ start: 21996, end: 22001 }]);
  assert.deepEqual(model.stats, { additions: 1, deletions: 1 });
});

test("funcname: pure deletion still reports the enclosing python def", () => {
  const original = ["def foo():", "    a = 1", "    b = 2", "    c = 3", ""].join("\n");
  const modified = original.replace("    b = 2\n", "");
  const model = buildDiffModel(original, modified);
  const header = hunkHeader(model.rows, model.hunks[0].start, model.hunks[0].end, "python");
  assert.match(header, / def foo\(\):$/);
});

test("funcname: typescript arrow-const is recognized", () => {
  const original = ["const build = (x) => {", "  return x;", "  return y;", "  return z;", "}", ""].join("\n");
  const modified = original.replace("  return y;", "  return y + 1;");
  const model = buildDiffModel(original, modified);
  const header = hunkHeader(model.rows, model.hunks[0].start, model.hunks[0].end, "typescript");
  assert.match(header, / const build = \(x\) => \{$/);
});

test("funcname: an added def line does not report itself as the enclosing function", () => {
  const original = ["def outer():", "    a = 1", "    b = 2", "    c = 3", "    d = 4", ""].join("\n");
  const modified = original.replace("    c = 3\n", "    c = 3\n    def inner():\n        pass\n");
  const model = buildDiffModel(original, modified);
  // The added "def inner():" line sits inside the hunk; the funcname must
  // come from the equal context above, not from the change itself.
  const header = hunkHeader(model.rows, model.hunks[0].start, model.hunks[0].end, "python");
  assert.match(header, / def outer\(\):$/);
  assert.doesNotMatch(header, /inner/);
});
