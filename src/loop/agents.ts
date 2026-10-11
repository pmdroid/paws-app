import type { AgentRole } from "../acp";
import { git, runAgent } from "../acp";
import type { Finding, FixRequest, FixResult, FixRunner, ReviewResult } from "../closeout";
import type { CodexReviewer } from "../closeout";
import { FINDING_FORMAT, parseFindings as parseReviewFindings } from "../closeout";

export type AgentPurpose = "implement" | "fix" | "review";

export type AgentLaunch = (input: {
  role: AgentRole;
  purpose: AgentPurpose;
  itemId: string;
  worktree: string;
  prompt: string;
}) => { command?: string; args?: string[]; env?: NodeJS.ProcessEnv };

export type AcpAgentDeps = {
  pawsRoot: string;
  home?: string;
  launch: AgentLaunch;
  brief?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  docker?: { proxyUrl: string; image?: string; bin?: string };
};

const REVIEWER_MODEL = "codex";
const REVIEWER_PROVIDER = "openai";

export function implementPrompt(input: {
  identifier: string;
  title: string;
  handoff?: string;
  brief?: string;
}): string {
  const brief = [
    `Implement ${input.identifier}: ${input.title}.`,
    ...(input.brief ? [input.brief] : []),
    "Work only in this repository.",
    "When you need a product decision, call ask_team with select options when there is a closed set of choices.",
    "Commit is handled for you when you finish; leave the worktree in a reviewable state.",
  ].join("\n");
  if (input.handoff === undefined || input.handoff.trim() === "") return brief;
  return `${input.handoff.trim()}\n\n${brief}`;
}

export function createAcpCodexReviewer(deps: AcpAgentDeps): CodexReviewer {
  let seq = 0;
  return {
    async review(request): Promise<ReviewResult> {
      seq += 1;
      const prompt = [
        ...(deps.brief ? [deps.brief] : []),
        "Review the change.",
        `Task ${request.taskId}, item ${request.itemId}.`,
        `Base ${request.base}, head ${request.head}.`,
        FINDING_FORMAT,
      ].join("\n");
      let text = "";
      const launch = deps.launch({
        role: "reviewer",
        purpose: "review",
        itemId: request.taskId,
        worktree: request.worktree,
        prompt,
      });
      const result = await runAgent({
        role: "reviewer",
        itemId: request.taskId,
        runId: `rev-${request.taskId}-${seq}`,
        prompt,
        worktreePath: request.worktree,
        pawsRoot: deps.pawsRoot,
        checkpoint: false,
        ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
        ...(deps.home ? { home: deps.home } : {}),
        ...(deps.signal ? { signal: deps.signal } : {}),
        ...spawnOf(launch),
        ...dockerOf(deps, "codex"),
        onEvent(event) {
          if (event.type !== "session_update") return;
          if (event.update.sessionUpdate !== "agent_message_chunk") return;
          if (event.update.content.type === "text") text += event.update.content.text ?? "";
        },
      });
      if (result.authRequired) {
        throw new Error(result.errorMessage ?? "Codex login is missing");
      }
      if (
        result.cancelled ||
        result.timedOut ||
        result.errorMessage !== undefined ||
        result.stopReason !== "end_turn"
      ) {
        throw new Error(result.errorMessage ?? `Review did not complete: ${result.stopReason}`);
      }
      return {
        session: result.sessionId ?? `codex-${request.taskId}-${seq}`,
        model: REVIEWER_MODEL,
        provider: REVIEWER_PROVIDER,
        findings: parseFindings(text),
      };
    },
  };
}

export function createAcpFixRunner(deps: AcpAgentDeps): FixRunner {
  return {
    async applyFix(request): Promise<FixResult> {
      const prompt = fixPrompt(request, deps.brief);
      const launch = deps.launch({
        role: "implementer",
        purpose: "fix",
        itemId: request.taskId,
        worktree: request.worktree,
        prompt,
      });
      const result = await runAgent({
        role: "implementer",
        itemId: request.taskId,
        runId: `fix-${request.taskId}-${request.fixAttempt}`,
        prompt,
        worktreePath: request.worktree,
        pawsRoot: deps.pawsRoot,
        ...(deps.home ? { home: deps.home } : {}),
        ...(deps.signal ? { signal: deps.signal } : {}),
        ...spawnOf(launch),
        ...dockerOf(deps, "claude"),
      });
      if (result.cancelled) return { ok: false, reason: "fix cancelled" };
      if (result.authRequired || result.stopReason === "error" || result.stopReason === "timeout") {
        return { ok: false, reason: result.errorMessage ?? result.stopReason };
      }
      const head = (await git(["-C", request.worktree, "rev-parse", "HEAD"])).trim();
      if (head === "" || head === request.head) {
        return { ok: false, reason: "fix did not move HEAD to a new commit" };
      }
      return { ok: true, head };
    },
  };
}

export function fixPrompt(request: FixRequest, brief?: string): string {
  return [
    "Fix Closeout findings.",
    ...(brief ? [brief] : []),
    `This is fix attempt ${request.fixAttempt} of ${request.maxFixAttempts}.`,
    request.summary,
  ].join("\n\n");
}

export function parseFindings(text: string): Finding[] {
  const parsed = parseReviewFindings(text);
  if (!parsed.ok) throw new Error(`Invalid review findings: ${parsed.reason}`);
  return parsed.findings;
}

function dockerOf(
  deps: AcpAgentDeps,
  agent: "claude" | "codex",
):
  | { docker: { agent: "claude" | "codex"; proxyUrl: string; image?: string; bin?: string } }
  | Record<string, never> {
  const docker = deps.docker;
  if (docker === undefined) return {};
  return {
    docker: {
      agent,
      proxyUrl: docker.proxyUrl,
      ...(docker.image ? { image: docker.image } : {}),
      ...(docker.bin ? { bin: docker.bin } : {}),
    },
  };
}

function spawnOf(launch: ReturnType<AgentLaunch>): {
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
} {
  return {
    ...(launch.command ? { command: launch.command, args: launch.args ?? [] } : {}),
    ...(launch.env ? { env: launch.env } : {}),
  };
}
