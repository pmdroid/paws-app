import type { Database } from "bun:sqlite";
import { JOB_KIND } from "../core";
import {
  applyWorkItemEvent,
  artifactPublicationReady,
  completeMergedItem,
  enqueueJobOnce,
  getConfirmedRemoteMerge,
  getWorkItem,
  leaveMergeQueue,
  recordConfirmedRemoteMerge,
  recordRebaseReturn,
  type CiRound,
  type TaskMergeSettings,
  type WorkItemRecord,
} from "../db";
import {
  serialMerge,
  type GitExec,
  type GitHubBinding,
  type ReverifyInput,
  type ReverifyResult,
} from "../github";
import { ciFixHandoff, ciFixQuestion, ciFixRoundLine } from "./ci-fix";
import {
  REBASE_CONFLICT_INSTRUCTION,
  REBASE_CONFLICT_THOUGHT,
  askHelp,
  ciRound,
  mergeQueueTurn,
  mergeThroughGitHubQueue,
  sendBack,
  type MergeContext,
  type MergePull,
  type OrderCapabilities,
} from "./orders";
import { ciFixes, rebaseReturns } from "./returns";
import { MAX_REBASE_RETURNS, serialMergeStep, type MergeStep } from "./step";
import { ciWaitVerification, wakeMergesBehind } from "./wait";

export type MergePublication = MergePull & {
  github: GitHubBinding & { gitExec: GitExec };
  worktree: string;
  branchKey: string;
  summary: string;
  commit: { title: string; message?: string; env?: Record<string, string> };
};

export type MergeVerdict = ReverifyResult & { rejected: boolean };

export type MergeCapabilities = OrderCapabilities & {
  publish(item: WorkItemRecord): Promise<MergePublication | MergeStep>;
  settings(item: WorkItemRecord, signal: AbortSignal): Promise<TaskMergeSettings>;
  accept(candidate: { sha: string; baseSha: string }): void;
  verify(input: ReverifyInput): Promise<MergeVerdict>;
  assertReady(item: WorkItemRecord): Promise<void>;
  askCloseoutHelp(item: WorkItemRecord): Promise<void>;
  packages(repository: string): string[];
  completed(): void;
};

export async function advanceMerge(
  db: Database,
  input: { itemId: string; payload: unknown; jobId: number },
  caps: MergeCapabilities,
): Promise<MergeStep> {
  const item = getWorkItem(db, input.itemId);
  if (
    item === null ||
    item.state === "cancelled" ||
    item.state === "merged" ||
    item.state === "completed"
  )
    return { kind: "obsolete" };
  if (getConfirmedRemoteMerge(db, item.id)) {
    if (completeMergedItem(db, { itemId: item.id, now: caps.now() })) caps.completed();
    return { kind: "obsolete" };
  }
  const published = await caps.publish(item);
  if ("kind" in published) return published;
  const merge: MergeContext = { db, item, caps };
  const { repository, github, pull } = published;
  const { voice } = caps;
  const priorVerification = ciWaitVerification(input.payload);
  let closeoutFailed = false;
  const acceptedHead = readString(input.payload, "head") ?? item.checkpoint?.wipCommit ?? null;
  const mergeSettings = await caps.settings(item, published.signal);
  if (mergeSettings.order === "github-queue") {
    const handed = await mergeThroughGitHubQueue(merge, input.payload, published);
    if (handed !== "no_queue") return handed;
  }
  const closeoutAfterUpdate = mergeSettings.mainMoved === "closeout";
  const queued = mergeSettings.order === "queue";
  if (queued) {
    const wait = await mergeQueueTurn(merge, repository, github, {
      number: pull.number,
      head: priorVerification?.head ?? acceptedHead ?? "",
    });
    if (wait) return { kind: "wait", ...wait };
    if (caps.stopped()) return { kind: "obsolete" };
  }
  const repositoryName = `${repository.owner}/${repository.repo}`;
  const merged = await serialMerge({
    worktree: published.worktree,
    issue: item.linearIdentifier,
    branchKey: published.branchKey,
    owner: repository.owner,
    repo: repository.repo,
    prNumber: pull.number,
    commitTitle: published.commit.title,
    commitMessage: published.commit.message,
    commitEnv: published.commit.env,
    appId: github.appId,
    installationId: github.installationId,
    privateKeyPem: github.privateKeyPem,
    client: github.client,
    gitExec: github.gitExec,
    ...(github.tokenProvider ? { tokenProvider: github.tokenProvider } : {}),
    remoteUrl: repository.remoteUrl,
    isCancelled: () => caps.stopped() || !artifactPublicationReady(db, item.id),
    releaseWhilePending: true,
    ...(priorVerification === undefined ? {} : { priorVerification }),
    ...(mergeSettings.mainMoved === "overlap"
      ? {
          updateOnOverlap: {
            packages: caps.packages(repositoryName),
            onUpToDateRule: async () => {
              voice.afterPullRequest(
                item,
                upToDateRuleMessage(repositoryName),
                `${item.id}:up-to-date-rule`,
              );
              await voice.flush();
            },
          },
        }
      : {}),
    onWait: async (message) => {
      voice.thought(item, message, `${item.id}:merge-wait:${message}`);
      await voice.flush();
    },
    reverify: async (verify) => {
      const updated = acceptedHead !== null && verify.head !== acceptedHead;
      if (verify.kept || (updated && !closeoutAfterUpdate)) {
        caps.accept({ sha: verify.head, baseSha: verify.base });
        if (!verify.kept) {
          voice.status(
            item,
            branchUpdatedMessage(verify.base, mergeSettings.mainMoved, verify.overlap),
            `${item.id}:branch-updated:${verify.head}`,
          );
          await voice.flush();
        }
        const filesReady = artifactPublicationReady(db, item.id);
        return {
          accepted: filesReady,
          outcome: filesReady ? "merged" : "blocked",
          summary: filesReady ? published.summary : "A requested artifact has not been uploaded.",
        };
      }
      if (updated)
        voice.status(
          item,
          "Branch updated, running Closeout again.",
          `${item.id}:branch-updated:${verify.head}`,
        );
      const verdict = await caps.verify(verify);
      if (verdict.rejected) closeoutFailed = true;
      return { accepted: verdict.accepted, outcome: verdict.outcome, summary: verdict.summary };
    },
  });
  const ciFixLimit = caps.ciFixAttempts();
  const { step, leaveQueue } = serialMergeStep({
    result: merged,
    queued,
    closeoutAfterUpdate,
    closeoutFailed,
    rebaseReturns: rebaseReturns(db, item.id),
    ciFixes: ciFixes(db, item.id),
    ciFixLimit,
  });
  if (leaveQueue) {
    leaveMergeQueue(db, item.id);
    wakeMergesBehind(db, caps.now());
  }
  if (step.kind === "wait" && step.reason === "ci")
    return caps.stopped() ? { kind: "obsolete" } : step;
  if (merged.merged)
    recordConfirmedRemoteMerge(db, {
      itemId: item.id,
      repositoryOwner: repository.owner,
      repositoryName: repository.repo,
      pullNumber: pull.number,
      pullUrl: pull.url,
      mergeSha: merged.sha ?? null,
      confirmedAt: caps.now(),
    });
  if (caps.stopped()) {
    if (merged.merged) completeMergedItem(db, { itemId: item.id, now: caps.now() });
    return { kind: "obsolete" };
  }
  if (merged.merged) return { kind: "merged" };
  await caps.assertReady(item);
  if (getWorkItem(db, item.id)?.state === "awaiting_input") return { kind: "obsolete" };
  if (step.kind === "unreadable") throw new Error(step.message);
  if (step.kind === "ask_closeout") {
    await caps.askCloseoutHelp(item);
    return { kind: "asked" };
  }
  if (
    step.kind === "return" &&
    step.reason === "rebase-conflict" &&
    sendBack(merge, "rebase-conflict", MAX_REBASE_RETURNS, REBASE_CONFLICT_INSTRUCTION, {
      thought: () => REBASE_CONFLICT_THOUGHT,
      record: (jobId) =>
        recordRebaseReturn(db, {
          itemId: item.id,
          jobId,
          candidate: merged.head ?? null,
          reason: "merge",
        }),
    })
  )
    return { kind: "returned" };
  if (merged.outcome === "ci_failed") {
    const checks = merged.failedChecks ?? [];
    const round = (next: CiRound["next"], fix: number | null = null) =>
      ciRound(merge, merged.head ?? "", merged.checks, next, ciFixLimit, fix);
    if (
      step.kind === "return" &&
      sendBack(merge, "ci-failed", ciFixLimit, ciFixHandoff(checks), {
        thought: (attempt) => ciFixRoundLine(checks, attempt, ciFixLimit),
        record: (_, attempt) => round("agent", attempt),
      })
    )
      return { kind: "returned" };
    if (askHelp(merge, ciFixQuestion(checks, ciFixLimit, pull.url))) {
      round("asked");
      await voice.flush();
      return { kind: "asked" };
    }
    round("failed");
  }
  voice.thought(item, merged.message ?? merged.outcome, `${item.id}:merge:${merged.outcome}`);
  if (step.kind === "wait") return step;
  if (step.kind === "reverify") {
    applyWorkItemEvent(db, item.id, "main_moved");
    enqueueJobOnce(db, {
      queue: JOB_KIND.reverify,
      jobKey: `reverify:${item.id}:${merged.head ?? "again"}:merge:${input.jobId}`,
      payload: { itemId: item.id },
      now: caps.now(),
    });
    return { kind: "returned" };
  }
  return {
    kind: "failed",
    reason: "merge",
    message: step.kind === "failed" ? step.message : (merged.message ?? merged.outcome),
  };
}

function branchUpdatedMessage(base: string, mainMoved: string, overlap?: string[]): string {
  const updated = `Branch updated onto main ${base.slice(0, 7)}, waiting for CI.`;
  if (mainMoved !== "overlap")
    return `${updated} Closeout does not run again, because "When main moved before the merge" for this task is set to wait for CI in Settings → Merging.`;
  if (!overlap?.length) return updated;
  const listed = overlap.slice(0, 5).join(", ") + (overlap.length > 5 ? ", …" : "");
  return `Main changed ${listed}, which this pull request changes too. ${updated}`;
}

function upToDateRuleMessage(repository: string): string {
  return `GitHub requires branches to be up to date before merging in ${repository}, so Paws updates the branch and waits for CI even when main changed other files. Turn off "Require branches to be up to date before merging" for the base branch to merge without an update.`;
}

function readString(payload: unknown, key: string): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}
