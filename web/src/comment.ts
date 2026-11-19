import type { ReviewComment } from "../../src/types.js";

export type UiComment = ReviewComment & { id: string };

export interface InlineCommentCallbacks {
  onInput(): void;
  onDelete(): void;
}

export function commentSideLabel(comment: ReviewComment): string {
  if (comment.side === "modified") return "Current";
  return comment.mode === "head" ? "HEAD" : "Reviewed";
}

// Shared by the Monaco view zones and the unified view's DOM rows. The caller
// owns sizing and focus (via the data-comment-id contract): the factory never
// focuses on its own, so rebuilds and re-attaches never steal focus.
export function createInlineCommentElement(
  comment: UiComment,
  callbacks: InlineCommentCallbacks,
): HTMLElement {
  const container = document.createElement("div");
  container.className = "inline-comment";
  const header = document.createElement("div");
  header.className = "inline-comment-header";
  const title = document.createElement("strong");
  title.textContent =
    comment.line == null
      ? commentSideLabel(comment)
      : `${commentSideLabel(comment)} line ${comment.line}`;
  const remove = document.createElement("button");
  remove.textContent = "Delete";
  remove.addEventListener("click", callbacks.onDelete);
  header.append(title, remove);

  const textarea = document.createElement("textarea");
  textarea.dataset.commentId = comment.id;
  textarea.rows = 3;
  textarea.placeholder = "Leave actionable feedback…";
  textarea.value = comment.body;
  textarea.addEventListener("input", () => {
    comment.body = textarea.value;
    callbacks.onInput();
  });
  textarea.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter")
      textarea.blur();
    if (event.key === "Escape" && comment.body.trim().length === 0)
      callbacks.onDelete();
  });
  container.append(header, textarea);
  return container;
}

// Focus preservation across rebuilds: both views tear down and rebuild their
// comment elements; these capture/restore the textarea the user was typing in
// so an unrelated rebuild never costs them focus or cursor position.
export interface FocusedComment {
  id: string;
  start: number;
  end: number;
}

export function captureFocusedComment(): FocusedComment | null {
  const active = document.activeElement;
  if (
    !(active instanceof HTMLTextAreaElement) ||
    active.dataset.commentId == null
  )
    return null;
  return {
    id: active.dataset.commentId,
    start: active.selectionStart ?? 0,
    end: active.selectionEnd ?? 0,
  };
}

export function restoreFocusedComment(capture: FocusedComment | null): void {
  if (capture == null) return;
  const textarea = document.querySelector<HTMLTextAreaElement>(
    `textarea[data-comment-id="${CSS.escape(capture.id)}"]`,
  );
  if (textarea != null) {
    textarea.focus();
    textarea.setSelectionRange(capture.start, capture.end);
  }
}
