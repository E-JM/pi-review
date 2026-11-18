import * as monaco from "monaco-editor/editor/editor.api.js";
import {
  EXPAND_STEP,
  buildDiffModel,
  clampIntervals,
  computeLayout,
  initialIntervals,
  revealRange,
  rowIndexMap,
  type DiffModel,
  type DiffRow,
  type Interval,
  type LayoutItem,
} from "./diff-model.js";
import { captureFocusedComment, createInlineCommentElement, restoreFocusedComment, type UiComment } from "./comment.js";
import { colorizeSourceFor, splitColorizedLines, type DiffSide } from "./colorize.js";
import type { FileContents } from "../../src/types.js";

export interface UnifiedHost {
  addComment(side: "original" | "modified", line: number): void;
  deleteComment(id: string): void;
  onCommentInput(): void;
  showToast(message: string): void;
}

const LINE_HEIGHT = 19;
const SEARCH_REVEAL_CAP = 50;
const COLORIZE_BATCH = 8;
const COLORIZE_CACHE_MAX = 5000;
// Tokenizing a very long line can block for seconds; long rows stay plain.
const COLORIZE_MAX_CHARS = 1000;
// Whole-side colorize (one call for a file's full content) is what keeps
// Monarch state across lines — multi-line block comments otherwise tokenize
// as code and highlight wrong. It is one synchronous pass, so oversized
// sides fall back to stateless per-line coloring.
const COLORIZE_SIDE_MAX_CHARS = 300_000;

type IdleSchedule = (callback: () => void) => void;
const scheduleIdle: IdleSchedule = (() => {
  const ric = (window as Window & { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number }).requestIdleCallback;
  if (ric != null) return (callback) => ric(callback, { timeout: 300 });
  return (callback) => window.setTimeout(callback, 16);
})();

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
}

function stripTrailingBr(html: string): string {
  return html.replace(/<br\/>$/, "");
}

interface PerFileState {
  fingerprint: string;
  visible: Interval[];
}

export class UnifiedDiffView {
  private readonly container: HTMLElement;
  private readonly host: UnifiedHost;
  private readonly scrollEl: HTMLElement;
  private readonly headerEl: HTMLElement;
  private readonly itemsEl: HTMLElement;
  private readonly searchBarEl: HTMLElement;
  private readonly searchInputEl: HTMLInputElement;
  private readonly searchCountEl: HTMLElement;

  private model: DiffModel | null = null;
  private language = "plaintext";
  private originalContent = "";
  private modifiedContent = "";
  private currentKey: string | null = null;
  private currentFingerprint: string | null = null;
  private states = new Map<string, PerFileState>();
  private comments: UiComment[] = [];
  private renderedComments = new Map<string, HTMLElement>();
  private rowByKey = new Map<string, number>();
  private generation = 0;
  private colorizeCache = new Map<string, Promise<string>>();
  private colorizeQueue: Array<() => void> = [];
  private colorizeDraining = false;
  private sideLineHtml = new Map<DiffSide, Promise<string[]>>();
  private searchOpen = false;
  private searchQuery = "";
  private searchMatches: number[] = [];
  private searchCurrent = 0;
  private markedRows = new Set<number>();
  private searchReturnFocus: HTMLElement | null = null;
  private searchTimer = 0;

  constructor(container: HTMLElement, host: UnifiedHost) {
    this.container = container;
    this.host = host;
    this.scrollEl = el("div", "unified-scroll");
    this.headerEl = el("div", "unified-header");
    this.itemsEl = el("div", "unified-items");
    this.scrollEl.append(this.headerEl, this.itemsEl);

    this.searchBarEl = el("div", "unified-searchbar hidden");
    this.searchInputEl = document.createElement("input");
    this.searchInputEl.id = "unified-search";
    this.searchInputEl.type = "text";
    this.searchInputEl.placeholder = "Search in diff";
    this.searchInputEl.spellcheck = false;
    this.searchCountEl = el("span", "u-search-count");
    const prevButton = el("button", "u-search-button", "↑");
    prevButton.type = "button";
    prevButton.title = "Previous match (Shift+Enter)";
    const nextButton = el("button", "u-search-button", "↓");
    nextButton.type = "button";
    nextButton.title = "Next match (Enter)";
    const closeButton = el("button", "u-search-button", "×");
    closeButton.type = "button";
    closeButton.title = "Close search (Escape)";
    this.searchBarEl.append(this.searchInputEl, this.searchCountEl, prevButton, nextButton, closeButton);
    this.container.append(this.scrollEl, this.searchBarEl);

    this.searchInputEl.addEventListener("input", () => {
      window.clearTimeout(this.searchTimer);
      this.searchTimer = window.setTimeout(() => this.setQuery(this.searchInputEl.value), 150);
    });
    this.searchInputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.stepSearch(event.shiftKey ? -1 : 1);
      }
      if (event.key === "Escape") {
        event.preventDefault();
        this.closeSearch();
      }
    });
    prevButton.addEventListener("click", () => this.stepSearch(-1));
    nextButton.addEventListener("click", () => this.stepSearch(1));
    closeButton.addEventListener("click", () => this.closeSearch());
  }

  mount(file: FileContents, comments: UiComment[], wrap: boolean, language: string): void {
    const key = `${file.mode}:${file.path}`;
    if (this.currentKey === key && this.currentFingerprint === file.fingerprint && this.model != null && !this.model.binary) {
      // Same content is already on screen (view-style round trip): keep DOM,
      // expansion state, and search state; refresh comments and wrap only.
      this.comments = comments;
      this.setWrap(wrap);
      this.refreshCommentRows();
      return;
    }
    this.generation += 1;
    this.colorizeQueue.length = 0;
    this.sideLineHtml.clear();
    this.currentKey = key;
    this.currentFingerprint = file.fingerprint;
    this.closeSearch();
    this.language = language;
    this.originalContent = file.originalContent;
    this.modifiedContent = file.modifiedContent;
    this.model = buildDiffModel(file.originalContent, file.modifiedContent);
    const state = this.states.get(key);
    const visible = state != null && state.fingerprint === file.fingerprint
      ? clampIntervals(state.visible, this.model.rows.length)
      : initialIntervals(this.model);
    this.states.set(key, { fingerprint: file.fingerprint, visible });
    this.rowByKey = rowIndexMap(this.model.rows);
    this.comments = comments;
    this.renderedComments.clear();
    this.resetSearch();
    this.setWrap(wrap);
    this.renderHeader(file);
    this.renderItems();
    this.refreshCommentRows();
  }

  clear(): void {
    this.closeSearch();
    this.generation += 1;
    this.colorizeQueue.length = 0;
    this.sideLineHtml.clear();
    this.originalContent = "";
    this.modifiedContent = "";
    this.currentKey = null;
    this.currentFingerprint = null;
    this.model = null;
    this.comments = [];
    this.renderedComments.clear();
    this.rowByKey.clear();
    this.resetSearch();
    this.headerEl.replaceChildren();
    this.itemsEl.replaceChildren();
  }

  // Whether the DOM currently shows exactly this file's contents — the guard
  // that keeps scroll persistence from saving a hidden view's offset under
  // another file's key.
  isShowing(path: string, mode: string): boolean {
    return this.currentKey === `${mode}:${path}` && this.model != null;
  }

  syncComments(comments: UiComment[]): void {
    this.comments = comments;
    this.refreshCommentRows();
  }

  setWrap(enabled: boolean): void {
    this.scrollEl.classList.toggle("wrap", enabled);
  }

  saveScroll(): number {
    return this.scrollEl.scrollTop;
  }

  restoreScrollTop(top: number): void {
    this.scheduleScrollRestore(top);
  }

  // Clamped restore, retried across frames so content-visibility layout and
  // section rendering settle before the final position sticks.
  private scheduleScrollRestore(top: number): void {
    const apply = () => {
      const max = Math.max(0, this.scrollEl.scrollHeight - this.scrollEl.clientHeight);
      this.scrollEl.scrollTop = Math.max(0, Math.min(top, max));
    };
    apply();
    requestAnimationFrame(apply);
    window.setTimeout(apply, 30);
  }

  scrollToComment(side: "original" | "modified", line: number): void {
    const rowIdx = this.rowByKey.get(`${side}:${line}`);
    if (rowIdx == null) return;
    this.rowElement(rowIdx)?.scrollIntoView({ block: "center" });
  }

  openSearch(): void {
    if (!this.searchOpen) {
      this.searchOpen = true;
      this.searchReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      this.searchBarEl.classList.remove("hidden");
      this.updateSearchCount();
    }
    this.searchInputEl.focus();
    this.searchInputEl.select();
  }

  closeSearch(): void {
    if (!this.searchOpen) return;
    this.searchOpen = false;
    this.searchBarEl.classList.add("hidden");
    this.searchInputEl.value = "";
    this.setQuery("");
    const returnFocus = this.searchReturnFocus;
    this.searchReturnFocus = null;
    if (returnFocus != null && returnFocus.isConnected) returnFocus.focus();
  }

  // --- layout rendering -----------------------------------------------------

  private renderHeader(file: FileContents): void {
    const model = this.model!;
    this.headerEl.replaceChildren();
    const squares = el("span", "u-squares");
    const { additions, deletions } = model.stats;
    const total = additions + deletions;
    let green = 0;
    if (total > 0) {
      green = Math.round((5 * additions) / total);
      green = Math.max(additions > 0 ? 1 : 0, Math.min(deletions > 0 ? 4 : 5, green));
    }
    for (let i = 0; i < 5; i += 1) squares.append(el("span", `u-square ${i < green ? "g" : total > 0 ? "r" : "dim"}`));
    const counts = el("span", "u-counts", `+${additions} −${deletions}`);
    const copy = el("button", "u-copy-path", "Copy path");
    copy.type = "button";
    copy.addEventListener("click", () => {
      const clipboard = navigator.clipboard;
      if (clipboard == null) {
        this.host.showToast("Copy failed");
        return;
      }
      clipboard.writeText(file.path).then(
        () => this.host.showToast("Path copied"),
        () => this.host.showToast("Copy failed"),
      );
    });
    this.headerEl.append(squares, counts, copy);
  }

  private commentRowIndexes(): Set<number> {
    const indexes = new Set<number>();
    for (const comment of this.comments) {
      if (comment.side === "file" || comment.line == null) continue;
      const rowIdx = this.rowByKey.get(`${comment.side}:${comment.line}`);
      if (rowIdx != null) indexes.add(rowIdx);
    }
    return indexes;
  }

  private visibleIntervals(): Interval[] {
    return this.states.get(this.currentKey!)?.visible ?? [];
  }

  private renderItems(): void {
    const model = this.model;
    if (model == null || this.currentKey == null) return;
    const generation = this.generation;
    const commentRows = this.commentRowIndexes();
    const items: LayoutItem[] = computeLayout(model.rows, this.visibleIntervals(), commentRows, this.language);
    const fragment = document.createDocumentFragment();
    for (const item of items) {
      fragment.append(item.kind === "hunk" ? this.buildHunk(item, generation, commentRows) : this.buildGap(item));
    }
    if (items.length === 0) {
      fragment.append(el("div", "u-placeholder", model.binary ? "No text content (binary file)" : "No textual changes"));
    }
    this.itemsEl.replaceChildren(fragment);
    // Rebuilding the sections detaches any rendered comment rows; re-attach
    // them right away so expansions and search relayouts never "lose" comments.
    this.insertCommentRows();
  }

  private renderItemsPreserving(): void {
    const scrollTop = this.scrollEl.scrollTop;
    const focused = captureFocusedComment();
    this.renderItems();
    this.scheduleScrollRestore(scrollTop);
    restoreFocusedComment(focused);
  }

  private buildHunk(item: Extract<LayoutItem, { kind: "hunk" }>, generation: number, commentRows: ReadonlySet<number>): HTMLElement {
    const section = el("section", "u-hunk");
    section.style.containIntrinsicSize = `auto ${(item.end - item.start) * LINE_HEIGHT + LINE_HEIGHT}px`;
    section.append(el("div", "u-hunk-header", item.header));
    for (let i = item.start; i < item.end; i += 1) section.append(this.buildRow(i, generation, commentRows));
    return section;
  }

  private buildGap(item: Extract<LayoutItem, { kind: "gap" }>): HTMLElement {
    const gap = el("div", "u-gap");
    const count = item.end - item.start;
    gap.append(el("span", "u-gap-label", `⋯ ${count} unchanged line${count === 1 ? "" : "s"} ⋅`));
    if (item.above) gap.append(this.expandButton(`Expand ${EXPAND_STEP} lines above`, "↑", () => this.expandGap(item.start, EXPAND_STEP)));
    if (item.below) gap.append(this.expandButton(`Expand ${EXPAND_STEP} lines below`, "↓", () => this.expandGap(item.end - Math.min(EXPAND_STEP, count), EXPAND_STEP)));
    gap.append(this.expandButton(`Expand all ${count} lines`, "⇊", () => this.expandGap(item.start, count)));
    return gap;
  }

  private expandButton(title: string, label: string, onClick: () => void): HTMLButtonElement {
    const button = el("button", "u-expand", label);
    button.type = "button";
    button.title = title;
    button.addEventListener("click", onClick);
    return button;
  }

  private expandGap(start: number, count: number): void {
    if (this.currentKey == null || this.model == null) return;
    const state = this.states.get(this.currentKey)!;
    state.visible = revealRange(state.visible, start, count, this.model.rows.length);
    this.renderItemsPreserving();
  }

  private buildRow(index: number, generation: number, commentRows: ReadonlySet<number>): HTMLElement {
    const row = this.model!.rows[index];
    const wrap = el("div", `u-row u-${row.type}`);
    wrap.dataset.idx = String(index);
    const main = el("div", "u-row-main");
    const gutter = el("div", "u-gutter");
    // Single line-number column: current line for context/additions, the old
    // number (red-tinted) for deletions. Clicks keep their respective side.
    const lno = el("span", "u-lno");
    if (row.type === "del") {
      lno.classList.add("u-lno-old");
      lno.textContent = String(row.oldLine);
      lno.title = `Comment on reviewed line ${row.oldLine}`;
      lno.addEventListener("click", () => this.host.addComment("original", row.oldLine!));
    } else {
      lno.textContent = String(row.newLine);
      lno.title = `Comment on current line ${row.newLine}`;
      lno.addEventListener("click", () => this.host.addComment("modified", row.newLine!));
    }
    gutter.append(lno);
    const sign = el("span", "u-sign", row.type === "add" ? "+" : row.type === "del" ? "-" : "\u00a0");
    const code = el("code", "u-code");
    this.renderRowContent(code, row, generation);
    main.append(gutter, sign, code);
    wrap.append(main);
    if (this.model!.oldNoEol && row.oldLine === this.model!.oldLastLine) wrap.append(el("div", "u-noeol", "\\ No newline at end of file"));
    else if (this.model!.newNoEol && row.newLine === this.model!.newLastLine) wrap.append(el("div", "u-noeol", "\\ No newline at end of file"));
    if (commentRows.has(index)) wrap.classList.add("commented");
    if (this.markedRows.has(index)) wrap.classList.add("u-match");
    return wrap;
  }

  private renderRowContent(code: HTMLElement, row: DiffRow, generation: number): void {
    code.replaceChildren();
    if (this.searchQuery && row.text.toLowerCase().includes(this.searchQuery)) {
      const text = row.text;
      const lower = text.toLowerCase();
      let cursor = 0;
      while (true) {
        const hit = lower.indexOf(this.searchQuery, cursor);
        if (hit < 0) break;
        if (hit > cursor) code.append(el("span", undefined, text.slice(cursor, hit)));
        code.append(el("mark", undefined, text.slice(hit, hit + this.searchQuery.length)));
        cursor = hit + this.searchQuery.length;
      }
      if (cursor < text.length) code.append(el("span", undefined, text.slice(cursor)));
      this.appendTruncationMarker(code, row);
      return;
    }
    if (row.spans != null) {
      for (const span of row.spans) code.append(el("span", `u-w-${span.kind}`, span.text));
      return;
    }
    // Truncation markers must survive colorize, which replaces the text span's
    // innerHTML — so the code text lives in its own child span.
    const textSpan = el("span", "u-text");
    textSpan.textContent = row.text;
    code.append(textSpan);
    this.appendTruncationMarker(code, row);
    this.queueColorize(textSpan, row, generation);
  }

  private appendTruncationMarker(code: HTMLElement, row: DiffRow): void {
    if (row.fullLength == null) return;
    const hidden = row.fullLength - row.text.length;
    code.append(el("span", "u-more", ` … +${hidden} more chars`));
  }

  // --- comments -------------------------------------------------------------

  // Line comments for the mounted file, keyed by comment id.
  private wantedLineComments(): Map<string, UiComment> {
    const wanted = new Map<string, UiComment>();
    for (const comment of this.comments) {
      if (comment.side !== "file" && comment.line != null) wanted.set(comment.id, comment);
    }
    return wanted;
  }

  private refreshCommentRows(): void {
    const model = this.model;
    if (model == null) return;
    const wanted = this.wantedLineComments();
    // Removing a comment also re-collapses any row it forced visible; entries
    // detached by an intermediate relayout count as gone and get re-inserted.
    let removedAny = false;
    for (const [id, element] of this.renderedComments) {
      if (!wanted.has(id)) {
        element.remove();
        this.renderedComments.delete(id);
        removedAny = true;
      } else if (!element.isConnected) {
        this.renderedComments.delete(id);
      }
    }
    if (removedAny) {
      this.renderedComments.clear();
      this.renderItemsPreserving();
    }
    // A comment on a currently-collapsed line forces a relayout so its row
    // renders (comments are a render-time union over the visible intervals).
    const hiddenTarget = [...wanted.keys()].some((id) => {
      if (this.renderedComments.has(id)) return false;
      const comment = wanted.get(id)!;
      const rowIdx = this.rowByKey.get(`${comment.side}:${comment.line}`);
      return rowIdx != null && this.rowElement(rowIdx) == null;
    });
    if (hiddenTarget) {
      for (const element of this.renderedComments.values()) element.remove();
      this.renderedComments.clear();
      this.renderItemsPreserving();
    }
    this.insertCommentRows();
  }

  // Idempotent: renders every wanted comment whose row is on screen, leaving
  // existing connected rows (and any textarea being typed in) untouched.
  private insertCommentRows(): void {
    const model = this.model;
    if (model == null) return;
    const wanted = this.wantedLineComments();
    const highlighted = new Set<number>();
    for (const comment of wanted.values()) {
      const rowIdx = this.rowByKey.get(`${comment.side}:${comment.line}`);
      if (rowIdx == null) continue;
      highlighted.add(rowIdx);
      const existing = this.renderedComments.get(comment.id);
      if (existing != null && existing.isConnected) continue;
      const rowEl = this.rowElement(rowIdx);
      if (rowEl == null) continue;
      const element = createInlineCommentElement(comment, {
        onInput: () => this.host.onCommentInput(),
        onDelete: () => this.host.deleteComment(comment.id),
      });
      element.classList.add("u-comment-row");
      rowEl.after(element);
      this.renderedComments.set(comment.id, element);
    }
    for (const rowEl of this.itemsEl.querySelectorAll<HTMLElement>(".u-row")) {
      rowEl.classList.toggle("commented", highlighted.has(Number(rowEl.dataset.idx)));
    }
  }

  private rowElement(index: number): HTMLElement | null {
    return this.itemsEl.querySelector<HTMLElement>(`.u-row[data-idx="${index}"]`);
  }

  // --- syntax coloring ------------------------------------------------------

  // Whole-side colorize keeps Monarch token state across lines, so multi-line
  // block comments render as comments instead of mis-highlighted code (per-line
  // colorize restarts from the initial state and tokens a " * " continuation
  // line as code). Display-truncated lines stay out: their HTML chunk contains
  // the full source line, which cannot be spliced to the shown prefix.
  private queueColorize(code: HTMLElement, row: DiffRow, generation: number): void {
    if (this.language === "plaintext" || !row.text.trim()) return;
    const source = row.fullLength == null
      ? colorizeSourceFor(row, {
        original: this.originalContent.length <= COLORIZE_SIDE_MAX_CHARS,
        modified: this.modifiedContent.length <= COLORIZE_SIDE_MAX_CHARS,
      })
      : null;
    if (source != null) {
      const content = source.side === "original" ? this.originalContent : this.modifiedContent;
      this.idle(() => {
        if (generation !== this.generation || !code.isConnected) return;
        if (this.searchQuery && row.text.toLowerCase().includes(this.searchQuery)) return;
        void this.sideLinesFor(source.side, content).then((lines) => {
          if (generation !== this.generation || !code.isConnected) return;
          const html = lines[source.line - 1];
          if (html) code.innerHTML = html;
        }, () => {});
      });
      return;
    }
    if (row.text.length > COLORIZE_MAX_CHARS) return;
    const promise = this.colorizePromise(row.text);
    this.idle(() => {
      if (generation !== this.generation || !code.isConnected) return;
      if (this.searchQuery && row.text.toLowerCase().includes(this.searchQuery)) return;
      void promise.then((html) => {
        if (generation !== this.generation || !code.isConnected) return;
        if (!html) return;
        code.innerHTML = stripTrailingBr(html);
      }, () => {});
    });
  }

  // One colorize call per file side, memoized for the mounted content: the
  // whole side is tokenized with carried state, then split into per-line HTML.
  // Created lazily inside the idle queue so the synchronous tokenize pass
  // never delays the initial paint.
  private sideLinesFor(side: DiffSide, content: string): Promise<string[]> {
    let promise = this.sideLineHtml.get(side);
    if (promise == null) {
      promise = monaco.editor.colorize(content, this.language, { tabSize: 4 }).then(splitColorizedLines).catch(() => []);
      this.sideLineHtml.set(side, promise);
    }
    return promise;
  }

  private colorizePromise(text: string): Promise<string> {
    const key = `${this.language}\u0000${text}`;
    let promise = this.colorizeCache.get(key);
    if (promise == null) {
      promise = monaco.editor.colorize(text, this.language, { tabSize: 4 }).catch(() => "");
      this.colorizeCache.set(key, promise);
    }
    // Single global budget, oldest-first eviction — one language cannot hold
    // the whole cache hostage, and eviction is gradual instead of a cliff.
    while (this.colorizeCache.size > COLORIZE_CACHE_MAX) {
      const oldest = this.colorizeCache.keys().next().value;
      if (oldest === undefined) break;
      this.colorizeCache.delete(oldest);
    }
    return promise;
  }

  private idle(task: () => void): void {
    this.colorizeQueue.push(task);
    if (this.colorizeDraining) return;
    this.colorizeDraining = true;
    const drain = () => {
      for (const queued of this.colorizeQueue.splice(0, COLORIZE_BATCH)) queued();
      if (this.colorizeQueue.length > 0) scheduleIdle(drain);
      else this.colorizeDraining = false;
    };
    scheduleIdle(drain);
  }

  // --- search ---------------------------------------------------------------

  private resetSearch(): void {
    this.searchQuery = "";
    this.searchMatches = [];
    this.searchCurrent = 0;
    this.markedRows = new Set();
    this.searchInputEl.value = "";
  }

  private setQuery(query: string): void {
    const model = this.model;
    const previousMarked = this.markedRows;
    this.searchQuery = query.toLowerCase();
    this.searchMatches = [];
    this.searchCurrent = 0;
    if (model != null && this.searchQuery) {
      for (let i = 0; i < model.rows.length; i += 1) {
        if (model.rows[i].text.toLowerCase().includes(this.searchQuery)) this.searchMatches.push(i);
      }
    }
    // Every match gets the row highlight class (buildRow consults this set for
    // fresh sections; the loop below patches already-rendered rows).
    this.markedRows = new Set(this.searchMatches);
    // Matches inside collapsed regions: reveal a minimal window around the
    // first ones so they can be highlighted and visited (bounded to keep
    // broad queries from exploding the layout).
    let revealed = false;
    let revealCount = 0;
    for (const index of this.searchMatches) {
      if (revealCount >= SEARCH_REVEAL_CAP) break;
      if (this.rowElement(index) != null) continue;
      const state = this.states.get(this.currentKey!);
      if (state != null && model != null) {
        state.visible = revealRange(state.visible, Math.max(0, index - 3), 7, model.rows.length);
        revealed = true;
      }
      revealCount += 1;
    }
    if (revealed) this.renderItemsPreserving();
    // One pass over rendered rows instead of one querySelector per match.
    const touched = new Set([...previousMarked, ...this.markedRows]);
    for (const rowEl of this.itemsEl.querySelectorAll<HTMLElement>(".u-row")) {
      const index = Number(rowEl.dataset.idx);
      if (!touched.has(index)) continue;
      rowEl.classList.toggle("u-match", this.markedRows.has(index));
      rowEl.classList.remove("u-match-current");
      const code = rowEl.querySelector<HTMLElement>(".u-code");
      const row = model?.rows[index];
      if (code != null && row != null) this.renderRowContent(code, row, this.generation);
    }
    this.updateSearchCount();
  }

  private visibleMatchIndexes(): number[] {
    const indexes: number[] = [];
    for (const rowEl of this.itemsEl.querySelectorAll<HTMLElement>(".u-row")) {
      const index = Number(rowEl.dataset.idx);
      if (this.markedRows.has(index)) indexes.push(index);
    }
    return indexes.sort((a, b) => a - b);
  }

  private stepSearch(direction: 1 | -1): void {
    const matches = this.visibleMatchIndexes();
    if (matches.length === 0) return;
    this.searchCurrent = (this.searchCurrent + direction + matches.length) % matches.length;
    for (const index of matches) this.rowElement(index)?.classList.remove("u-match-current");
    const current = matches[this.searchCurrent];
    const currentEl = this.rowElement(current);
    currentEl?.classList.add("u-match-current");
    currentEl?.scrollIntoView({ block: "center" });
    this.updateSearchCount();
  }

  private updateSearchCount(): void {
    const visible = this.searchQuery ? this.visibleMatchIndexes().length : 0;
    const hidden = this.searchMatches.length - visible;
    const current = visible > 0 ? Math.min(this.searchCurrent, visible - 1) + 1 : 0;
    this.searchCountEl.textContent = this.searchQuery ? `${current}/${visible}${hidden > 0 ? ` (${hidden} hidden)` : ""}` : "";
  }
}
