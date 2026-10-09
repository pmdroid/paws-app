import { createHmac, timingSafeEqual } from "node:crypto";
import {
  activityKey,
  deliveryKey,
  sessionCreatedKey,
  type AcceptedLinearEvent,
  type LinearEventAction,
} from "./events";
import type { InboxStore } from "./inbox";
import { isRecord, readNumber, readString } from "./read";

export const TIMESTAMP_WINDOW_MS = 60_000;

export type SignatureCheck =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "missing_signature"
        | "missing_secret"
        | "bad_signature"
        | "stale_timestamp"
        | "missing_timestamp";
    };

export type SignatureInput = {
  signature: string | null;
  secret: string | null;
  rawBody: string;
  timestampMs: number | null;
  nowMs?: number;
};

export type LinearWebhookDeps = {
  store: InboxStore;
  onEvent?: (event: AcceptedLinearEvent) => void | Promise<void>;
  now?: () => number;
};

const flights = new WeakMap<InboxStore, Set<string>>();

/**
 * HMAC-SHA256 of the raw body, hex-encoded in `Linear-Signature`.
 * `webhookTimestamp` must be within 60 seconds.
 */
export function checkLinearSignature(input: SignatureInput): SignatureCheck {
  if (input.signature === null || input.signature.length === 0) {
    return { ok: false, reason: "missing_signature" };
  }
  if (input.secret === null || input.secret.length === 0) {
    return { ok: false, reason: "missing_secret" };
  }
  if (!/^[0-9a-f]{64}$/i.test(input.signature)) {
    return { ok: false, reason: "bad_signature" };
  }
  const computed = createHmac("sha256", input.secret).update(input.rawBody).digest();
  const provided = Buffer.from(input.signature, "hex");
  if (computed.length !== provided.length || !timingSafeEqual(computed, provided)) {
    return { ok: false, reason: "bad_signature" };
  }
  if (input.timestampMs === null) return { ok: false, reason: "missing_timestamp" };
  const now = input.nowMs ?? Date.now();
  if (Math.abs(now - input.timestampMs) > TIMESTAMP_WINDOW_MS) {
    return { ok: false, reason: "stale_timestamp" };
  }
  return { ok: true };
}

/**
 * Verify, dedupe, commit, then 200. The follow-up (first activity, intake) is not awaited,
 * so the ack stays inside Linear's 5 second budget.
 */
export async function handleLinearWebhook(
  request: Request,
  secret: string | null,
  deps: LinearWebhookDeps | undefined = undefined,
): Promise<Response> {
  const signature = request.headers.get("linear-signature");
  if (signature === null || signature.length === 0) {
    return reject("missing_signature");
  }
  if (secret === null || secret.length === 0) {
    return reject("missing_secret");
  }
  const deliveryId = request.headers.get("linear-delivery");
  const rawBody = await request.text();
  const timestampMs = readTimestamp(rawBody, request.headers.get("linear-timestamp"));
  const check = checkLinearSignature({
    signature,
    secret,
    rawBody,
    timestampMs,
    nowMs: deps?.now?.(),
  });
  if (!check.ok) return reject(check.reason);
  if (deliveryId === null || deliveryId.length === 0) return reject("missing_delivery");
  const event = parseAgentEvent(rawBody, deliveryId, timestampMs ?? Date.now());
  if (event === null) return reject("bad_payload");
  if (deps?.store === undefined) {
    return Response.json({ ok: false, reason: "not_persisted" }, { status: 500 });
  }
  const committed = deps.store.commit(event);
  if (committed.inserted || !committed.handled) schedule(deps, event);
  return Response.json({ ok: true, duplicate: !committed.inserted });
}

function schedule(deps: LinearWebhookDeps, event: AcceptedLinearEvent): void {
  if (deps.onEvent === undefined) return;
  const pending = flightsFor(deps.store);
  if (pending.has(event.dedupeKey)) return;
  pending.add(event.dedupeKey);
  void Promise.resolve(deps.onEvent(event))
    .then(() => {
      deps.store.markHandled(event.dedupeKey);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "follow-up failed";
      console.error(`linear webhook follow-up failed: ${message}`);
    })
    .finally(() => {
      pending.delete(event.dedupeKey);
    });
}

function flightsFor(store: InboxStore): Set<string> {
  const existing = flights.get(store);
  if (existing !== undefined) return existing;
  const created = new Set<string>();
  flights.set(store, created);
  return created;
}

function reject(reason: string): Response {
  const status = reason === "bad_payload" ? 400 : 401;
  return Response.json({ ok: false, reason }, { status });
}

function readTimestamp(rawBody: string, header: string | null): number | null {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (isRecord(parsed)) {
      const bodyTimestamp = readNumber(parsed, "webhookTimestamp");
      if (bodyTimestamp !== null) return bodyTimestamp;
    }
  } catch {
    return null;
  }
  if (header === null || header.length === 0) return null;
  const parsedHeader = Number(header);
  return Number.isFinite(parsedHeader) ? parsedHeader : null;
}

export function parseAgentEvent(
  rawBody: string,
  deliveryId: string,
  timestampMs: number,
): AcceptedLinearEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const type = readString(parsed, "type");
  const actionName = readString(parsed, "action");
  const session = isRecord(parsed["agentSession"]) ? parsed["agentSession"] : null;
  const activity = isRecord(parsed["agentActivity"]) ? parsed["agentActivity"] : null;
  const sessionId = session === null ? null : readString(session, "id");
  const issue = session !== null && isRecord(session["issue"]) ? session["issue"] : null;
  const issueId =
    session === null
      ? null
      : (readString(session, "issueId") ?? (issue === null ? null : readString(issue, "id")));
  const activityId = activity === null ? null : readString(activity, "id");
  const content = activity !== null && isRecord(activity["content"]) ? activity["content"] : null;
  const body =
    activity === null
      ? null
      : (readString(activity, "body") ?? (content === null ? null : readString(content, "body")));
  const signal = activity === null ? null : readString(activity, "signal");
  const action = agentAction(type, actionName);
  const dedupeKey = dedupeFor(action, sessionId, activityId, deliveryId);
  return {
    dedupeKey,
    deliveryId,
    source: "webhook",
    action,
    sessionId,
    issueId,
    activityId,
    body,
    signal,
    updatedAtMs: timestampMs,
    payload: rawBody,
  };
}

function agentAction(type: string | null, action: string | null): LinearEventAction {
  if (type !== "AgentSessionEvent") return "other";
  if (action === "created") return "created";
  if (action === "prompted") return "prompted";
  return "other";
}

function dedupeFor(
  action: LinearEventAction,
  sessionId: string | null,
  activityId: string | null,
  deliveryId: string,
): string {
  if (action === "created" && sessionId !== null) return sessionCreatedKey(sessionId);
  if (action === "prompted" && activityId !== null) return activityKey(activityId);
  return deliveryKey(deliveryId);
}
