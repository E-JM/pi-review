import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ReviewController } from "./controller.js";

// glimpseui's native Linux backend renders the window as a gtk4-layer-shell
// overlay surface, which compositors like Hyprland cannot drag, close, or
// focus like a regular window, so prefer the Chromium backend. However, pi
// itself is a compiled binary, and glimpseui spawns that backend with
// process.execPath — which would relaunch pi instead of Node. Route glimpseui
// to the Chromium backend through a small Node launcher instead.
//
// Respected user overrides: GLIMPSE_BINARY_PATH / GLIMPSE_HOST_PATH pointing
// somewhere else, and GLIMPSE_BACKEND=native. A leftover GLIMPSE_BACKEND=chromium
// (e.g. from earlier debugging) still uses the launcher — it is the same
// backend, just spawned with a real Node executable.
const launcherPath = join(tmpdir(), "pi-review-loop-glimpse-backend.mjs");

function prepareLinuxGlimpseBackend(): void {
  if (process.platform !== "linux") return;
  const override = process.env.GLIMPSE_BINARY_PATH ?? process.env.GLIMPSE_HOST_PATH;
  if (override != null && override !== launcherPath && basename(override) !== basename(launcherPath)) return;
  if (process.env.GLIMPSE_BACKEND === "native") return;

  // Sibling check covers local/relative installs (deps next to the package);
  // import.meta.resolve covers hoisted layouts (npm/git installs).
  const sibling = new URL("../node_modules/glimpseui/src/chromium-backend.mjs", import.meta.url);
  let backendPath: string | null = existsSync(sibling) ? fileURLToPath(sibling) : null;
  if (backendPath == null) {
    try {
      backendPath = join(dirname(fileURLToPath(import.meta.resolve("glimpseui"))), "chromium-backend.mjs");
    } catch {
      backendPath = null;
    }
  }
  if (backendPath == null || !existsSync(backendPath)) {
    // Last resort: let glimpseui pick its own backend (works when pi runs
    // under a plain Node executable).
    process.env.GLIMPSE_BACKEND ??= "chromium";
    return;
  }

  // Template literal so the generated script reads exactly as it executes.
  const script = `#!/usr/bin/env node
// When pi exits first the stdio pipes break; die silently instead of
// dumping an unhandled EPIPE stack trace into the terminal.
process.stdout?.on?.("error", (err) => { if (err && err.code === "EPIPE") process.exit(0); });
process.stdin?.on?.("error", () => {});
// Known-noisy lines that fire on every open; real errors still print.
const noise = [
  "[glimpse] cursor backend: ",
  "Could not find Chrome X11 window",
  "'--ozone-platform=wayland' is not compatible with Vulkan",
];
const stderr = process.stderr;
const origWrite = stderr.write.bind(stderr);
stderr.write = (chunk, ...rest) => (typeof chunk === "string" && noise.some((s) => chunk.includes(s)) ? true : origWrite(chunk, ...rest));

await import(${JSON.stringify(backendPath)});
`;
  writeFileSync(launcherPath, script, { mode: 0o755 });
  // Defeat a restrictive umask: the launcher must stay executable.
  try { chmodSync(launcherPath, 0o755); } catch {}
  process.env.GLIMPSE_BINARY_PATH = launcherPath;
}

prepareLinuxGlimpseBackend();

export default function reviewLoop(pi: ExtensionAPI) {
  let controller: ReviewController | null = null;

  const getController = (): ReviewController => {
    if (controller == null) {
      controller = new ReviewController(pi, () => {
        controller = null;
      });
    }
    return controller;
  };

  const openReview = async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("Review Loop requires interactive TUI mode.", "warning");
      return;
    }
    try {
      await getController().openOrShow(ctx);
    } catch (error) {
      controller = null;
      ctx.ui.notify(`Could not open Review Loop: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  };

  pi.registerCommand("diff-review", {
    description: "Open the persistent incremental diff reviewer",
    handler: openReview,
  });

  pi.on("session_shutdown", async () => {
    const active = controller;
    controller = null;
    await active?.close();
  });
}
