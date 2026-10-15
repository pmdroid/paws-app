import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import type { StatusActivity } from "../contract";
import { redactCloseoutText } from "../server/artifact";

export function readAgentTranscript(
  home: string | undefined,
  runId: string,
  fallbackAt: string,
  env: NodeJS.ProcessEnv,
): StatusActivity[] {
  if (!home || !/^[A-Za-z0-9_-]+$/.test(runId)) return [];
  return [
    readFile(home, `${runId}-classify`, fallbackAt, env),
    readFile(home, runId, fallbackAt, env),
  ]
    .flat()
    .slice(-200);
}

function readFile(
  home: string,
  runId: string,
  fallbackAt: string,
  env: NodeJS.ProcessEnv,
): StatusActivity[] {
  let fd: number | undefined;
  try {
    const root = realpathSync(join(home, "runs"));
    const directory = realpathSync(join(root, runId));
    if (!directory.startsWith(`${root}${sep}`)) return [];
    fd = openSync(
      join(directory, "acp.jsonl"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 16_777_216) return [];
    const start = Math.max(0, info.size - 131_072);
    const bytes = Buffer.alloc(info.size - start);
    const size = readSync(fd, bytes, 0, bytes.length, start);
    const source = bytes.subarray(0, size).toString("utf8");
    const lines = source.split("\n");
    if (start) lines.shift();
    const result: StatusActivity[] = [];
    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        const event = record.event;
        const at =
          typeof record.t === "string" && Number.isFinite(Date.parse(record.t))
            ? record.t
            : fallbackAt;
        let kind: StatusActivity["kind"] = "system";
        let text = "";
        if (event?.type === "progress") {
          text = event.text;
          if (typeof text === "string" && text.startsWith("Tool: ")) kind = "tool";
        } else if (event?.type === "session_update") {
          const update = event.update;
          if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text")
            text = update.content.text;
          else if (["tool_call", "tool_call_update"].includes(update?.sessionUpdate)) {
            kind = "tool";
            text = [update.title, update.status]
              .filter((value) => typeof value === "string")
              .join(" · ");
            for (const part of update.content ?? [])
              if (part.type === "content" && part.content?.type === "text")
                text += `\n${part.content.text}`;
          }
        } else if (event?.type === "ask_team") {
          kind = "elicitation";
          text = event.question;
        } else if (event?.type === "error") {
          kind = "err";
          text = event.message;
        } else if (event?.type === "prompt_complete")
          text = `Agent turn ended: ${event.stopReason}`;
        if (typeof text !== "string" || !text.trim()) continue;
        result.push({ at, kind, text: redactCloseoutText(text.slice(0, 8192), env) });
      } catch {}
    }
    return result.slice(-200);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
