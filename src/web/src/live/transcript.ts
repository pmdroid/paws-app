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
  return [...transcriptEntries(home, runId, fallbackAt, env, false)].slice(-200);
}

export function* fullAgentTranscript(
  home: string | undefined,
  runId: string,
  fallbackAt: string,
  env: NodeJS.ProcessEnv,
): Generator<StatusActivity> {
  yield* transcriptEntries(home, runId, fallbackAt, env, true);
}

function* transcriptEntries(
  home: string | undefined,
  runId: string,
  fallbackAt: string,
  env: NodeJS.ProcessEnv,
  full: boolean,
): Generator<StatusActivity> {
  if (!home || !/^[A-Za-z0-9_-]+$/.test(runId)) return;
  yield* readFile(home, `${runId}-classify`, fallbackAt, env, full);
  yield* readFile(home, runId, fallbackAt, env, full);
}

function* readFile(
  home: string,
  runId: string,
  fallbackAt: string,
  env: NodeJS.ProcessEnv,
  full: boolean,
): Generator<StatusActivity> {
  let fd: number | undefined;
  try {
    const root = realpathSync(join(home, "runs"));
    const directory = realpathSync(join(root, runId));
    if (!directory.startsWith(`${root}${sep}`) || directory !== join(root, runId)) return;
    fd = openSync(
      join(directory, "acp.jsonl"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 16_777_216) return;
    const start = full ? 0 : Math.max(0, info.size - 131_072);
    const bytes = Buffer.alloc(info.size - start);
    const size = readSync(fd, bytes, 0, bytes.length, start);
    const source = bytes.subarray(0, size).toString("utf8");
    const lines = source.split("\n");
    if (start) lines.shift();
    let pending: StatusActivity | undefined;
    let message = false;
    let messageBoundary = start === 0;
    const terminal = new Map<string, { at: string; title: string; text: string }>();
    const tools = new Map<string, { title?: string; kind?: string }>();
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
        let chunk = false;
        if (event?.type === "progress") {
          text = event.text;
          if (typeof text === "string" && text.startsWith("Tool: ")) kind = "tool";
          else chunk = true;
        } else if (event?.type === "session_update") {
          const update = event.update;
          if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
            text = update.content.text;
            chunk = true;
          } else if (["tool_call", "tool_call_update"].includes(update?.sessionUpdate)) {
            const previous = tools.get(update.toolCallId);
            const tool = {
              title: update.title ?? previous?.title,
              kind: update.kind ?? previous?.kind,
            };
            if (typeof update.toolCallId === "string") tools.set(update.toolCallId, tool);
            if (
              tool.kind === "think" ||
              tool.kind === "switch_mode" ||
              (update.sessionUpdate === "tool_call_update" && !previous && !update.kind)
            )
              continue;
            kind = "tool";
            text = [tool.title, update.status]
              .filter((value) => typeof value === "string")
              .join(" · ");
            if (update.rawInput !== undefined) text += `\nInput: ${toolValue(update.rawInput)}`;
            if (update.rawOutput !== undefined) text += `\n${toolValue(update.rawOutput)}`;
            else
              for (const part of update.content ?? [])
                if (part.type === "content" && part.content?.type === "text")
                  text += `\n${part.content.text}`;
            for (const key of ["terminal_output", "terminal_output_delta"])
              if (typeof update["_meta"]?.[key]?.data === "string")
                terminal.set(update.toolCallId, {
                  at,
                  title: tool.title ?? "Tool output",
                  text: (terminal.get(update.toolCallId)?.text ?? "") + update["_meta"][key].data,
                });
            if (
              ["completed", "failed"].includes(update.status) &&
              terminal.has(update.toolCallId)
            ) {
              text += `\n${terminal.get(update.toolCallId)!.text}`;
              terminal.delete(update.toolCallId);
            }
          }
        } else if (event?.type === "ask_team") {
          kind = "elicitation";
          text = event.question;
        } else if (event?.type === "error") {
          kind = "err";
          text = event.message;
        } else if (event?.type === "prompt_complete")
          text = `Agent turn ended: ${event.stopReason}`;
        if (typeof text !== "string" || !text.length || (!chunk && !text.trim())) continue;
        if (chunk && !messageBoundary) continue;
        if (!chunk) messageBoundary = true;
        const entryText = text;
        if (chunk && message && pending) pending.text += entryText;
        else {
          if (pending)
            yield {
              ...pending,
              text: redactTranscriptText(pending.text, env).slice(full ? 0 : -65_536),
            };
          pending = { at, kind, text: entryText };
        }
        message = chunk;
      } catch {}
    }
    if (pending)
      yield { ...pending, text: redactTranscriptText(pending.text, env).slice(full ? 0 : -65_536) };
    for (const output of terminal.values())
      yield {
        at: output.at,
        kind: "tool",
        text: redactTranscriptText(`${output.title}\n${output.text}`, env).slice(
          full ? 0 : -65_536,
        ),
      };
  } catch {
    return;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function toolValue(value: unknown): string {
  if (typeof value === "string") return value;
  return (
    JSON.stringify(value, (key, entry) =>
      /reasoning|thought|analysis/i.test(key)
        ? undefined
        : /api.?key|password|secret|token|authorization|cookie|credential|private.?key/i.test(key)
          ? "[redacted]"
          : entry,
    ) ?? ""
  );
}

function redactTranscriptText(text: string, env: NodeJS.ProcessEnv): string {
  return redactCloseoutText(text, env)
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
      "[redacted]",
    )
    .replace(/\b(Bearer|Basic)\s+[^\s"'<>]+/gi, "$1 [redacted]")
    .replace(
      /\b([\w-]*(?:api[_-]?key|password|secret|token|authorization|cookie)[\w-]*["']?\s*[:=]\s*)(\[redacted\]|"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,
      (_match, prefix: string, value: string) =>
        `${prefix}${value.startsWith('"') ? '"[redacted]"' : value.startsWith("'") ? "'[redacted]'" : "[redacted]"}`,
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
