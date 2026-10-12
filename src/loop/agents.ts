import type {
  AgentRole,
  AgentIdentity,
  PublishArtifactHook,
  RunAgentOptions,
  RunAgentResult,
} from "../acp";
import type { AgentProfile } from "../config";
import { git, runAgent } from "../acp";
import type { Finding, FixRequest, FixResult, FixRunner, ReviewResult } from "../closeout";
import type { CodexReviewer } from "../closeout";
import { FINDING_FORMAT, parseFindings as parseReviewFindings } from "../closeout";

export type AgentPurpose =
  | "implement"
  | "fix"
  | "review"
  | "prepare"
  | "classify"
  | "answer"
  | "artifact"
  | "select_repository";

export type AgentLaunch = (input: {
  role: AgentRole;
  profile?: AgentProfile;
  purpose: AgentPurpose;
  itemId: string;
  worktree: string;
  prompt: string;
}) => { command?: string; args?: string[]; env?: NodeJS.ProcessEnv };

export type AcpAgentDeps = {
  pawsRoot: string;
  publishArtifact?: PublishArtifactHook;
  prepareInputFiles?: RunAgentOptions["prepareInputFiles"];
  profiles?: { implementer: AgentProfile; reviewer: AgentProfile };
  onCandidate?: (identity: AgentIdentity) => void;
  home?: string;
  launch: AgentLaunch;
  brief?: string;
  signal?: AbortSignal;
  onCleanupFailure?: () => void;
  promptRunner?: (options: RunAgentOptions) => Promise<RunAgentResult>;
  timeoutMs?: number;
  docker?: { proxyUrl: string; image?: string; bin?: string };
};

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
        request.prompt ?? "Review the change.",
        `Task ${request.taskId}, item ${request.itemId}.`,
        `Base ${request.base}, head ${request.head}.`,
        FINDING_FORMAT,
      ].join("\n");
      let text = "";
      const launch = deps.launch({
        role: "reviewer",
        profile: deps.profiles?.reviewer,
        purpose: "review",
        itemId: request.taskId,
        worktree: request.worktree,
        prompt,
      });
      const result = await runAgent({
        prepareInputFiles: deps.prepareInputFiles,
        role: "reviewer",
        profile: deps.profiles?.reviewer,
        itemId: request.taskId,
        runId: `rev-${request.taskId}-${seq}`,
        prompt,
        worktreePath: request.worktree,
        pawsRoot: deps.pawsRoot,
        checkpoint: false,
        readOnly: true,
        ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
        ...(deps.home ? { home: deps.home } : {}),
        ...(deps.signal ? { signal: deps.signal } : {}),
        ...spawnOf(launch),
        ...dockerOf(deps, deps.profiles?.reviewer.agent ?? "codex"),
        onEvent(event) {
          if (event.type !== "session_update") return;
          if (event.update.sessionUpdate !== "agent_message_chunk") return;
          if (event.update.content.type === "text") text += event.update.content.text ?? "";
        },
      });
      if (!result.agentExited) deps.onCleanupFailure?.();
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
      if (!result.identity) throw new Error("Reviewer did not report a concrete session model");
      return {
        ...result.identity,
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
        profile: deps.profiles?.implementer,
        purpose: "fix",
        itemId: request.taskId,
        worktree: request.worktree,
        prompt,
      });
      const result = await (deps.promptRunner ?? runAgent)({
        prepareInputFiles: deps.prepareInputFiles,
        role: "implementer",
        publishArtifact: deps.publishArtifact,
        profile: deps.profiles?.implementer,
        itemId: request.taskId,
        runId: `fix-${request.taskId}-${request.fixAttempt}`,
        prompt,
        worktreePath: request.worktree,
        pawsRoot: deps.pawsRoot,
        ...(deps.home ? { home: deps.home } : {}),
        ...(deps.signal ? { signal: deps.signal } : {}),
        ...spawnOf(launch),
        ...dockerOf(deps, deps.profiles?.implementer.agent ?? "claude"),
      });
      if (!result.agentExited) deps.onCleanupFailure?.();
      if (result.cancelled) return { ok: false, reason: "fix cancelled" };
      if (result.authRequired || result.stopReason === "error" || result.stopReason === "timeout") {
        return { ok: false, reason: result.errorMessage ?? result.stopReason };
      }
      if (!result.identity)
        return { ok: false, reason: "Fix agent did not report a concrete session model" };
      const head = (await git(["-C", request.worktree, "rev-parse", "HEAD"])).trim();
      if (head === "" || head === request.head) {
        return { ok: false, reason: "fix did not move HEAD to a new commit" };
      }
      deps.onCandidate?.(result.identity);
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
  agent: "claude" | "codex" | "grok",
):
  | { docker: { agent: "claude" | "codex"; proxyUrl: string; image?: string; bin?: string } }
  | Record<string, never> {
  const docker = deps.docker;
  if (docker === undefined) return {};
  if (agent === "grok") throw new Error("Grok does not support the configured Docker sandbox");
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
