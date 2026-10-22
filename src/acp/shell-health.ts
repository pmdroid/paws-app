import { stat } from "node:fs/promises";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { AuthCheckResult } from "./auth";
import { reconstructAcpPrompt, recoverAcpConversation } from "./lifecycle";
import { runDir } from "./paths";
import { runAgent } from "./run";
import {
  DEFAULT_RUN_TIMEOUT_MS,
  type AcpEvent,
  type RunAgentOptions,
  type RunAgentResult,
} from "./types";

/** Consecutive empty `execute` results with exit code -1 that mean the shell is broken. */
export const SHELL_BREAK_LIMIT = 3;

export const SHELL_RESTART_NOTICE =
  "The agent's shell stopped running commands, so Paws restarted the agent session.";

const SHELL_RESTART_PROMPT = `${SHELL_RESTART_NOTICE} The new session has a working shell. Check git status and the workspace, then continue where you left off.`;

const SHELL_QUESTION =
  "The agent's shell stopped running commands again, after Paws already restarted the agent session once. Reply with instructions to continue in a fresh session, or ask it to stop.";

const OUTPUT_KEYS = [
  "stdout",
  "stderr",
  "output",
  "output_for_prompt",
  "aggregated_output",
  "formatted_output",
] as const;

type ToolUpdate = Extract<SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>;

/**
 * How a finished `execute` tool call ended: `broken` for exit code -1 with
 * no output at all, `ran` for any other result with an exit code or output,
 * and `null` when the update does not report either.
 */
export function classifyExecuteResult(update: ToolUpdate): "broken" | "ran" | null {
  const raw = record(update.rawOutput);
  const meta = record(update["_meta"]);
  const exitCode =
    integer(raw?.["exit_code"]) ??
    integer(raw?.["exitCode"]) ??
    integer(record(raw?.["exitStatus"])?.["exitCode"]) ??
    integer(record(meta?.["terminal_exit"])?.["exit_code"]);
  const output = [
    ...OUTPUT_KEYS.map((key) => raw?.[key]),
    typeof update.rawOutput === "string" ? update.rawOutput : undefined,
    record(meta?.["terminal_output"])?.["data"],
  ].some((value) => typeof value === "string" && value.trim() !== "");
  if (exitCode === undefined) return output ? "ran" : null;
  return exitCode === -1 && !output ? "broken" : "ran";
}

/**
 * Counts consecutive broken `execute` results in one agent session. Other
 * tool kinds neither count nor reset the streak; a command that ran resets it.
 */
export function createShellBreakDetector(limit = SHELL_BREAK_LIMIT) {
  const kinds = new Map<string, string>();
  const decided = new Set<string>();
  let streak = 0;
  return {
    /** Returns true once the streak reaches the limit. */
    observe(event: AcpEvent): boolean {
      if (event.type !== "session_update") return false;
      const update = event.update;
      if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update")
        return false;
      if (update.kind) kinds.set(update.toolCallId, update.kind);
      if (kinds.get(update.toolCallId) !== "execute" || decided.has(update.toolCallId))
        return false;
      if (update.status !== "completed" && update.status !== "failed") return false;
      const outcome = classifyExecuteResult(update);
      if (outcome === null) return false;
      decided.add(update.toolCallId);
      streak = outcome === "broken" ? streak + 1 : 0;
      return streak >= limit;
    },
  };
}

export interface ShellBreak {
  /** 1 for the first break in this task, 2 for the next, and so on. */
  count: number;
  agent: string;
  agentName?: string;
  agentVersion?: string;
  model?: string;
  sessionId?: string;
}

export interface ShellRecoveryHooks {
  /** Tells the team why the session restarted. */
  notice(text: string): void | Promise<void>;
  /** Records each detection so a pattern for one agent shows up. */
  log(detection: ShellBreak): void;
}

/**
 * Runs the agent and ends its session once the shell stops running commands.
 * The first break continues in a fresh session on the same worktree from the
 * transcript. A later break asks the team before continuing again.
 */
export async function runWithShellRecovery(
  options: RunAgentOptions,
  hooks: ShellRecoveryHooks,
  runner: (options: RunAgentOptions) => Promise<RunAgentResult> = runAgent,
): Promise<RunAgentResult> {
  const transcript = `${runDir(options.pawsRoot, options.runId)}/acp.jsonl`;
  let deadline = performance.now() + (options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS);
  let prompt = options.prompt;
  let resume = options.resume;
  const offset = await stat(transcript).then(
    (info) => info.size,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return 0;
      throw error;
    },
  );
  for (let count = 1; ; count++) {
    const detector = createShellBreakDetector();
    const stop = new AbortController();
    let auth: AuthCheckResult | undefined;
    let broken = false;
    const result = await runner({
      ...options,
      prompt,
      resume,
      timeoutMs: Math.max(1, Math.floor(deadline - performance.now())),
      signal: options.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal,
      onEvent(event) {
        if (event.type === "auth_checked") auth = event.auth;
        if (!broken && detector.observe(event)) {
          broken = true;
          stop.abort();
        }
        return options.onEvent?.(event);
      },
    });
    if (!broken || options.signal?.aborted) return result;
    hooks.log({
      count,
      agent: options.profile?.agent ?? "unknown",
      ...(auth?.agentName ? { agentName: auth.agentName } : {}),
      ...(auth?.agentVersion ? { agentVersion: auth.agentVersion } : {}),
      ...(result.identity?.model ? { model: result.identity.model } : {}),
      ...(result.sessionId ? { sessionId: result.sessionId } : {}),
    });
    const stopped: RunAgentResult = {
      ...result,
      stopReason: "error",
      cancelled: false,
      errorMessage: "The agent's shell stopped running commands.",
    };
    if (!result.agentExited || performance.now() >= deadline) return stopped;
    let instructions = "";
    if (count === 1) await hooks.notice(SHELL_RESTART_NOTICE);
    else {
      if (!options.askTeam) return stopped;
      const waitingAt = performance.now();
      const answer = await options.askTeam.ask(
        { question: SHELL_QUESTION },
        {
          itemId: options.itemId,
          runId: options.runId,
          role: options.role,
          signal: options.signal ?? new AbortController().signal,
        },
      );
      options.signal?.throwIfAborted();
      deadline += performance.now() - waitingAt;
      instructions = answer.answer;
    }
    const history = await recoverAcpConversation(transcript, offset).catch(
      (failure: NodeJS.ErrnoException) => {
        if (failure.code === "ENOENT") return [];
        throw failure;
      },
    );
    prompt = reconstructAcpPrompt(
      instructions
        ? `${SHELL_RESTART_PROMPT}\n\nInstructions from the team:\n${instructions}`
        : SHELL_RESTART_PROMPT,
      [{ kind: "request", body: options.resume?.replayPrompt ?? options.prompt }, ...history],
    );
    resume = undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}
