export const LINEAR_SESSION_API_PATH = "/api/linear/sessions";

export type LinearSessionTarget = { kind: "issue" | "comment"; id: string };
export type StartedLinearSession = { id: string; url: string | null };

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const ISSUE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

export function parseLinearSessionTarget(value: string): LinearSessionTarget {
  const input = value.trim();
  if (ISSUE.test(input)) return { kind: "issue", id: input.toUpperCase() };
  if (UUID.test(input)) return { kind: "issue", id: input };
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Enter an issue identifier or a Linear issue or comment link.");
  }
  if (url.origin !== "https://linear.app" || url.username || url.password) {
    throw new Error("Use a link from linear.app.");
  }
  if (url.hash) {
    const commentId = url.hash.replace(/^#comment-/, "");
    if (!UUID.test(commentId)) throw new Error("Copy the link to the root comment thread.");
    return { kind: "comment", id: commentId };
  }
  const parts = url.pathname.split("/");
  const issue = parts[parts.indexOf("issue") + 1];
  if (!parts.includes("issue") || issue === undefined || !ISSUE.test(issue)) {
    throw new Error("Use a Linear issue link or copy the link to a root comment thread.");
  }
  return { kind: "issue", id: issue.toUpperCase() };
}
