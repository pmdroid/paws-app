import type { AgentProfile } from "../config";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { AgentRole } from "./adapters";
import type { AskTeamHook } from "./ask-team";
import { runAgent } from "./run";
import type { AcpRunner, AcpUpdate, AcpUpdateKind } from "./runner";
import type { AcpEvent } from "./types";

export type AcpRunnerOptions = {
  profile?: AgentProfile;
  role?: AgentRole;
  pawsRoot?: string;
  home?: string;
  timeoutMs?: number;
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  askTeam?: AskTeamHook;
};

/**
 * Real `AcpRunner`. `start` runs the prompt to completion and streams updates
 * while it is in flight, so `cancel` can abort from an `onUpdate` callback.
 */
export function createAcpRunner(defaults: AcpRunnerOptions = {}): AcpRunner {
  const sessions = new Map<string, AbortController>();
  return {
    async start(input) {
      const controller = new AbortController();
      const parent = input.signal;
      if (parent?.aborted) controller.abort(parent.reason);
      else parent?.addEventListener("abort", () => controller.abort(parent.reason), { once: true });

      const worktree = resolve(input.worktree);
      const pawsRoot = input.pawsRoot ?? defaults.pawsRoot ?? dirname(dirname(worktree));
      let sessionId = "";
      try {
        const result = await runAgent({
          role: input.role ?? defaults.role ?? "implementer",
          profile: input.profile ?? defaults.profile,
          itemId: input.itemId,
          runId: input.runId ?? input.itemId,
          prompt: input.prompt,
          worktreePath: worktree,
          pawsRoot,
          home: input.home ?? defaults.home ?? homedir(),
          ...(input.command || defaults.command
            ? {
                command: input.command ?? defaults.command,
                args: input.args ?? defaults.args ?? [],
              }
            : {}),
          env: input.env ?? defaults.env,
          timeoutMs: input.timeoutMs ?? defaults.timeoutMs,
          signal: controller.signal,
          askTeam: input.askTeam ?? defaults.askTeam,
          onEvent: async (event) => {
            if (event.type === "session_started") {
              sessionId = event.sessionId;
              sessions.set(sessionId, controller);
            }
            const update = toUpdate(event, sessionId);
            if (update) input.onUpdate?.(update);
            await input.onEvent?.(event);
          },
        });
        return { sessionId: result.sessionId ?? sessionId };
      } finally {
        if (sessionId) sessions.delete(sessionId);
      }
    },
    async cancel(sessionId) {
      const controller = sessions.get(sessionId);
      controller?.abort();
    },
  };
}

function toUpdate(event: AcpEvent, sessionId: string): AcpUpdate | undefined {
  switch (event.type) {
    case "session_update":
      return fromSessionUpdate(event.sessionId, event.update);
    case "prompt_complete":
      return sessionId ? { sessionId, kind: "message", summary: event.stopReason } : undefined;
    case "error":
      return { sessionId, kind: "error", summary: event.message };
    case "permission":
      return {
        sessionId,
        kind: "tool_call",
        summary: event.title?.trim() || event.reason,
      };
    case "ask_team":
      return {
        sessionId,
        kind: "message",
        summary:
          event.phase === "answered"
            ? `ask_team: ${event.answer ?? ""}`
            : `ask_team: ${event.question}`,
      };
    case "cancelled":
      return sessionId ? { sessionId, kind: "error", summary: event.reason } : undefined;
    default:
      return undefined;
  }
}

function fromSessionUpdate(sessionId: string, update: SessionUpdate): AcpUpdate {
  return {
    sessionId,
    kind: kindFor(update.sessionUpdate),
    summary: summaryFor(update),
  };
}

function kindFor(sessionUpdate: SessionUpdate["sessionUpdate"]): AcpUpdateKind {
  switch (sessionUpdate) {
    case "tool_call":
    case "tool_call_update":
      return "tool_call";
    case "plan":
    case "plan_update":
    case "plan_removed":
      return "plan";
    case "usage_update":
      return "usage";
    default:
      return "message";
  }
}

function summaryFor(update: SessionUpdate): string {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_thought_chunk":
    case "user_message_chunk":
      return textOf(update.content) || update.sessionUpdate;
    case "tool_call":
    case "tool_call_update":
      return update.title?.trim() || update.toolCallId;
    case "plan":
      return (
        update.entries
          .map((entry) => entry.content)
          .filter(Boolean)
          .join("; ") || "plan"
      );
    case "usage_update":
      return usageSummary(update);
    default:
      return update.sessionUpdate;
  }
}

function textOf(content: { type: string; text?: string }): string {
  return content.type === "text" ? (content.text ?? "").trim() : "";
}

function usageSummary(update: Extract<SessionUpdate, { sessionUpdate: "usage_update" }>): string {
  const parts: string[] = [];
  if (update.used !== undefined) parts.push(`used ${update.used}`);
  if (update.size !== undefined) parts.push(`size ${update.size}`);
  const cost = update.cost;
  if (cost?.amount !== undefined) parts.push(`cost ${cost.amount}`);
  return parts.join(", ") || "usage";
}
