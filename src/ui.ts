import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const reviewHtmlUrl = new URL("../web/dist/index.html", import.meta.url);
const reviewHtmlFilePath = fileURLToPath(reviewHtmlUrl);

export function loadReviewHtml(): string {
  return readFileSync(reviewHtmlFilePath, "utf8");
}

export function reviewHtmlPath(): string {
  return reviewHtmlFilePath;
}
