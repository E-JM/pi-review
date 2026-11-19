import assert from "node:assert/strict";
import test from "node:test";
import { colorizeSourceFor, matchesColorizedText, splitAtWordBounds, splitColorizedLines, wordBounds } from "../web/src/colorize.js";

test("splitColorizedLines splits monaco colorize output into per-line chunks", () => {
  const html = "<span>a</span><br/><span>b</span><br/>";
  assert.deepEqual(splitColorizedLines(html), ["<span>a</span>", "<span>b</span>"]);
});

test("splitColorizedLines keeps the trailing empty line of newline-terminated input", () => {
  const html = "<span>a</span><br/><br/>";
  assert.deepEqual(splitColorizedLines(html), ["<span>a</span>", ""]);
});

test("splitColorizedLines tolerates output without a trailing separator", () => {
  const html = "<span>a</span><br/><span>b</span>";
  assert.deepEqual(splitColorizedLines(html), ["<span>a</span>", "<span>b</span>"]);
});

test("splitColorizedLines keeps escaped content intact", () => {
  const html = "&lt;br/&gt;<br/>x<br/>";
  assert.deepEqual(splitColorizedLines(html), ["&lt;br/&gt;", "x"]);
});

test("colorizeSourceFor picks the side that owns the row", () => {
  const eligible = { original: true, modified: true };
  assert.deepEqual(colorizeSourceFor({ type: "add", oldLine: null, newLine: 4 }, eligible), { side: "modified", line: 4 });
  assert.deepEqual(colorizeSourceFor({ type: "del", oldLine: 7, newLine: null }, eligible), { side: "original", line: 7 });
  assert.deepEqual(colorizeSourceFor({ type: "equal", oldLine: 3, newLine: 3 }, eligible), { side: "modified", line: 3 });
});

test("colorizeSourceFor prefers the colorizable side for equal rows", () => {
  assert.deepEqual(
    colorizeSourceFor({ type: "equal", oldLine: 3, newLine: 3 }, { original: true, modified: false }),
    { side: "original", line: 3 },
  );
});

test("colorizeSourceFor returns null when no side is colorizable", () => {
  assert.equal(colorizeSourceFor({ type: "add", oldLine: null, newLine: 4 }, { original: true, modified: false }), null);
  assert.equal(colorizeSourceFor({ type: "del", oldLine: 7, newLine: null }, { original: false, modified: true }), null);
  assert.equal(colorizeSourceFor({ type: "equal", oldLine: 3, newLine: 3 }, { original: false, modified: false }), null);
});

test("wordBounds keeps only non-empty changed fragments", () => {
  const bounds = wordBounds([
    { text: "abc ", kind: "equal" },
    { text: "de", kind: "del" },
    { text: " ", kind: "equal" },
    { text: "f", kind: "add" },
    { text: "", kind: "add" },
  ]);
  assert.deepEqual(bounds, [
    { start: 4, end: 6, className: "u-w-del" },
    { start: 7, end: 8, className: "u-w-add" },
  ]);
});

test("wordBounds returns empty when everything is unchanged", () => {
  assert.deepEqual(wordBounds([{ text: "same", kind: "equal" }]), []);
});

test("splitAtWordBounds keeps a run outside all bounds intact", () => {
  const result = splitAtWordBounds("plain text", 0, [{ start: 20, end: 24, className: "u-w-del" }], 0);
  assert.deepEqual(result, { pieces: [{ text: "plain text", className: null }], nextIndex: 0 });
});

test("splitAtWordBounds handles empty bounds and empty runs", () => {
  assert.deepEqual(splitAtWordBounds("abc", 0, [], 0), { pieces: [{ text: "abc", className: null }], nextIndex: 0 });
  assert.deepEqual(splitAtWordBounds("", 0, [{ start: 1, end: 3, className: "u-w-del" }], 1), { pieces: [], nextIndex: 1 });
});

test("splitAtWordBounds handles touching del/add bounds", () => {
  const result = splitAtWordBounds("abcd", 0, [
    { start: 0, end: 2, className: "u-w-del" },
    { start: 2, end: 4, className: "u-w-add" },
  ], 0);
  assert.deepEqual(result.pieces, [
    { text: "ab", className: "u-w-del" },
    { text: "cd", className: "u-w-add" },
  ]);
  assert.equal(result.nextIndex, 2);
});

test("splitAtWordBounds boxes the changed middle of a run", () => {
  const result = splitAtWordBounds("old new tail", 0, [{ start: 4, end: 7, className: "u-w-add" }], 0);
  assert.deepEqual(result.pieces, [
    { text: "old ", className: null },
    { text: "new", className: "u-w-add" },
    { text: " tail", className: null },
  ]);
  assert.equal(result.nextIndex, 1);
});

test("splitAtWordBounds spans multiple bounds in one run", () => {
  const bounds = [
    { start: 1, end: 2, className: "u-w-del" },
    { start: 4, end: 6, className: "u-w-add" },
  ];
  const result = splitAtWordBounds("abcd efg", 0, bounds, 0);
  assert.deepEqual(result.pieces, [
    { text: "a", className: null },
    { text: "b", className: "u-w-del" },
    { text: "cd", className: null },
    { text: " e", className: "u-w-add" },
    { text: "fg", className: null },
  ]);
  assert.equal(result.nextIndex, 2);
});

test("splitAtWordBounds leaves a bound open until a run passes its end", () => {
  const bounds = [{ start: 1, end: 3, className: "u-w-del" }];
  const first = splitAtWordBounds("ab", 0, bounds, 0);
  assert.deepEqual(first.pieces, [
    { text: "a", className: null },
    { text: "b", className: "u-w-del" },
  ]);
  assert.equal(first.nextIndex, 0);
  const second = splitAtWordBounds("cd", 2, bounds, first.nextIndex);
  assert.deepEqual(second.pieces, [
    { text: "c", className: "u-w-del" },
    { text: "d", className: null },
  ]);
  assert.equal(second.nextIndex, 1);
});

test("matchesColorizedText treats plain and no-break spaces as equal", () => {
  assert.equal(matchesColorizedText("a\u00a0b c", "a b c"), true);
  assert.equal(matchesColorizedText("a b c", "a\u00a0b\u00a0c"), true);
  assert.equal(matchesColorizedText("abc", "abc"), true);
});

test("matchesColorizedText rejects tabs, wrong characters, and length drift", () => {
  assert.equal(matchesColorizedText("\tabc", " abc"), false);
  assert.equal(matchesColorizedText("axc", "abc"), false);
  assert.equal(matchesColorizedText("short", "longer"), false);
});

test("splitAtWordBounds resumes mid-bound in a later run", () => {
  const bounds = [{ start: 1, end: 4, className: "u-w-del" }];
  const first = splitAtWordBounds("ab", 0, bounds, 0);
  const second = splitAtWordBounds("cd", 2, bounds, first.nextIndex);
  assert.deepEqual(second.pieces, [{ text: "cd", className: "u-w-del" }]);
  assert.equal(second.nextIndex, 1);
});
