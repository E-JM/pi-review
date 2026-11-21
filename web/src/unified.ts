import * as monaco from "monaco-editor/editor/editor.api.js";
import type { FileContents } from "../../src/types.js";
import {
  colorizeSourceFor,
  type DiffSide,
  matchesColorizedText,
  splitAtWordBounds,
  type WordPiece,
  wordBounds,
} from "./colorize.js";
import {
  captureFocusedComment,
  createInlineCommentElement,
  restoreFocusedComment,
  type UiComment,
} from "./comment.js";
import {
  buildDiffModel,
  clampIntervals,
  computeLayout,
  type DiffModel,
  type DiffRow,
  EXPAND_STEP,
  type Interval,
  initialIntervals,
  type LayoutItem,
  revealRange,
  rowIndexMap,
  type WordSpan,
} from "./diff-model.js";

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
// The editor cycles bracket colors through editorBracketHighlight.foreground
// 1-3 (its registered dark palette); class names here follow the same cycle.
const BRACKET_COLORS = 3;
// Tokenizing a very long line can block for seconds; long rows stay plain.
const COLORIZE_MAX_CHARS = 1000;
// Whole-side colorize (one call for a file's full content) is what keeps
// Monarch state across lines — multi-line block comments otherwise tokenize
// as code and highlight wrong. It is one synchronous pass, so sides past
// this bound are ineligible: their rows colorize from the other side where
// possible (equal rows), else fall back to stateless per-line coloring.
const COLORIZE_SIDE_MAX_CHARS = 300_000;

type IdleSchedule = (callback: () => void) => void;
const scheduleIdle: IdleSchedule = (() => {
  const ric = (
    window as Window & {
      requestIdleCallback?: (
        callback: () => void,
        options?: { timeout: number },
      ) => number;
    }
  ).requestIdleCallback;
  if (ric != null) return (callback) => ric(callback, { timeout: 300 });
  return (callback) => window.setTimeout(callback, 16);
})();

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
}

function stripTrailingBr(html: string): string {
  return html.replace(/<br\/>$/, "");
}

// Parses colorized line HTML into detached nodes. `innerHTML` on a template
// never executes scripts and matches how the fragments land in the DOM.
function parseFragment(html: string): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content;
}

function textNodes(root: Node): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node != null; node = walker.nextNode())
    nodes.push(node as Text);
  return nodes;
}

function piecesFragment(pieces: readonly WordPiece[]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const piece of pieces)
    fragment.append(
      piece.className == null
        ? document.createTextNode(piece.text)
        : el("span", piece.className, piece.text),
    );
  return fragment;
}

// Bracket scanner output for one colorized line, as 0-based source-text
// offsets. `model.bracketPairs` is not in Monaco's public typings, but it is
// the same scanner the editor's bracket colorization decorations consume.
interface BracketRangeLike {
  range: monaco.IRange;
  nestingLevel: number;
  isInvalid: boolean;
}

interface BracketModelLike {
  bracketPairs?: {
    getBracketsInRange(
      range: monaco.IRange,
      onlyColorizedBrackets?: boolean,
    ): { toArray(): BracketRangeLike[] };
  };
}

interface BracketMark {
  start: number;
  end: number;
  className: string;
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
  private sideModels = new Map<DiffSide, monaco.editor.ITextModel>();
  private sideBrackets = new Map<DiffSide, Map<number, BracketMark[]>>();
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
    this.searchBarEl.append(
      this.searchInputEl,
      this.searchCountEl,
      prevButton,
      nextButton,
      closeButton,
    );
    this.container.append(this.scrollEl, this.searchBarEl);

    this.searchInputEl.addEventListener("input", () => {
      window.clearTimeout(this.searchTimer);
      this.searchTimer = window.setTimeout(
        () => this.setQuery(this.searchInputEl.value),
        150,
      );
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

  mount(
    file: FileContents,
    comments: UiComment[],
    wrap: boolean,
    language: string,
  ): void {
    const key = `${file.mode}:${file.path}`;
    if (
      this.currentKey === key &&
      this.currentFingerprint === file.fingerprint &&
      this.model != null &&
      !this.model.binary
    ) {
      // Same content is already on screen (view-style round trip): keep DOM,
      // expansion state, and search state; refresh comments and wrap only.
      this.comments = comments;
      this.setWrap(wrap);
      this.refreshCommentRows();
      return;
    }
    this.generation += 1;
    this.resetColorize();
    this.currentKey = key;
    this.currentFingerprint = file.fingerprint;
    this.closeSearch();
    this.language = language;
    this.originalContent = file.originalContent;
    this.modifiedContent = file.modifiedContent;
    this.model = buildDiffModel(file.originalContent, file.modifiedContent);
    const state = this.states.get(key);
    const visible =
      state != null && state.fingerprint === file.fingerprint
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
    this.resetColorize();
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
      const max = Math.max(
        0,
        this.scrollEl.scrollHeight - this.scrollEl.clientHeight,
      );
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
      this.searchReturnFocus =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
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
    if (returnFocus?.isConnected) returnFocus.focus();
  }

  // --- layout rendering -----------------------------------------------------

  private renderHeader(file: FileContents): void {
    const model = this.model;
    if (model == null) return;
    this.headerEl.replaceChildren();
    const squares = el("span", "u-squares");
    const { additions, deletions } = model.stats;
    const total = additions + deletions;
    let green = 0;
    if (total > 0) {
      green = Math.round((5 * additions) / total);
      green = Math.max(
        additions > 0 ? 1 : 0,
        Math.min(deletions > 0 ? 4 : 5, green),
      );
    }
    for (let i = 0; i < 5; i += 1)
      squares.append(
        el("span", `u-square ${i < green ? "g" : total > 0 ? "r" : "dim"}`),
      );
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
    const key = this.currentKey;
    return key != null ? (this.states.get(key)?.visible ?? []) : [];
  }

  private renderItems(): void {
    const model = this.model;
    if (model == null || this.currentKey == null) return;
    const generation = this.generation;
    const commentRows = this.commentRowIndexes();
    const items: LayoutItem[] = computeLayout(
      model.rows,
      this.visibleIntervals(),
      commentRows,
      this.language,
    );
    const fragment = document.createDocumentFragment();
    for (const item of items) {
      fragment.append(
        item.kind === "hunk"
          ? this.buildHunk(item, model, generation, commentRows)
          : this.buildGap(item),
      );
    }
    if (items.length === 0) {
      fragment.append(
        el(
          "div",
          "u-placeholder",
          model.binary ? "No text content (binary file)" : "No textual changes",
        ),
      );
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

  private buildHunk(
    item: Extract<LayoutItem, { kind: "hunk" }>,
    model: DiffModel,
    generation: number,
    commentRows: ReadonlySet<number>,
  ): HTMLElement {
    const section = el("section", "u-hunk");
    section.style.containIntrinsicSize = `auto ${(item.end - item.start) * LINE_HEIGHT + LINE_HEIGHT}px`;
    section.append(el("div", "u-hunk-header", item.header));
    for (let i = item.start; i < item.end; i += 1)
      section.append(this.buildRow(i, model, generation, commentRows));
    return section;
  }

  private buildGap(item: Extract<LayoutItem, { kind: "gap" }>): HTMLElement {
    const gap = el("div", "u-gap");
    const count = item.end - item.start;
    gap.append(
      el(
        "span",
        "u-gap-label",
        `⋯ ${count} unchanged line${count === 1 ? "" : "s"} ⋅`,
      ),
    );
    if (item.above)
      gap.append(
        this.expandButton(`Expand ${EXPAND_STEP} lines above`, "↑", () =>
          this.expandGap(item.start, EXPAND_STEP),
        ),
      );
    if (item.below)
      gap.append(
        this.expandButton(`Expand ${EXPAND_STEP} lines below`, "↓", () =>
          this.expandGap(item.end - Math.min(EXPAND_STEP, count), EXPAND_STEP),
        ),
      );
    gap.append(
      this.expandButton(`Expand all ${count} lines`, "⇊", () =>
        this.expandGap(item.start, count),
      ),
    );
    return gap;
  }

  private expandButton(
    title: string,
    label: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const button = el("button", "u-expand", label);
    button.type = "button";
    button.title = title;
    button.addEventListener("click", onClick);
    return button;
  }

  private expandGap(start: number, count: number): void {
    const key = this.currentKey;
    if (key == null || this.model == null) return;
    const state = this.states.get(key);
    if (state == null) return;
    state.visible = revealRange(
      state.visible,
      start,
      count,
      this.model.rows.length,
    );
    this.renderItemsPreserving();
  }

  private buildRow(
    index: number,
    model: DiffModel,
    generation: number,
    commentRows: ReadonlySet<number>,
  ): HTMLElement {
    const row = model.rows[index];
    const wrap = el("div", `u-row u-${row.type}`);
    wrap.dataset.idx = String(index);
    const main = el("div", "u-row-main");
    const gutter = el("div", "u-gutter");
    // Single line-number column: current line for context/additions, the old
    // number (red-tinted) for deletions. Clicks keep their respective side.
    const oldLine = row.oldLine;
    const newLine = row.newLine;
    const lno = el("span", "u-lno");
    if (row.type === "del") {
      lno.classList.add("u-lno-old");
      lno.textContent = String(oldLine);
      lno.title = `Comment on reviewed line ${oldLine}`;
      lno.addEventListener("click", () => {
        if (oldLine != null) this.host.addComment("original", oldLine);
      });
    } else {
      lno.textContent = String(newLine);
      lno.title = `Comment on current line ${newLine}`;
      lno.addEventListener("click", () => {
        if (newLine != null) this.host.addComment("modified", newLine);
      });
    }
    gutter.append(lno);
    const sign = el(
      "span",
      "u-sign",
      row.type === "add" ? "+" : row.type === "del" ? "-" : "\u00a0",
    );
    const code = el("code", "u-code");
    this.renderRowContent(code, row, generation);
    main.append(gutter, sign, code);
    wrap.append(main);
    if (model.oldNoEol && oldLine === model.oldLastLine)
      wrap.append(el("div", "u-noeol", "\\ No newline at end of file"));
    else if (model.newNoEol && newLine === model.newLastLine)
      wrap.append(el("div", "u-noeol", "\\ No newline at end of file"));
    if (commentRows.has(index)) wrap.classList.add("commented");
    if (this.markedRows.has(index)) wrap.classList.add("u-match");
    return wrap;
  }

  // Invalidates in-flight colorize work: queued tasks and pending side
  // promises must not paint into a view that is about to render new content,
  // and the previous file's live models must be freed.
  private resetColorize(): void {
    this.generation += 1;
    this.colorizeQueue.length = 0;
    this.sideLineHtml.clear();
    this.disposeSideModels();
  }

  private renderRowContent(
    target: HTMLElement,
    row: DiffRow,
    generation: number,
  ): void {
    target.replaceChildren();
    if (this.searchQuery && row.text.toLowerCase().includes(this.searchQuery)) {
      const text = row.text;
      const lower = text.toLowerCase();
      let cursor = 0;
      while (true) {
        const hit = lower.indexOf(this.searchQuery, cursor);
        if (hit < 0) break;
        if (hit > cursor)
          target.append(el("span", undefined, text.slice(cursor, hit)));
        target.append(
          el("mark", undefined, text.slice(hit, hit + this.searchQuery.length)),
        );
        cursor = hit + this.searchQuery.length;
      }
      if (cursor < text.length)
        target.append(el("span", undefined, text.slice(cursor)));
      this.appendTruncationMarker(target, row);
      return;
    }
    if (row.spans != null) {
      const spans = row.spans;
      for (const span of spans)
        target.append(el("span", `u-w-${span.kind}`, span.text));
      // Upgrade the plain paint to syntax-colored tokens with the word-diff
      // boxes re-applied; it stays as the fallback when colorize is missing.
      this.queueColorize(target, row, generation, (html) =>
        this.mergeWordDiffBoxes(html, spans),
      );
      return;
    }
    // Truncation markers must survive colorize, which replaces the text span's
    // innerHTML — so the code text lives in its own child span.
    const textSpan = el("span", "u-text");
    textSpan.textContent = row.text;
    target.append(textSpan);
    this.appendTruncationMarker(target, row);
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
      if (comment.side !== "file" && comment.line != null)
        wanted.set(comment.id, comment);
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
      const comment = wanted.get(id);
      if (comment == null) return false;
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
      if (existing?.isConnected) continue;
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
      rowEl.classList.toggle(
        "commented",
        highlighted.has(Number(rowEl.dataset.idx)),
      );
    }
  }

  private rowElement(index: number): HTMLElement | null {
    return this.itemsEl.querySelector<HTMLElement>(
      `.u-row[data-idx="${index}"]`,
    );
  }

  // --- syntax coloring ------------------------------------------------------

  // Whole-side colorize keeps Monarch token state across lines, so multi-line
  // block comments render as comments instead of mis-highlighted code (per-line
  // colorize restarts from the initial state and tokens a " * " continuation
  // line as code). Display-truncated lines stay out: their HTML chunk contains
  // the full source line, which cannot be spliced to the shown prefix.
  // `decorate` reworks colorized line HTML before it lands in the row (used to
  // re-apply word-diff boxes on token spans); when it returns null the row
  // keeps whatever is already painted there.
  private queueColorize(
    target: HTMLElement,
    row: DiffRow,
    generation: number,
    decorate?: (html: string) => DocumentFragment | null,
  ): void {
    if (this.language === "plaintext" || !row.text.trim()) return;
    const apply = (html: string, marks?: readonly BracketMark[]) => {
      if (decorate == null && marks == null) {
        target.innerHTML = html;
        return;
      }
      if (decorate == null) {
        const fragment = parseFragment(html);
        if (marks != null) this.wrapBracketMarks(fragment, marks, row.text);
        target.replaceChildren(fragment);
        return;
      }
      const merged = decorate(html);
      if (merged == null) return;
      if (marks != null) this.wrapBracketMarks(merged, marks, row.text);
      target.replaceChildren(merged);
    };
    // Checked at dispatch and again when the colorize promise resolves: the
    // row can be re-rendered in place between the two (same element, same
    // generation), and a then-fresh search highlight must not be overwritten.
    const stale = () =>
      generation !== this.generation ||
      !target.isConnected ||
      (this.searchQuery !== "" &&
        row.text.toLowerCase().includes(this.searchQuery));
    const source =
      row.fullLength == null
        ? colorizeSourceFor(row, {
            original: this.originalContent.length <= COLORIZE_SIDE_MAX_CHARS,
            modified: this.modifiedContent.length <= COLORIZE_SIDE_MAX_CHARS,
          })
        : null;
    if (source != null) {
      const content =
        source.side === "original"
          ? this.originalContent
          : this.modifiedContent;
      this.idle(() => {
        if (stale()) return;
        void this.sideLinesFor(source.side, content).then(
          (lines) => {
            if (stale()) return;
            const html = lines[source.line - 1];
            if (html)
              apply(html, this.sideBrackets.get(source.side)?.get(source.line));
          },
          () => {},
        );
      });
      return;
    }
    if (row.text.length > COLORIZE_MAX_CHARS) return;
    const promise = this.colorizePromise(row.text);
    this.idle(() => {
      if (stale()) return;
      void promise.then(
        (html) => {
          if (stale()) return;
          if (!html) return;
          apply(stripTrailingBr(html));
        },
        () => {},
      );
    });
  }

  // Re-applies bracket pair colors on top of colorized line HTML: walks text
  // nodes with a source-text cursor (spaces render as no-break spaces 1:1, so
  // slices must re-verify per node) and wraps each mark's slice in its color
  // class. Runs after the word-diff merge, so fragments split for box
  // painting still get their brackets colored.
  // All-or-nothing: replacements are planned against the source text before
  // any node is touched, and a line whose rendered text no longer aligns with
  // the source (tab expansion shifts offsets) or whose marks do not fit its
  // nodes keeps its plain token colors instead.
  private wrapBracketMarks(
    fragment: DocumentFragment,
    marks: readonly BracketMark[],
    source: string,
  ): void {
    const replacements: Array<{ node: Text; pieces: WordPiece[] }> = [];
    let offset = 0;
    let index = 0;
    for (const node of textNodes(fragment)) {
      if (index >= marks.length) break;
      const length = node.data.length;
      const slice = source.slice(offset, offset + length);
      if (!matchesColorizedText(node.data, slice)) return;
      const pieces: WordPiece[] = [];
      let cursor = 0;
      while (
        index < marks.length &&
        marks[index].start >= offset &&
        marks[index].end <= offset + length
      ) {
        const mark = marks[index];
        const start = mark.start - offset;
        const end = mark.end - offset;
        if (start > cursor)
          pieces.push({ text: slice.slice(cursor, start), className: null });
        pieces.push({
          text: slice.slice(start, end),
          className: mark.className,
        });
        cursor = end;
        index += 1;
      }
      if (pieces.length > 0) {
        if (cursor < length)
          pieces.push({ text: slice.slice(cursor), className: null });
        replacements.push({ node, pieces });
      }
      offset += length;
    }
    // Marks left over after the last text node straddle two nodes; they
    // cannot be wrapped, so the whole line stays plain.
    if (index < marks.length) return;
    for (const { node, pieces } of replacements)
      node.parentNode?.replaceChild(piecesFragment(pieces), node);
  }

  // Re-applies word-diff boxes on top of colorized line HTML: token spans are
  // kept intact and only their text nodes are split at fragment boundaries,
  // so syntax colors survive under the box backgrounds. Each text node must
  // match the spans' text at its offset — monaco's space→no-break-space
  // substitution is tolerated, tab expansion and stale side content are not
  // (the plain word-diff paint then stays).
  private mergeWordDiffBoxes(
    html: string,
    spans: readonly WordSpan[],
  ): DocumentFragment | null {
    const text = spans.map((span) => span.text).join("");
    const bounds = wordBounds(spans);
    if (bounds.length === 0) return null;
    const fragment = parseFragment(html);
    let offset = 0;
    let boundIndex = 0;
    for (const textNode of textNodes(fragment)) {
      if (
        !matchesColorizedText(
          textNode.data,
          text.slice(offset, offset + textNode.data.length),
        )
      )
        return null;
      const { pieces, nextIndex } = splitAtWordBounds(
        textNode.data,
        offset,
        bounds,
        boundIndex,
      );
      boundIndex = nextIndex;
      offset += textNode.data.length;
      if (pieces.length === 1 && pieces[0].className == null) continue;
      textNode.parentNode?.replaceChild(piecesFragment(pieces), textNode);
    }
    if (boundIndex < bounds.length || offset !== text.length) return null;
    return fragment;
  }

  // One colorize call per file side, memoized for the mounted content:
  // colorizing runs against a live model so Monarch state carries across
  // lines (multi-line block comments tokenize as comments, not code), and
  // the per-line HTML is split from that single pass. Created lazily inside
  // the idle queue so the synchronous tokenize pass never delays the initial
  // paint. Bracket pair colors are NOT part of that token stream — the editor
  // paints them as decorations from the model's bracket scanner, so the
  // scanner's output is collected here and wrapped onto the colorized HTML
  // by wrapBracketMarks.
  private sideLinesFor(side: DiffSide, content: string): Promise<string[]> {
    let promise = this.sideLineHtml.get(side);
    if (promise == null) {
      promise = Promise.resolve()
        .then(() => {
          const previous = this.sideModels.get(side);
          previous?.dispose();
          const model = monaco.editor.createModel(content, this.language);
          this.sideModels.set(side, model);
          const count = model.getLineCount();
          const lines = new Array<string>(count);
          for (let line = 1; line <= count; line += 1)
            lines[line - 1] = monaco.editor.colorizeModelLine(model, line, 4);
          this.sideBrackets.set(side, this.bracketMarksFor(model, count));
          return lines;
        })
        .catch(() => []);
      this.sideLineHtml.set(side, promise);
    }
    return promise;
  }

  private bracketMarksFor(
    model: monaco.editor.ITextModel,
    count: number,
  ): Map<number, BracketMark[]> {
    const marks = new Map<number, BracketMark[]>();
    // End the range at the last line's final column: a range ending at
    // column 1 drops every bracket after it (monaco only collects brackets
    // starting within the range), so a trailing `}` would stay uncolored.
    const brackets = (model as unknown as BracketModelLike).bracketPairs
      ?.getBracketsInRange(
        new monaco.Range(1, 1, count, model.getLineMaxColumn(count)),
        true,
      )
      .toArray();
    if (brackets == null) return marks;
    for (const bracket of brackets) {
      const list = marks.get(bracket.range.startLineNumber) ?? [];
      list.push({
        start: bracket.range.startColumn - 1,
        end: bracket.range.endColumn - 1,
        className: bracket.isInvalid
          ? "u-bracket-bad"
          : `u-bracket-${bracket.nestingLevel % BRACKET_COLORS}`,
      });
      marks.set(bracket.range.startLineNumber, list);
    }
    return marks;
  }

  private disposeSideModels(): void {
    for (const model of this.sideModels.values()) model.dispose();
    this.sideModels.clear();
    this.sideBrackets.clear();
  }

  private colorizePromise(text: string): Promise<string> {
    const key = `${this.language}\u0000${text}`;
    let promise = this.colorizeCache.get(key);
    if (promise == null) {
      promise = monaco.editor
        .colorize(text, this.language, { tabSize: 4 })
        .catch(() => "");
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
      for (const queued of this.colorizeQueue.splice(0, COLORIZE_BATCH))
        queued();
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
        if (model.rows[i].text.toLowerCase().includes(this.searchQuery))
          this.searchMatches.push(i);
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
    const key = this.currentKey;
    for (const index of this.searchMatches) {
      if (revealCount >= SEARCH_REVEAL_CAP) break;
      if (this.rowElement(index) != null) continue;
      const state = key != null ? this.states.get(key) : undefined;
      if (state != null && model != null) {
        state.visible = revealRange(
          state.visible,
          Math.max(0, index - 3),
          7,
          model.rows.length,
        );
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
      if (code != null && row != null)
        this.renderRowContent(code, row, this.generation);
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
    this.searchCurrent =
      (this.searchCurrent + direction + matches.length) % matches.length;
    for (const index of matches)
      this.rowElement(index)?.classList.remove("u-match-current");
    const current = matches[this.searchCurrent];
    const currentEl = this.rowElement(current);
    currentEl?.classList.add("u-match-current");
    currentEl?.scrollIntoView({ block: "center" });
    this.updateSearchCount();
  }

  private updateSearchCount(): void {
    const visible = this.searchQuery ? this.visibleMatchIndexes().length : 0;
    const hidden = this.searchMatches.length - visible;
    const current =
      visible > 0 ? Math.min(this.searchCurrent, visible - 1) + 1 : 0;
    this.searchCountEl.textContent = this.searchQuery
      ? `${current}/${visible}${hidden > 0 ? ` (${hidden} hidden)` : ""}`
      : "";
  }
}
