import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { AcpEvent } from "../acp";
import type { ActivityKind, ProgressUpdate } from "../linear";

/** Backup post when a run has produced no Linear activity yet. */
export const FIRST_ACTIVITY_MS = 10_000;

/**
 * Keepalive cadence. Linear marks an agent session stale after 30 minutes
 * without an activity, so this stays strictly under that window.
 */
export const KEEPALIVE_MS = 10 * 60 * 1000;

export const LINEAR_STALE_MS = 30 * 60 * 1000;

const ACTIVITY_LIMIT = 3_500;

export type AcpActivity = Omit<ProgressUpdate, "sessionId">;

export function shouldPostFirstActivity(alreadyPosted: boolean, elapsedMs: number): boolean {
  return !alreadyPosted && elapsedMs >= FIRST_ACTIVITY_MS;
}

export function shouldKeepAlive(sinceLastActivityMs: number): boolean {
  return sinceLastActivityMs >= KEEPALIVE_MS;
}

export function activityFromAcpEvent(event: AcpEvent): AcpActivity | null {
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

export function createAcpActivityReporter(post: (activity: AcpActivity) => void): {
  onEvent(event: AcpEvent): void;
  flush(): void;
  resultBody(): string;
} {
  let pending = "";
  let resultBody = "";
  const toolTitles = new Map<string, string>();

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
        if (update.sessionUpdate === "tool_call" && update.title?.trim()) {
          toolTitles.set(update.toolCallId, update.title);
        }
        if (update.sessionUpdate === "tool_call_update") {
          const title = update.title?.trim() || toolTitles.get(update.toolCallId);
          if (title) {
            const activity = toolActivity(title, update.toolCallId, update.status ?? undefined);
            if (activity) {
              flush();
              post(activity);
              if (update.status === "completed" || update.status === "failed")
                toolTitles.delete(update.toolCallId);
              return;
            }
          }
        }
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

function fromSessionUpdate(update: SessionUpdate): AcpActivity | null {
  switch (update.sessionUpdate) {
    case "agent_thought_chunk":
      return null;
    case "agent_message_chunk":
      return clip("thought", textOf(update.content));
    case "tool_call":
      return toolActivity(
        update.title?.trim() || update.toolCallId,
        update.toolCallId,
        update.status,
      );
    case "tool_call_update":
      return update.title
        ? toolActivity(update.title, update.toolCallId, update.status ?? undefined)
        : null;
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

function toolActivity(title: string, toolCallId: string, status?: string): AcpActivity | null {
  const activity = clip("action", title);
  if (activity === null) return null;
  return {
    ...activity,
    action: {
      action: activity.body,
      parameter: toolCallId,
      ...(status === undefined ? {} : { result: status }),
    },
    ...(status === "completed" || status === "failed" ? {} : { ephemeral: true }),
  };
}

function textOf(content: { type: string; text?: string }): string {
  return content.type === "text" ? (content.text ?? "") : "";
}

function clip(kind: ActivityKind, body: string): AcpActivity | null {
  const clipped = clipActivity(body);
  if (clipped === "") return null;
  return { kind, body: clipped };
}
