import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { AcpEvent } from "../acp";
import type { ActivityKind } from "../linear";

/** Backup post when a run has produced no Linear activity yet. */
export const FIRST_ACTIVITY_MS = 10_000;

/**
 * Keepalive cadence. Linear marks an agent session stale after 30 minutes
 * without an activity, so this stays strictly under that window.
 */
export const KEEPALIVE_MS = 10 * 60 * 1000;

export const LINEAR_STALE_MS = 30 * 60 * 1000;

const ACTIVITY_LIMIT = 3_500;

export function shouldPostFirstActivity(alreadyPosted: boolean, elapsedMs: number): boolean {
  return !alreadyPosted && elapsedMs >= FIRST_ACTIVITY_MS;
}

export function shouldKeepAlive(sinceLastActivityMs: number): boolean {
  return sinceLastActivityMs >= KEEPALIVE_MS;
}

export function activityFromAcpEvent(event: AcpEvent): { kind: ActivityKind; body: string } | null {
  switch (event.type) {
    case "session_update":
      return fromSessionUpdate(event.update);
    case "error":
      return clip("error", event.message);
    case "permission":
      return clip("action", event.title?.trim() || event.reason);
    case "prompt_complete":
      return clip("thought", `Agent turn ended (${event.stopReason}).`);
    case "cancelled":
      if (event.reason === "follow_up") return null;
      return clip("error", event.reason === "timeout" ? "Run timed out." : "Run cancelled.");
    case "ask_team":
      return null;
    default:
      return null;
  }
}

export function createAcpActivityReporter(
  post: (activity: { kind: ActivityKind; body: string }) => void,
): { onEvent(event: AcpEvent): void; flush(): void; resultBody(): string } {
  let pending = "";
  let resultBody = "";

  function flush(): boolean {
    const body = pending.trim();
    const activity = clip("thought", body);
    pending = "";
    if (activity === null) return false;
    resultBody = body;
    post(activity);
    return true;
  }

  return {
    onEvent(event) {
      if (event.type === "session_update") {
        const update = event.update;
        if (update.sessionUpdate === "agent_thought_chunk") return;
        if (update.sessionUpdate === "agent_message_chunk") {
          pending += textOf(update.content);
          return;
        }
      }
      const activity = activityFromAcpEvent(event);
      if (activity === null) return;
      const flushed = flush();
      if (event.type === "prompt_complete" && flushed) return;
      post(activity);
    },
    flush,
    resultBody: () => resultBody,
  };
}

export function clipActivity(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length <= ACTIVITY_LIMIT) return trimmed;
  return `${trimmed.slice(0, ACTIVITY_LIMIT - 1)}…`;
}

function fromSessionUpdate(update: SessionUpdate): { kind: ActivityKind; body: string } | null {
  switch (update.sessionUpdate) {
    case "agent_thought_chunk":
      return null;
    case "agent_message_chunk":
      return clip("thought", textOf(update.content));
    case "tool_call":
      return clip("action", update.title?.trim() || update.toolCallId);
    case "tool_call_update":
      return update.title ? clip("action", update.title) : null;
    case "plan": {
      const body = update.entries
        .map((entry) => entry.content)
        .filter((line) => line.trim() !== "")
        .join("; ");
      return clip("thought", body || "Updated the plan.");
    }
    default:
      return null;
  }
}

function textOf(content: { type: string; text?: string }): string {
  return content.type === "text" ? (content.text ?? "") : "";
}

function clip(kind: ActivityKind, body: string): { kind: ActivityKind; body: string } | null {
  const clipped = clipActivity(body);
  if (clipped === "") return null;
  return { kind, body: clipped };
}
