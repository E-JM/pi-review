import type { ReviewComment } from "./types.js";

function location(comment: ReviewComment): string {
  if (comment.side === "file" || comment.line == null) return comment.path;
  if (comment.side !== "original") return `${comment.path}:${comment.line}`;
  const suffix = comment.mode === "head" ? " (HEAD)" : " (reviewed)";
  return `${comment.path}:${comment.line}${suffix}`;
}

export function composeFeedback(comments: ReviewComment[]): string {
  const valid = comments.filter((comment) => comment.body.trim().length > 0);
  if (valid.length === 0) return "";

  const lines: string[] = [];
  valid.forEach((comment, index) => {
    lines.push(`${index + 1}. ${location(comment)}`);
    lines.push(`   ${comment.body.trim().replace(/\n/g, "\n   ")}`);
    lines.push("");
  });
  return lines.join("\n").trim();
}
