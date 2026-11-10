import { open, stat } from "node:fs/promises";
import { journalCaught } from "../journal";

export const PULL_REQUEST_SUMMARY_LIMIT = 1_500;

type ToolGroup = "read" | "search" | "execute" | "edit" | "mcp" | "web";

const PHRASES: ReadonlyArray<[ToolGroup, (count: number) => string]> = [
  ["read", (n) => `read ${n} ${n === 1 ? "file" : "files"}`],
  ["search", (n) => `searched ${n} ${n === 1 ? "time" : "times"}`],
  ["execute", (n) => `ran ${n} ${n === 1 ? "command" : "commands"}`],
  ["edit", (n) => `edited ${n} ${n === 1 ? "file" : "files"}`],
  ["mcp", (n) => `used ${n} MCP ${n === 1 ? "tool" : "tools"}`],
  ["web", (n) => `searched the web ${n} ${n === 1 ? "time" : "times"}`],
];

type ToolCall = { toolCallId?: unknown; kind?: unknown; title?: unknown; _meta?: unknown };

function toolGroup(call: ToolCall): ToolGroup | null {
  const meta = call["_meta"] as { claudeCode?: { toolName?: unknown } } | undefined;
  const name = typeof meta?.claudeCode?.toolName === "string" ? meta.claudeCode.toolName : "";
  const title = typeof call.title === "string" ? call.title : "";
  if (name.startsWith("mcp__") || title.startsWith("mcp__")) return "mcp";
  switch (call.kind) {
    case "read":
      return "read";
    case "search":
      return "search";
    case "execute":
      return "execute";
    case "edit":
    case "delete":
    case "move":
      return "edit";
    case "fetch":
      return "web";
    default:
      return null;
  }
}

export function turnSummaryLine(transcript: string): string | null {
  const counts = new Map<ToolGroup, number>();
  const seen = new Set<unknown>();
  let first: number | undefined;
  let last: number | undefined;
  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;
    let record: { t?: unknown; event?: { type?: unknown; update?: unknown } };
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      continue;
    }
    const at = typeof record.t === "string" ? Date.parse(record.t) : NaN;
    if (Number.isFinite(at)) {
      first ??= at;
      last = at;
    }
    const update = record.event?.type === "session_update" ? record.event.update : undefined;
    const call = update as (ToolCall & { sessionUpdate?: unknown }) | undefined;
    if (call?.sessionUpdate !== "tool_call") continue;
    if (call.toolCallId !== undefined) {
      if (seen.has(call.toolCallId)) continue;
      seen.add(call.toolCallId);
    }
    const group = toolGroup(call);
    if (group) counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  if (first === undefined || last === undefined) return null;
  const tools = PHRASES.flatMap(([group, phrase]) => {
    const count = counts.get(group) ?? 0;
    return count > 0 ? [phrase(count)] : [];
  }).join(", ");
  const worked = `Worked for ${duration(last - first)}`;
  return tools ? `${worked} · ${tools.charAt(0).toUpperCase()}${tools.slice(1)}.` : `${worked}.`;
}

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const hourText = `${hours} ${hours === 1 ? "hour" : "hours"}`;
  return rest === 0 ? hourText : `${hourText} ${rest} ${rest === 1 ? "minute" : "minutes"}`;
}

export async function transcriptOffset(path: string): Promise<number> {
  return stat(path).then(
    (info) => info.size,
    () => 0,
  );
}

export async function readTurnSummary(
  path: string,
  offset: number,
  itemId: string,
  journal?: (line: string) => void,
): Promise<string | null> {
  try {
    const file = await open(path, "r");
    try {
      const size = (await file.stat()).size;
      const start = offset <= size ? offset : 0;
      const buffer = Buffer.alloc(size - start);
      await file.read(buffer, 0, buffer.length, start);
      return turnSummaryLine(buffer.toString("utf8"));
    } finally {
      await file.close();
    }
  } catch (error) {
    journalCaught(error, "turn-summary.readTurnSummary", itemId, "transcript unreadable", journal);
    return null;
  }
}

export function pullRequestSummary(message: string | undefined): string {
  const text = message?.trim() ?? "";
  if (text.length <= PULL_REQUEST_SUMMARY_LIMIT) return text;
  return `${text.slice(0, PULL_REQUEST_SUMMARY_LIMIT - 1).trimEnd()}…`;
}
