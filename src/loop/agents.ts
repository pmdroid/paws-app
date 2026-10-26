import { journalCaught } from "../journal";
import type {
  AcpEvent,
  AgentRole,
  AgentIdentity,
  PublishArtifactHook,
  RunAgentOptions,
  RunAgentResult,
  PostUpdateHook,
  PullRequestHook,
  UpdatePlanHook,
} from "../acp";
import type { AgentProfile } from "../config";
import { git, runAgent } from "../acp";
import type { Finding, FixRequest, FixResult, FixRunner, ReviewResult } from "../closeout";
import type { CodexReviewer } from "../closeout";
import { evidenceOnly, FINDING_FORMAT, parseFindings as parseReviewFindings } from "../closeout";

export type AgentPurpose =
  | "implement"
  | "fix"
  | "review"
  | "prepare"
  | "classify"
  | "answer"
  | "artifact"
  | "plan"
  | "select_repository";

export type AgentLaunch = (input: {
  role: AgentRole;
  profile?: AgentProfile;
  purpose: AgentPurpose;
  itemId: string;
  worktree: string;
  prompt: string;
}) => {
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  // How long the command gets to exit after SIGTERM before SIGKILL.
  cancelGraceMs?: number;
};

export type AcpAgentDeps = {
  repository?: string;
  pawsRoot: string;
  publishArtifact?: PublishArtifactHook;
  prepareInputFiles?: RunAgentOptions["prepareInputFiles"];
  onEvent?: RunAgentOptions["onEvent"];
  updatePlan?: UpdatePlanHook;
  pullRequest?: PullRequestHook;
  postUpdate?: PostUpdateHook;
  profiles?: { implementer: AgentProfile; reviewer: AgentProfile };
  onCandidate?: (identity: AgentIdentity) => void;
  home?: string;
  launch: AgentLaunch;
  brief?: string;
  signal?: AbortSignal;
  onCleanupFailure?: () => void;
  promptRunner?: (options: RunAgentOptions) => Promise<RunAgentResult>;
  agentRunner?: (options: RunAgentOptions) => Promise<RunAgentResult>;
  timeoutMs?: number;
};

export function closeoutPrompt(): string {
  return [
    "After changes and before finishing, call get_closeout.",
    "It returns the required checks, matched paths, statuses, and the pending ids to run with run_closeout.",
    "It does not run checks.",
    "Run each pending id in order with run_closeout, then call get_closeout again.",
    "run_closeout runs matching setup steps first.",
    "Further edits can make passed checks stale.",
    "If blocked is non-null, stop retrying. When the blocker is an exhausted check, finish with a short note on why, and Paws asks the team how to continue. Otherwise report the blocker.",
    "If a required check fails, fix it and call run_closeout again.",
    "If you cannot fix it, call ask_team with the error and what you tried.",
    "Reviews stay in required and are not pending. An independent reviewer runs those.",
  ].join(" ");
}

export function closeoutChecksPrompt(head: string): string {
  return [
    `Run Paws Closeout on commit ${head}. Main moved or the commit is new, so its checks have not run yet.`,
    "Do not edit, create, or delete files, and do not commit. Do not try to fix anything.",
    "Call get_closeout, run each pending id in order with run_closeout, then call get_closeout again.",
    "Keep going when a check fails, so every pending check has a result.",
    "Reviews stay in required and are not pending. Leave them.",
    "Finish with one line per check: its id and status.",
  ].join("\n");
}

export const POST_UPDATE_PROMPT =
  "Call post_update when something meaningful happens, such as finding the cause, a plan change, tests passing, or being blocked. Don't narrate each step.";

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
    "Call update_plan with the full working checklist whenever the steps or their statuses change. Statuses are pending, inProgress, completed, and canceled. Leave verification and publication out of that list.",
    POST_UPDATE_PROMPT,
    closeoutPrompt(),
    "When the code change is ready, call open_pull_request with a title and a description of what changed, why, and how you verified it.",
    "Commit your work yourself in reviewable steps, each with a message that says what changed and why. Paws commits anything you leave uncommitted when you finish.",
  ].join("\n");
  if (input.handoff === undefined || input.handoff.trim() === "") return brief;
  return `${input.handoff.trim()}\n\n${brief}`;
}

export function createAcpCodexReviewer(deps: AcpAgentDeps): CodexReviewer {
  let seq = 0;
  return {
    async review(request): Promise<ReviewResult> {
      const prompt = [
        ...(deps.brief ? [deps.brief] : []),
        request.prompt ?? "Review the change.",
        `Task ${request.taskId}, item ${request.itemId}.`,
        `Base ${request.base}, head ${request.head}.`,
        FINDING_FORMAT,
      ].join("\n");
      const launch = deps.launch({
        role: "reviewer",
        profile: deps.profiles?.reviewer,
        purpose: "review",
        itemId: request.taskId,
        worktree: request.worktree,
        prompt,
      });
      const turn = async (
        turnPrompt: string,
        resume?: RunAgentOptions["resume"],
      ): Promise<{ identity: AgentIdentity; sessionId: string; text: string; tokens?: number }> => {
        let text = "";
        const refusals: Extract<AcpEvent, { type: "permission" }>[] = [];
        let result: RunAgentResult;
        for (let attempt = 1; ; attempt++) {
          seq += 1;
          text = "";
          refusals.length = 0;
          result = await (deps.agentRunner ?? runAgent)({
            repository: deps.repository,
            prepareInputFiles: deps.prepareInputFiles,
            role: "reviewer",
            profile: deps.profiles?.reviewer,
            itemId: request.taskId,
            runId: `rev-${request.taskId}-${seq}`,
            prompt: turnPrompt,
            worktreePath: request.worktree,
            pawsRoot: deps.pawsRoot,
            checkpoint: false,
            readOnly: true,
            ...(resume ? { resume } : {}),
            ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
            ...(deps.home ? { home: deps.home } : {}),
            ...(deps.signal ? { signal: deps.signal } : {}),
            ...spawnOf(launch),
            onEvent(event) {
              if (event.type === "permission" && event.decision === "deny") refusals.push(event);
              if (event.type === "progress" && !event.messageChunk)
                void deps.postUpdate?.post(event.text).catch((caughtError1) => {
                  journalCaught(caughtError1, "agents.onEvent.post", request.itemId);
                  return undefined;
                });
              if (event.type !== "session_update") return;
              if (event.update.sessionUpdate !== "agent_message_chunk") return;
              if (event.update.content.type === "text") text += event.update.content.text ?? "";
            },
          });
          if (attempt > 1 || !result.cancelled || deps.signal?.aborted) break;
        }
        if (!result.agentExited) deps.onCleanupFailure?.();
        const refused = refusals.at(-1);
        if (result.cancelled && !result.timedOut && refused && !deps.signal?.aborted) {
          const tool = refused.name || refused.title || refused.kind || "a tool";
          throw new Error(
            `The reviewer stopped after Paws refused its tool call \`${tool}\` (${refused.reason}), so the change was not reviewed.`,
          );
        }
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
          identity: result.identity,
          sessionId: result.sessionId ?? result.identity.session,
          text,
          ...(result.tokens === undefined ? {} : { tokens: result.tokens }),
        };
      };
      const first = await turn(prompt);
      const parsed = parseReviewFindings(first.text);
      if (parsed.ok)
        return {
          ...first.identity,
          findings: parsed.findings,
          ...(first.tokens === undefined ? {} : { tokens: first.tokens }),
        };
      // One follow-up in the same reviewer session. A runner that cannot load the
      // session replays the review prompt and the earlier reply instead.
      const followUp = findingsFollowUp(parsed.reason);
      const second = await turn(followUp, {
        sessionId: first.sessionId,
        replayPrompt: [prompt, "Your earlier reply:", first.text, followUp].join("\n\n"),
      });
      const tokens =
        first.tokens === undefined && second.tokens === undefined
          ? undefined
          : (first.tokens ?? 0) + (second.tokens ?? 0);
      return {
        ...second.identity,
        findings: parseFindings(second.text),
        ...(tokens === undefined ? {} : { tokens }),
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
      const result = await (deps.promptRunner ?? deps.agentRunner ?? runAgent)({
        repository: deps.repository,
        prepareInputFiles: deps.prepareInputFiles,
        onEvent: deps.onEvent,
        updatePlan: deps.updatePlan,
        pullRequest: deps.pullRequest,
        postUpdate: deps.postUpdate,
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
      });
      if (!result.agentExited) deps.onCleanupFailure?.();
      if (result.cancelled) return { ok: false, reason: "fix cancelled" };
      if (result.authRequired || result.stopReason === "error" || result.stopReason === "timeout") {
        return { ok: false, reason: result.errorMessage ?? result.stopReason };
      }
      if (!result.identity)
        return { ok: false, reason: "Fix agent did not report a concrete session model" };
      const head = (await git(["-C", request.worktree, "rev-parse", "HEAD"])).trim();
      if (head === "" || (head === request.head && !evidenceOnly(request.items))) {
        return { ok: false, reason: "fix did not move HEAD to a new commit" };
      }
      deps.onCandidate?.(result.identity);
      return {
        ok: true,
        head,
        ...(result.closeoutReport ? { closeoutReport: result.closeoutReport } : {}),
      };
    },
  };
}

export function fixPrompt(request: FixRequest, brief?: string): string {
  return [
    "Fix Closeout findings.",
    "Call update_plan with the full working checklist as the steps or their statuses change. Statuses are pending, inProgress, completed, and canceled. Leave verification and publication out of that list.",
    POST_UPDATE_PROMPT,
    closeoutPrompt(),
    ...(brief ? [brief] : []),
    `This is fix attempt ${request.fixAttempt} of ${request.maxFixAttempts}.`,
    request.summary,
  ].join("\n\n");
}

function findingsFollowUp(reason: string): string {
  return `Your findings were not valid JSON: ${reason}. Send only the findings array.`;
}

export function parseFindings(text: string): Finding[] {
  const parsed = parseReviewFindings(text);
  if (!parsed.ok) throw new Error(`Invalid review findings: ${parsed.reason}`);
  return parsed.findings;
}

function spawnOf(launch: ReturnType<AgentLaunch>): {
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  cancelGraceMs?: number;
} {
  return {
    ...(launch.command ? { command: launch.command, args: launch.args ?? [] } : {}),
    ...(launch.env ? { env: launch.env } : {}),
    ...(launch.cancelGraceMs !== undefined ? { cancelGraceMs: launch.cancelGraceMs } : {}),
  };
}
