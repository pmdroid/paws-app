import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  CommandRunResult,
  LoggedCommandRequest,
  SessionCommandResult,
} from "../closeout-spec";

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
  let result: SessionCommandResult | undefined;
  try {
    const parsed = JSON.parse(report ?? "null");
    const entries = Array.isArray(parsed?.required) ? parsed.required : [];
    result = entries.find(
      (entry: { id?: string; status?: string; result?: SessionCommandResult }) =>
        (!request.itemId || entry.id === request.itemId) &&
        entry.status !== "stale" &&
        entry.result?.head === request.expectedHead &&
        JSON.stringify(entry.result.argv) === JSON.stringify(request.argv) &&
        Number.isSafeInteger(entry.result.exitCode) &&
        Number.isFinite(entry.result.durationMs) &&
        entry.result.durationMs >= 0 &&
        typeof entry.result.stdout === "string" &&
        typeof entry.result.stderr === "string" &&
        typeof entry.result.timedOut === "boolean" &&
        typeof entry.result.truncated === "boolean",
    )?.result;
  } catch {}
  const stdout = result?.stdout ?? "";
  const stderr =
    result?.stderr ??
    "Closeout command output is missing for this commit. Rerun the check on the candidate commit.\n";
  const bytes = Buffer.from(`STDOUT\n${stdout}\nSTDERR\n${stderr}`, "utf8");
  mkdirSync(dirname(request.logFile), { recursive: true, mode: 0o700 });
  writeFileSync(request.logFile, bytes, { mode: 0o600 });
  if (stdout) request.onOutput?.("stdout", stdout, result?.truncated ?? false);
  if (stderr) request.onOutput?.("stderr", stderr, result?.truncated ?? false);
  return {
    argv: [...request.argv],
    exitCode: result?.exitCode ?? 1,
    timedOut: result?.timedOut ?? false,
    dirty: false,
    headMoved: false,
    durationMs: result?.durationMs ?? 0,
    truncated: result?.truncated ?? false,
    artifacts: [
      { path: request.artifactPath, sha256: createHash("sha256").update(bytes).digest("hex") },
    ],
  };
}
