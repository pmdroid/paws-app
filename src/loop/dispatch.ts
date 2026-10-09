import type { ActivityKind, TrackerAdapter } from "../linear";
import type { OutboxRow } from "../db";

const KINDS = new Set<ActivityKind>(["thought", "action", "elicitation", "response", "error"]);

/**
 * Deliver `linear` outbox rows to the tracker.
 * `activity` / `linear.activity` post progress. `linear.catchup` runs the poller.
 */
export function deliverLinearOutbox(
  message: OutboxRow,
  tracker: TrackerAdapter,
  catchUp: () => Promise<void>,
): Promise<void> {
  const payload = isRecord(message.payload) ? message.payload : {};
  if (message.op === "activity" || message.op === "linear.activity") {
    return postActivity(message, payload, tracker);
  }
  if (message.op === "elicitation") {
    return postElicitation(payload, tracker);
  }
  if (message.op === "status") {
    return postStatus(payload, tracker);
  }
  if (message.op === "catchup" || message.op === "linear.catchup") {
    return catchUp();
  }
  throw new Error(`unknown linear outbox op ${message.op}`);
}

async function postActivity(
  message: OutboxRow,
  payload: Record<string, unknown>,
  tracker: TrackerAdapter,
): Promise<void> {
  const sessionId = readString(payload, "sessionId") ?? message.orderingKey;
  const body = readString(payload, "body") ?? readString(payload, "text");
  if (sessionId === null || sessionId.length === 0) throw new Error("activity has no session");
  if (body === null) throw new Error("activity has no body");
  const kind = readKind(payload["kind"]) ?? "thought";
  await tracker.postProgress({ sessionId, kind, body });
}

async function postElicitation(
  payload: Record<string, unknown>,
  tracker: TrackerAdapter,
): Promise<void> {
  const sessionId = readString(payload, "sessionId");
  const body = readString(payload, "body");
  if (sessionId === null || body === null)
    throw new Error("elicitation is missing session or body");
  const options = readOptions(payload["options"]);
  await tracker.askQuestion({
    sessionId,
    body,
    ...(options.length > 0 ? { options } : {}),
  });
}

async function postStatus(
  payload: Record<string, unknown>,
  tracker: TrackerAdapter,
): Promise<void> {
  const linearIssueId = readString(payload, "linearIssueId");
  const stateType = readString(payload, "stateType");
  if (linearIssueId === null || !isStateType(stateType)) {
    throw new Error("status update is missing an issue or state");
  }
  await tracker.setStatus({ linearIssueId, stateType });
}

function readKind(value: unknown): ActivityKind | null {
  return typeof value === "string" && KINDS.has(value as ActivityKind)
    ? (value as ActivityKind)
    : null;
}

function readOptions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function isStateType(value: string | null): value is "started" | "completed" | "canceled" {
  return value === "started" || value === "completed" || value === "canceled";
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
