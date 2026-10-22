import type { AcpEvent } from "../acp";
import type { ActivityKind, ProgressUpdate, SessionPlanStep } from "../linear";
import { scrubText } from "../closeout";

/** Backup post when a run has produced no Linear activity yet. */
export const FIRST_ACTIVITY_MS = 10_000;

/**
 * Keepalive cadence. Linear marks an agent session stale after 30 minutes
 * without an activity, so this stays strictly under that window.
 */
export const KEEPALIVE_MS = 10 * 60 * 1000;

export const LINEAR_STALE_MS = 30 * 60 * 1000;

const ACTIVITY_PART_LENGTH = 3_500;
type AcpActivity = Omit<ProgressUpdate, "sessionId">;

export function shouldPostFirstActivity(alreadyPosted: boolean, elapsedMs: number): boolean {
  return !alreadyPosted && elapsedMs >= FIRST_ACTIVITY_MS;
}

export function shouldKeepAlive(sinceLastActivityMs: number): boolean {
  return sinceLastActivityMs >= KEEPALIVE_MS;
}

export function activityFromAcpEvent(event: AcpEvent): AcpActivity | null {
  switch (event.type) {
    case "progress":
      return clip("thought", event.text);
    case "session_update":
      return null;
    case "error":
      return clip("error", event.message);
    case "permission":
      if (event.decision !== "deny") return null;
      return clip("action", event.title?.trim() || event.reason);
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
  emit: (activity: AcpActivity) => void,
  onPlan?: (steps: readonly SessionPlanStep[]) => void,
): {
  onEvent(event: AcpEvent): void;
  flush(): void;
  resultBody(): string;
} {
  let pending = "";
  let resultBody = "";

  function post(activity: AcpActivity) {
    for (let start = 0; start === 0 || start < activity.body.length; start += ACTIVITY_PART_LENGTH)
      emit({ ...activity, body: activity.body.slice(start, start + ACTIVITY_PART_LENGTH) });
  }

  function flush() {
    const body = pending.trim();
    pending = "";
    if (body !== "") resultBody = body;
  }

  return {
    onEvent(event) {
      if (event.type === "progress" && event.messageChunk) return;
      if (event.type === "session_update") {
        const update = event.update;
        if (update.sessionUpdate === "plan") {
          onPlan?.(
            update.entries.map((entry) => ({
              content: entry.content,
              status: entry.status === "in_progress" ? "inProgress" : entry.status,
            })),
          );
          return;
        }
        if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
          if (update.kind !== "think" && update.kind !== "switch_mode") flush();
          return;
        }
        if (update.sessionUpdate === "agent_thought_chunk") return;
        if (update.sessionUpdate === "agent_message_chunk") {
          pending += textOf(update.content);
          return;
        }
      }
      if (event.type === "prompt_complete") flush();
      const activity = activityFromAcpEvent(event);
      if (activity === null) return;
      flush();
      post(activity);
    },
    flush,
    resultBody: () => resultBody,
  };
}

function textOf(content: { type: string; text?: string }): string {
  return content.type === "text" ? (content.text ?? "") : "";
}

function clip(kind: ActivityKind, body: string): AcpActivity | null {
  const clipped = body.trim();
  if (clipped === "") return null;
  return { kind, body: clipped };
}

export function publicToolText(value: unknown): string {
  const secrets = Object.entries(process.env).flatMap(([key, secret]) =>
    /API.?KEY|PASSWORD|SECRET|TOKEN|CREDENTIAL|PRIVATE.?KEY/i.test(key) && secret ? [secret] : [],
  );
  function text(content: string): string {
    return scrubText(content, secrets)
      .replace(
        /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
        "[redacted]",
      )
      .replace(/\b(Bearer|Basic)\s+[^\s"'<>]+/gi, "$1 [redacted]")
      .replace(
        /\b([\w-]*(?:api[_-]?key|password|secret|token|authorization|cookie)[\w-]*["']?\s*[:=]\s*)(\[redacted\]|"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,
        (_match, prefix: string, credentialValue: string) =>
          `${prefix}${credentialValue.startsWith('"') ? '"[redacted]"' : credentialValue.startsWith("'") ? "'[redacted]'" : "[redacted]"}`,
      )
      .replace(/https?:\/\/[^\s<>"']+/g, (raw) => {
        try {
          const url = new URL(raw);
          url.username = "";
          url.password = "";
          url.search = "";
          url.hash = "";
          return url.href;
        } catch {
          return "[redacted URL]";
        }
      });
  }
  function clean(input: unknown, depth: number): unknown {
    if (typeof input === "string") return text(input);
    if (input === null || typeof input === "number" || typeof input === "boolean") return input;
    if (depth >= 32) return "[truncated]";
    if (Array.isArray(input)) return input.map((entry) => clean(entry, depth + 1));
    if (typeof input !== "object" || input === undefined) return "";
    return Object.fromEntries(
      Object.entries(input).flatMap(([key, entry]) => {
        if (/reasoning|thought|analysis/i.test(key)) return [];
        return [
          [
            text(key),
            /api.?key|password|secret|token|authorization|cookie|credential|private.?key/i.test(key)
              ? "[redacted]"
              : clean(entry, depth + 1),
          ],
        ];
      }),
    );
  }
  if (typeof value === "string" && /^[\s]*[[{]/.test(value)) {
    try {
      value = JSON.parse(value);
    } catch {}
  }
  const cleaned = clean(value, 0);
  return typeof cleaned === "string" ? cleaned : JSON.stringify(cleaned);
}
