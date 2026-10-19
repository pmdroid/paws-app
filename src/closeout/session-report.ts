import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CloseoutCommandRun, CommandRunResult, LoggedCommandRequest } from "../closeout-spec";

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

export type SessionCloseout = {
  head: string;
  report: string;
  /** The agent's `run_closeout` output for the reported changes. */
  runs?: CloseoutCommandRun[];
};

export function writeSessionCloseout(
  path: string,
  head: string,
  report: string | undefined,
  runs?: readonly CloseoutCommandRun[],
): void {
  if (
    report === undefined ||
    Buffer.byteLength(report) > REPORT_LIMIT ||
    !/^[a-f0-9]{40}$/.test(head)
  ) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const saved = runs?.filter(isRun) ?? [];
  writeFileSync(path, JSON.stringify({ head, report, ...(saved.length ? { runs: saved } : {}) }), {
    mode: 0o600,
  });
}

export function readSessionCloseout(path: string): SessionCloseout | undefined {
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
  const runs = Array.isArray(record.runs) ? record.runs.filter(isRun) : [];
  return { head: record.head, report: record.report, ...(runs.length ? { runs } : {}) };
}

/**
 * Builds a remote command check from the agent session. When the agent ran the
 * same command for the same commit, the check carries its output, exit code and
 * duration. Otherwise it says whether the session report is clear.
 */
export function loggedSessionCloseout(
  saved: SessionCloseout | undefined,
  request: LoggedCommandRequest,
): CommandRunResult {
  const accepted = sessionCloseoutAccepted(saved?.report);
  const run =
    saved?.head === request.expectedHead
      ? saved.runs?.findLast((entry) => sameArgv(entry.argv, request.argv))
      : undefined;
  const passed = run !== undefined && run.exitCode === 0 && !run.timedOut;
  let stdout = run?.stdout ?? "";
  let stderr = run?.stderr ?? "";
  let exitCode = run?.exitCode ?? (accepted ? 0 : 1);
  if (accepted && !passed) {
    stdout = run ? stdout : "Closeout session report is clear.\n";
    exitCode = 0;
  }
  if (!accepted) {
    stderr = `${stderr}${stderr && !stderr.endsWith("\n") ? "\n" : ""}Closeout session report is missing or unfinished.\n`;
    if (exitCode === 0) exitCode = 1;
  }
  const bytes = Buffer.from(`STDOUT\n${stdout}\nSTDERR\n${stderr}`, "utf8");
  mkdirSync(dirname(request.logFile), { recursive: true, mode: 0o700 });
  writeFileSync(request.logFile, bytes, { mode: 0o600 });
  if (stdout) request.onOutput?.("stdout", stdout, false);
  if (stderr) request.onOutput?.("stderr", stderr, false);
  return {
    argv: [...request.argv],
    exitCode,
    timedOut: !accepted && run?.timedOut === true,
    dirty: false,
    headMoved: false,
    durationMs: run?.durationMs ?? 0,
    truncated: run?.truncated ?? false,
    artifacts: [
      { path: request.artifactPath, sha256: createHash("sha256").update(bytes).digest("hex") },
    ],
  };
}

function sameArgv(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function isRun(value: unknown): value is CloseoutCommandRun {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const run = value as Record<string, unknown>;
  return (
    typeof run.id === "string" &&
    Array.isArray(run.argv) &&
    run.argv.every((part) => typeof part === "string") &&
    Number.isInteger(run.exitCode) &&
    typeof run.timedOut === "boolean" &&
    Number.isInteger(run.durationMs) &&
    (run.durationMs as number) >= 0 &&
    typeof run.stdout === "string" &&
    typeof run.stderr === "string" &&
    typeof run.truncated === "boolean"
  );
}
