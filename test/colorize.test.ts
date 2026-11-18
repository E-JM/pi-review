import assert from "node:assert/strict";
import test from "node:test";
import { colorizeSourceFor, splitColorizedLines } from "../web/src/colorize.js";

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
