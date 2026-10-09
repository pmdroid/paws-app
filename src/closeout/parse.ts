import {
  expectedExit,
  exitMeaning,
  type DecisionDocument,
  type CloseoutItem,
  type ItemState,
} from "./types";

const ITEM_STATES = new Set<ItemState>([
  "passed",
  "failed",
  "missing",
  "stale",
  "unsupported",
  "independence",
  "untrusted",
  "invalid",
  "skipped",
  "exhausted",
]);

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

const DECISION_KEYS = new Set([
  "specVersion",
  "decision",
  "gate",
  "base",
  "head",
  "message",
  "candidate",
  "policy",
  "items",
  "warnings",
]);

export type ParsedCloseout =
  | { ok: true; decision: DecisionDocument }
  | { ok: false; error: string };

export function parseDecisionJson(stdout: string): ParsedCloseout {
  const trimmed = stdout.trim();
  if (trimmed === "") return { ok: false, error: "closeout returned empty stdout" };
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: "closeout stdout is not JSON" };
  }
  return parseDecision(value);
}

export function parseDecision(value: unknown): ParsedCloseout {
  if (!isRecord(value)) return { ok: false, error: "decision is not an object" };
  const extra = unknownKeys(value, DECISION_KEYS);
  if (extra) return { ok: false, error: `unknown decision field ${extra}` };
  if (value.specVersion !== "0.1") return { ok: false, error: "specVersion must be 0.1" };
  if (
    value.decision !== "accepted" &&
    value.decision !== "rejected" &&
    value.decision !== "blocked"
  ) {
    return { ok: false, error: "decision must be accepted, rejected, or blocked" };
  }
  if (value.gate !== "beforePR") return { ok: false, error: "gate must be beforePR" };
  if (!isSha(value.base)) return { ok: false, error: "base is not a commit id" };
  if (!isSha(value.head)) return { ok: false, error: "head is not a commit id" };
  if (value.message !== undefined && typeof value.message !== "string") {
    return { ok: false, error: "message must be a string" };
  }
  const candidate = parseCandidate(value.candidate);
  if (!candidate.ok) return candidate;
  const policy = parsePolicy(value.policy);
  if (!policy.ok) return policy;
  const items = parseItems(value.items);
  if (!items.ok) return items;
  const warnings = parseWarnings(value.warnings);
  if (!warnings.ok) return warnings;

  const decision: DecisionDocument = {
    specVersion: "0.1",
    decision: value.decision,
    gate: "beforePR",
    base: value.base,
    head: value.head,
    candidate: candidate.value,
    policy: policy.value,
    items: items.value,
    warnings: warnings.value,
  };
  if (typeof value.message === "string") decision.message = value.message;
  return { ok: true, decision };
}

/**
 * Agree the process status with the decision document.
 * A mismatch is never treated as accepted.
 */
export function interpretCloseoutOutput(
  exitCode: number | null,
  stdout: string,
): ParsedCloseout & { exitCode: number | null; meaning: ReturnType<typeof exitMeaning> } {
  const meaning = exitMeaning(exitCode);
  if (meaning === "invalid") {
    return { ok: false, error: `invalid closeout exit ${exitCode ?? "null"}`, exitCode, meaning };
  }
  const parsed = parseDecisionJson(stdout);
  if (!parsed.ok) return { ...parsed, exitCode, meaning };
  if (expectedExit(parsed.decision.decision) !== exitCode) {
    return {
      ok: false,
      error: `exit ${exitCode} does not match decision ${parsed.decision.decision}`,
      exitCode,
      meaning,
    };
  }
  return { ...parsed, exitCode, meaning };
}

export function isSha(value: unknown): value is string {
  return typeof value === "string" && SHA.test(value);
}

export function assertTaskId(taskId: string): string | null {
  if (typeof taskId !== "string" || taskId.length === 0 || taskId.trim() !== taskId) {
    return "task id must be a nonblank string";
  }
  if (taskId.includes("\0") || taskId.startsWith("-")) {
    return "task id must not start with '-' or contain NUL";
  }
  if (Buffer.byteLength(taskId, "utf8") > 256) {
    return "task id must be at most 256 bytes";
  }
  return null;
}

function parseCandidate(
  value: unknown,
): { ok: true; value: DecisionDocument["candidate"] } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "candidate is not an object" };
  const extra = unknownKeys(value, new Set(["task", "session", "model", "provider"]));
  if (extra) return { ok: false, error: `unknown candidate field ${extra}` };
  if (
    typeof value.session !== "string" ||
    typeof value.model !== "string" ||
    typeof value.provider !== "string"
  ) {
    return { ok: false, error: "candidate session, model, and provider are required" };
  }
  if (value.task !== undefined && (typeof value.task !== "string" || value.task.length === 0)) {
    return { ok: false, error: "candidate task must be a non-empty string" };
  }
  const candidate: DecisionDocument["candidate"] = {
    session: value.session,
    model: value.model,
    provider: value.provider,
  };
  if (typeof value.task === "string") candidate.task = value.task;
  return { ok: true, value: candidate };
}

function parsePolicy(
  value: unknown,
): { ok: true; value: DecisionDocument["policy"] } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "policy is not an object" };
  const extra = unknownKeys(value, new Set(["path", "digest", "absent"]));
  if (extra) return { ok: false, error: `unknown policy field ${extra}` };
  if (!(typeof value.path === "string" || value.path === null)) {
    return { ok: false, error: "policy path must be a string or null" };
  }
  if (!(typeof value.digest === "string" || value.digest === null)) {
    return { ok: false, error: "policy digest must be a string or null" };
  }
  if (typeof value.digest === "string" && !DIGEST.test(value.digest)) {
    return { ok: false, error: "policy digest must be sha256:<64 hex>" };
  }
  if (typeof value.absent !== "boolean")
    return { ok: false, error: "policy absent must be a boolean" };
  return { ok: true, value: { path: value.path, digest: value.digest, absent: value.absent } };
}

function parseItems(
  value: unknown,
): { ok: true; value: CloseoutItem[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) return { ok: false, error: "items must be an array" };
  const items: CloseoutItem[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return { ok: false, error: "item is not an object" };
    const extra = unknownKeys(entry, new Set(["id", "kind", "state", "message", "attempt"]));
    if (extra) return { ok: false, error: `unknown item field ${extra}` };
    if (typeof entry.id !== "string" || entry.id.length === 0)
      return { ok: false, error: "item id is required" };
    if (typeof entry.kind !== "string" || entry.kind.length === 0)
      return { ok: false, error: "item kind is required" };
    if (typeof entry.state !== "string" || !ITEM_STATES.has(entry.state as ItemState)) {
      return { ok: false, error: `item state is not recognized` };
    }
    if (typeof entry.message !== "string")
      return { ok: false, error: "item message must be a string" };
    const item: CloseoutItem = {
      id: entry.id,
      kind: entry.kind,
      state: entry.state as ItemState,
      message: entry.message,
    };
    if (entry.attempt !== undefined) {
      if (
        typeof entry.attempt !== "number" ||
        !Number.isInteger(entry.attempt) ||
        entry.attempt < 1
      ) {
        return { ok: false, error: "item attempt must be a positive integer" };
      }
      item.attempt = entry.attempt;
    }
    items.push(item);
  }
  return { ok: true, value: items };
}

function parseWarnings(
  value: unknown,
): { ok: true; value: DecisionDocument["warnings"] } | { ok: false; error: string } {
  if (!Array.isArray(value)) return { ok: false, error: "warnings must be an array" };
  const warnings: DecisionDocument["warnings"] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return { ok: false, error: "warning is not an object" };
    const extra = unknownKeys(entry, new Set(["code", "message"]));
    if (extra) return { ok: false, error: `unknown warning field ${extra}` };
    if (typeof entry.code !== "string" || typeof entry.message !== "string") {
      return { ok: false, error: "warning code and message are required" };
    }
    warnings.push({ code: entry.code, message: entry.message });
  }
  return { ok: true, value: warnings };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownKeys(value: Record<string, unknown>, allowed: Set<string>): string | null {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return key;
  }
  return null;
}
