import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CommandRunResult, LoggedCommandRequest } from "../closeout-spec";

const REPORT_LIMIT = 65_536;

export function sessionCloseoutPath(root: string, taskId: string): string {
  return join(root, "runs", taskId, "closeout-session.json");
}

export function sessionCloseoutAccepted(report: string | undefined): boolean {
  if (report === undefined) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(report);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const record = parsed as Record<string, unknown>;
  const pending = record.pending;
  if (!Array.isArray(pending) || pending.some((id) => typeof id !== "string" || id.length === 0))
    return false;
  return pending.length === 0 && record.blocked === null;
}

/** The agent's `request_closeout_skip` from its Closeout session report, if it made one. */
export function sessionSkipRequest(
  report: string | undefined,
): { checks: string[]; reason: string } | null {
  if (report === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(report);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const request = (parsed as Record<string, unknown>).skip_request;
  if (!request || typeof request !== "object" || Array.isArray(request)) return null;
  const { checks, reason } = request as Record<string, unknown>;
  if (
    !Array.isArray(checks) ||
    checks.length === 0 ||
    checks.some((id) => typeof id !== "string" || id.length === 0) ||
    typeof reason !== "string" ||
    reason.trim().length === 0
  )
    return null;
  return { checks: checks as string[], reason: reason.trim().slice(0, 2000) };
}

export function skipRequestPath(root: string, taskId: string): string {
  return join(root, "runs", taskId, "closeout-skip.json");
}

/**
 * Keeps the agent's latest skip request for the task. A later session without one, such as a
 * fix round, leaves it in place until the Closeout recovery question takes it.
 */
export function saveSkipRequest(path: string, report: string | undefined): void {
  const request = sessionSkipRequest(report);
  if (request === null) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ skip_request: request }), { mode: 0o600 });
}

/** Reads and removes the saved skip request, so each recovery question gets its own. */
export function takeSkipRequest(path: string): { checks: string[]; reason: string } | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  rmSync(path, { force: true });
  return sessionSkipRequest(text);
}

export function writeSessionCloseout(path: string, head: string, report: string | undefined): void {
  if (
    report === undefined ||
    Buffer.byteLength(report) > REPORT_LIMIT ||
    !/^[a-f0-9]{40}$/.test(head)
  ) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ head, report }), { mode: 0o600 });
}

export function readSessionCloseout(path: string): { head: string; report: string } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (typeof record.head !== "string" || !/^[a-f0-9]{40}$/.test(record.head)) return undefined;
  if (typeof record.report !== "string" || Buffer.byteLength(record.report) > REPORT_LIMIT)
    return undefined;
  return { head: record.head, report: record.report };
}

export function loggedSessionCloseout(
  report: string | undefined,
  request: LoggedCommandRequest,
): CommandRunResult {
  const accepted = sessionCloseoutAccepted(report);
  const text = accepted
    ? "STDOUT\nCloseout session report is clear.\nSTDERR\n"
    : "STDOUT\nSTDERR\nCloseout session report is missing or unfinished.\n";
  const bytes = Buffer.from(text, "utf8");
  mkdirSync(dirname(request.logFile), { recursive: true, mode: 0o700 });
  writeFileSync(request.logFile, bytes, { mode: 0o600 });
  if (accepted) request.onOutput?.("stdout", "Closeout session report is clear.\n", false);
  else request.onOutput?.("stderr", "Closeout session report is missing or unfinished.\n", false);
  return {
    argv: [...request.argv],
    exitCode: accepted ? 0 : 1,
    timedOut: false,
    dirty: false,
    headMoved: false,
    durationMs: 0,
    truncated: false,
    artifacts: [
      { path: request.artifactPath, sha256: createHash("sha256").update(bytes).digest("hex") },
    ],
  };
}
