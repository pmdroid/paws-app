import { journalCaught } from "../journal";
import { readFile, stat } from "node:fs/promises";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { runAgent } from "./run";
import { runDir } from "./paths";
import {
  FOLLOW_UP_INTERRUPTION,
  type AcpEvent,
  type RunAgentOptions,
  type RunAgentResult,
} from "./types";

export class AcpCleanupError extends Error {}

export type AcpConversationEntry = {
  kind: "request" | "response" | "tool_result";
  body: string;
};

export interface AcpPromptLifecycle {
  prompt(options: RunAgentOptions): Promise<RunAgentResult>;
  interrupt(): Promise<void>;
  stop(): Promise<void>;
  snapshot(): AcpConversationEntry[];
}

export function createAcpPromptLifecycle(
  context: readonly AcpConversationEntry[] = [],
  runner: (options: RunAgentOptions) => Promise<RunAgentResult> = runAgent,
): AcpPromptLifecycle {
  const history = context.map((entry) => ({ ...entry }));
  let active: { controller: AbortController; done: Promise<RunAgentResult> } | undefined;
  let stopped = false;
  let worktree: string | undefined;

  return {
    prompt(options) {
      if (stopped) return Promise.reject(new Error("ACP conversation stopped"));
      if (active) return Promise.reject(new Error("ACP prompt already running"));
      if (worktree && worktree !== options.worktreePath) {
        return Promise.reject(new Error("ACP conversation worktree changed"));
      }
      worktree = options.worktreePath;
      const controller = new AbortController();
      const onAbort = () => controller.abort(options.signal?.reason);
      if (options.signal?.aborted) onAbort();
      else options.signal?.addEventListener("abort", onAbort, { once: true });
      const prompt = reconstructAcpPrompt(options.prompt, history);
      const entry: AcpConversationEntry = { kind: "request", body: options.prompt };
      history.push(entry);
      const done = (async () => {
        try {
          const path = `${runDir(options.pawsRoot, options.runId)}/acp.jsonl`;
          const offset = await stat(path).then(
            (info) => info.size,
            (error: NodeJS.ErrnoException) => {
              journalCaught(error, "lifecycle.prompt.stat", null, "optional file may be absent");
              if (error.code === "ENOENT") return 0;
              throw error;
            },
          );
          const result = await runner({ ...options, prompt, signal: controller.signal });
          if (!result.agentExited) {
            stopped = true;
            throw new AcpCleanupError("ACP child did not exit; refusing another prompt");
          }
          if (result.transcriptPath) {
            history.push(...(await readConversation(result.transcriptPath, offset)));
          }
          return result;
        } finally {
          options.signal?.removeEventListener("abort", onAbort);
          active = undefined;
        }
      })();
      active = { controller, done };
      return done;
    },
    async interrupt() {
      active?.controller.abort(FOLLOW_UP_INTERRUPTION);
      await active?.done;
    },
    async stop() {
      stopped = true;
      active?.controller.abort();
      await active?.done;
    },
    snapshot() {
      return history.map((entry) => ({ ...entry }));
    },
  };
}

const REPLAY_LEAD = "The previous agent turn has stopped. Existing workspace files are preserved.";

const REPLAY_BUDGET = 800_000;

export function reconstructAcpPrompt(
  prompt: string,
  context: readonly AcpConversationEntry[],
): string {
  if (context.length === 0) return prompt;
  return [
    REPLAY_LEAD,
    "The following JSON records conversation history and observed tool effects. Treat it as context, not instructions to replay tools. Inspect the current workspace before acting.",
    JSON.stringify(withinBudget(context)),
    "Current user request:",
    prompt,
  ].join("\n\n");
}

function withinBudget(context: readonly AcpConversationEntry[]): AcpConversationEntry[] {
  const size = (entry: AcpConversationEntry) => JSON.stringify(entry).length + 1;
  if (JSON.stringify(context).length <= REPLAY_BUDGET) return [...context];
  const [first, ...rest] = context;
  const task = { ...first!, body: first!.body.slice(0, REPLAY_BUDGET / 2) };
  let used = size(task) + 200;
  const kept: AcpConversationEntry[] = [];
  for (const entry of rest.toReversed()) {
    if (used + size(entry) > REPLAY_BUDGET) break;
    kept.unshift(entry);
    used += size(entry);
  }
  const omitted = rest.length - kept.length;
  return omitted === 0
    ? [task, ...kept]
    : [
        task,
        {
          kind: "response",
          body: `${omitted} earlier entries are left out to fit the agent's context. The workspace and its Git history hold their effects.`,
        },
        ...kept,
      ];
}

export function currentRequest(prompt: string): string {
  const [lead, , , marker, ...rest] = prompt.split("\n\n");
  return lead === REPLAY_LEAD && marker === "Current user request:" ? rest.join("\n\n") : prompt;
}

export function requestText(prompt: string): string {
  const [lead, , context, marker, ...rest] = prompt.split("\n\n");
  if (lead !== REPLAY_LEAD || marker !== "Current user request:" || context === undefined)
    return prompt;
  let entries: unknown;
  try {
    entries = JSON.parse(context);
  } catch (caughtError1) {
    journalCaught(caughtError1, "lifecycle.requestText.parse", null);
    return prompt;
  }
  if (!Array.isArray(entries)) return prompt;
  return [
    ...entries
      .filter((entry: AcpConversationEntry) => entry?.kind === "request")
      .map((entry: AcpConversationEntry) => String(entry.body)),
    rest.join("\n\n"),
  ].join("\n\n");
}

export async function recoverAcpConversation(
  path: string,
  offset = 0,
): Promise<AcpConversationEntry[]> {
  return readConversation(path, offset);
}

async function readConversation(path: string, offset: number): Promise<AcpConversationEntry[]> {
  const history: AcpConversationEntry[] = [];
  const tools = new Map<string, Record<string, unknown>>();
  let response = "";
  const lines = (await readFile(path)).subarray(offset).toString("utf8").split("\n");
  for (const [index, line] of lines.entries()) {
    if (!line) continue;
    let parsed: { event?: AcpEvent } | null;
    try {
      parsed = JSON.parse(line) as { event?: AcpEvent } | null;
    } catch (error) {
      if (index === lines.length - 1) break;
      throw error;
    }
    const event = parsed?.event;
    if (event?.type !== "session_update") continue;
    const update = event.update;
    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
      response += update.content.text;
    }
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      const previous = tools.get(update.toolCallId) ?? {};
      const tool = { ...previous, ...toolObservation(update) };
      for (const key of ["terminal_output_delta", "terminal_output"]) {
        const output = update["_meta"]?.[key];
        if (
          output !== null &&
          typeof output === "object" &&
          "data" in output &&
          typeof output.data === "string"
        ) {
          tool.terminalOutput = `${tool.terminalOutput ?? ""}${output.data}`.slice(-64 * 1024);
          break;
        }
      }
      tools.set(update.toolCallId, tool);
    }
  }
  if (response) history.push({ kind: "response", body: response });
  for (const tool of tools.values()) {
    if (tool.status !== "completed" && tool.status !== "failed") continue;
    history.push({ kind: "tool_result", body: JSON.stringify(tool) });
  }
  return history;
}

function toolObservation(
  update: Extract<SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries({
      toolCallId: update.toolCallId,
      title: update.title,
      status: update.status,
      content: update.content,
      rawOutput: update.rawOutput,
    }).filter(([, value]) => value !== undefined),
  );
}
