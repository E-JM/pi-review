import { relative, sep } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { type FSWatcher, watch } from "chokidar";
import { type GlimpseWindow, open } from "glimpseui";
import { createCheckpoint, getRepoRoot } from "./git.js";
import { composeFeedback } from "./prompt.js";
import type { HostMessage, ReviewCheckpoint, WindowMessage } from "./types.js";
import { loadReviewHtml, reviewHtmlPath } from "./ui.js";
import { WorkspaceModel } from "./workspace.js";

export const CHECKPOINT_ENTRY = "review-loop/checkpoint";

function isCheckpoint(value: unknown): value is ReviewCheckpoint {
  if (value == null || typeof value !== "object") return false;
  const item = value as Partial<ReviewCheckpoint>;
  return (
    item.version === 1 &&
    typeof item.repoRoot === "string" &&
    typeof item.createdAt === "number" &&
    typeof item.overrides === "object" &&
    Array.isArray(item.reviewedPaths)
  );
}

function latestCheckpoint(
  ctx: ExtensionCommandContext,
  repoRoot: string,
): ReviewCheckpoint | null {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry.type !== "custom" || entry.customType !== CHECKPOINT_ENTRY)
      continue;
    if (isCheckpoint(entry.data) && entry.data.repoRoot === repoRoot)
      return entry.data;
  }
  return null;
}

// The payload is evaluated as script inside the window, so <, >, and & become
// \u escapes: they can never terminate the string or form markup such as
// </script>, regardless of file names or comment text.
function escapeInline(value: string): string {
  return value
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

function parseMessage(value: unknown): WindowMessage | null {
  if (
    value == null ||
    typeof value !== "object" ||
    typeof (value as { type?: unknown }).type !== "string"
  )
    return null;
  return value as WindowMessage;
}

export class ReviewController {
  private window: GlimpseWindow | null = null;
  private watcher: FSWatcher | null = null;
  private model: WorkspaceModel | null = null;
  private repoRoot = "";
  private refreshTimer: NodeJS.Timeout | null = null;
  private operation = Promise.resolve();
  private submitting = false;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly onClosed: () => void,
  ) {}

  get isOpen(): boolean {
    return this.window != null;
  }

  async openOrShow(ctx: ExtensionCommandContext): Promise<void> {
    if (this.window != null) {
      this.window.show({ title: "Review Loop" });
      ctx.ui.notify("Review Loop is already open.", "info");
      return;
    }

    this.repoRoot = await getRepoRoot(this.pi, ctx.cwd);
    this.model = await WorkspaceModel.create(
      this.pi,
      this.repoRoot,
      latestCheckpoint(ctx, this.repoRoot),
    );
    await this.model.refresh();
    await this.startWatcher();

    // The Linux Chromium backend loads inline HTML by navigating to a data:
    // URL, which cannot carry this app's multi-megabyte bundle — load the
    // self-contained index.html from disk there instead.
    const fromDisk = process.platform === "linux";
    // Empty html keeps glimpseui's first "ready" event flowing to us, where
    // the content is loaded via loadFile (see below).
    const window = open(fromDisk ? "" : loadReviewHtml(), {
      width: 1480,
      height: 920,
      title: "Review Loop",
    });
    this.window = window;
    if (fromDisk) {
      let htmlLoaded = false;
      window.on("ready", () => {
        // Ready fires again after each navigation; only load once, and only
        // while this window is still the live one.
        if (htmlLoaded || this.window !== window) return;
        htmlLoaded = true;
        window.loadFile(reviewHtmlPath());
      });
    }
    window.on("message", (value) => {
      const message = parseMessage(value);
      if (message != null) void this.handleMessage(message, ctx);
    });
    window.on("closed", () => this.disposeWindow(window));
    window.on("error", (error) => {
      ctx.ui.notify(`Review Loop failed: ${error.message}`, "error");
      this.disposeWindow(window);
    });

    ctx.ui.notify("Opened Review Loop.", "info");
  }

  async close(): Promise<void> {
    if (this.refreshTimer != null) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    await this.watcher?.close();
    this.watcher = null;
    const window = this.window;
    this.window = null;
    try {
      window?.close();
    } catch {}
  }

  private async startWatcher(): Promise<void> {
    this.watcher = watch(this.repoRoot, {
      ignoreInitial: true,
      ignored: (path) => {
        const rel = relative(this.repoRoot, path);
        return (
          rel === ".git" ||
          rel.startsWith(`.git${sep}`) ||
          rel === "node_modules" ||
          rel.startsWith(`node_modules${sep}`)
        );
      },
    });
    // chokidar only reports paths under the watch root, so any event means
    // the workspace may have changed.
    this.watcher.on("all", () => this.scheduleRefresh());
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer != null) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.enqueue(async () => {
        if (this.model == null) return;
        const state = await this.model.refresh();
        this.send({ type: "workspace", state });
      });
    }, 100);
  }

  // Serializes window messages and refreshes. then(task, task) runs the next
  // task whether or not the previous one failed, and the trailing catch
  // keeps one bad task from wedging the queue.
  private enqueue(task: () => Promise<void>): void {
    this.operation = this.operation.then(task, task).catch(() => {});
  }

  private async handleMessage(
    message: WindowMessage,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    if (this.model == null) return;
    if (message.type === "ready") {
      this.send({ type: "workspace", state: this.model.state() });
      return;
    }

    if (message.type === "set-mode") {
      this.model.setMode(message.mode);
      this.send({ type: "workspace", state: this.model.state() });
      return;
    }

    if (message.type === "request-file") {
      try {
        this.send({
          type: "file",
          requestId: message.requestId,
          file: this.model.getFile(message.path, message.mode),
        });
      } catch (error) {
        this.send({
          type: "file-error",
          requestId: message.requestId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (message.type === "submit-review" && !this.submitting) {
      this.submitting = true;
      try {
        const feedback = composeFeedback(message.comments);
        const reviewedPaths = this.model.checkpointChangedPaths();
        const checkpoint = await createCheckpoint(
          this.pi,
          this.repoRoot,
          reviewedPaths,
          feedback,
        );
        this.pi.appendEntry<ReviewCheckpoint>(CHECKPOINT_ENTRY, checkpoint);
        this.model.setCheckpoint(checkpoint);
        const state = await this.model.refresh();
        if (feedback) {
          // pasteToEditor goes through the terminal paste machinery, which is
          // unreliable when the editor already has content; append explicitly
          // instead so feedback always lands next to whatever is already there.
          try {
            const existing = ctx.ui.getEditorText?.() ?? "";
            ctx.ui.setEditorText(
              existing ? `${existing}\n\n${feedback}` : feedback,
            );
          } catch {
            ctx.ui.pasteToEditor(feedback);
          }
        }
        this.send({ type: "workspace", state });
        this.send({
          type: "review-submitted",
          checkpointAt: checkpoint.createdAt,
          insertedFeedback: feedback.length > 0,
        });
        ctx.ui.notify(
          feedback
            ? "Review checkpoint saved; feedback inserted into the editor."
            : "Review checkpoint saved.",
          "info",
        );
      } catch (error) {
        ctx.ui.notify(
          `Could not save review checkpoint: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      } finally {
        this.submitting = false;
      }
    }
  }

  private send(message: HostMessage): void {
    if (this.window == null) return;
    const payload = escapeInline(JSON.stringify(message));
    try {
      this.window.send(`window.__reviewReceive(${payload})`);
    } catch {}
  }

  private disposeWindow(window: GlimpseWindow): void {
    if (this.window !== window) return;
    this.window = null;
    if (this.refreshTimer != null) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    void this.watcher?.close();
    this.watcher = null;
    this.onClosed();
  }
}
