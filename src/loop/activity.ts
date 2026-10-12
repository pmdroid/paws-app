import type { SessionUpdate } from "@agentclientprotocol/sdk";
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

const ACTIVITY_LIMIT = 3_500;
type AcpActivity = Omit<ProgressUpdate, "sessionId">;
type ToolUpdate = Extract<SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>;
type ToolActivity = {
  title: string;
  kind?: string;
  parameter: string;
  result: string;
  terminalOutput: string;
  status?: string;
};

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

export function createAcpActivityReporter(
  post: (activity: AcpActivity) => void,
  onPlan?: (steps: readonly SessionPlanStep[]) => void,
): {
  onEvent(event: AcpEvent): void;
  flush(): void;
  resultBody(): string;
} {
  let pending = "";
  let resultBody = "";
  const tools = new Map<string, ToolActivity>();

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
        if (update.sessionUpdate === "plan") {
          onPlan?.(
            update.entries.map((entry) => ({
              content: entry.content,
              status: entry.status === "in_progress" ? "inProgress" : entry.status,
            })),
          );
        }
        if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
          const tool = updateTool(update, tools.get(update.toolCallId));
          if (tool.status === "completed" || tool.status === "failed")
            tools.delete(update.toolCallId);
          else {
            tools.set(update.toolCallId, tool);
            if (tools.size > 100) tools.delete(tools.keys().next().value!);
          }
          const activity = toolActivity(tool);
          if (activity) {
            flush();
            post(activity);
          }
          return;
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
    case "tool_call_update":
      return toolActivity(updateTool(update));
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

function clip(kind: ActivityKind, body: string): AcpActivity | null {
  const clipped = clipActivity(body);
  if (clipped === "") return null;
  return { kind, body: clipped };
}

function updateTool(update: ToolUpdate, previous?: ToolActivity): ToolActivity {
  const tool: ToolActivity = {
    title: previous?.title ?? "",
    kind: previous?.kind,
    parameter: previous?.parameter ?? "",
    result: previous?.result ?? "",
    terminalOutput: previous?.terminalOutput ?? "",
    status: previous?.status,
  };
  if (update.title?.trim()) tool.title = publicToolText(update.title);
  if (update.kind) tool.kind = update.kind;
  if (update.status) tool.status = update.status;
  if (update.rawInput !== undefined && update.rawInput !== null)
    tool.parameter = publicToolText(update.rawInput);
  else if (!tool.parameter && update.locations?.length)
    tool.parameter = publicToolText(update.locations.map((location) => location.path));
  if (update.rawOutput !== undefined && update.rawOutput !== null)
    tool.result = publicToolText(update.rawOutput);
  else if (update.content)
    tool.result = publicToolText(
      update.content
        .flatMap((entry) =>
          entry.type === "content" && entry.content.type === "text" ? [entry.content.text] : [],
        )
        .join("\n"),
    );
  for (const key of ["terminal_output", "terminal_output_delta"]) {
    const data = terminalText(update["_meta"]?.[key]);
    if (data !== null) tool.terminalOutput = (tool.terminalOutput + data).slice(0, 64 * 1024);
  }
  if ((tool.status === "completed" || tool.status === "failed") && tool.terminalOutput)
    tool.result = publicToolText(tool.terminalOutput);
  return tool;
}

function terminalText(value: unknown): string | null {
  return value !== null &&
    typeof value === "object" &&
    "data" in value &&
    typeof value.data === "string"
    ? value.data
    : null;
}

function toolActivity(tool: ToolActivity): AcpActivity | null {
  if (!tool.title || tool.kind === "think" || tool.kind === "switch_mode") return null;
  const terminal = tool.status === "completed" || tool.status === "failed";
  return {
    kind: "action",
    body: tool.title,
    action: {
      action: tool.title,
      parameter: tool.parameter,
      ...(tool.result || terminal ? { result: tool.result || tool.status! } : {}),
    },
    ...(terminal ? {} : { ephemeral: true }),
  };
}

function publicToolText(value: unknown): string {
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
        /\b([\w-]*(?:api[_-]?key|password|secret|token|authorization|cookie)[\w-]*\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
        "$1[redacted]",
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
    if (typeof input === "string") return clipActivity(text(input));
    if (input === null || typeof input === "number" || typeof input === "boolean") return input;
    if (depth >= 4) return "[truncated]";
    if (Array.isArray(input)) return input.slice(0, 20).map((entry) => clean(entry, depth + 1));
    if (typeof input !== "object" || input === undefined) return "";
    return Object.fromEntries(
      Object.entries(input)
        .slice(0, 20)
        .flatMap(([key, entry]) => {
          if (/reasoning|thought|analysis/i.test(key)) return [];
          return [
            [
              text(key),
              /api.?key|password|secret|token|authorization|cookie|credential|private.?key/i.test(
                key,
              )
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
  return clipActivity(typeof cleaned === "string" ? cleaned : JSON.stringify(cleaned));
}
