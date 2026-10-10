import { homedir } from "node:os";
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type { AskTeamHook } from "../acp";
import { executeItem, git, removeWorktree, resolveAdapter, worktreePath } from "../acp";
import { loadConfigFile } from "../config";
import {
  createCloseoutGate,
  evaluateCandidate,
  type CandidateIdentity,
  type VerdictRecorder,
} from "../closeout";
import {
  CommandBus,
  JOB_KIND,
  MERGE_LANE,
  transitionEpic,
  type Clock,
  type EpicState,
  systemClock,
} from "../core";
import {
  applyWorkItemEvent,
  configureWorkItem,
  drainCommands,
  enqueueJob,
  enqueueJobOnce,
  enqueueOutboxOnce,
  failWorkItem,
  getRun,
  getWorkItem,
  immediate,
  insertRun,
  listInFlightItems,
  markRun,
  saveCheckpoint,
  setCurrentRun,
  submitCommand,
  type JobLoop,
  type OutboxDispatcher,
  type WorkItemRecord,
} from "../db";
import {
  publishAccepted,
  serialMerge,
  type GitHubClient,
  type GitHubTokenProvider,
} from "../github";
import { intakeDelegatedIssue } from "../intake";
import type { AcceptedLinearEvent, TrackerAdapter } from "../linear";
import {
  answerQuestion,
  elicitationBody,
  findOpenQuestion,
  handoffNote,
  openQuestion,
} from "../questions";
import { activityFromAcpEvent, FIRST_ACTIVITY_MS, KEEPALIVE_MS } from "./activity";
import { isGitHubIssue, itemPathId, publishIssueKey, worktreeBranch } from "./sources";
import {
  createAcpCodexReviewer,
  createAcpFixRunner,
  implementPrompt,
  type AgentLaunch,
} from "./agents";
import { deliverLinearOutbox } from "./dispatch";

export type GitHubBinding = {
  appId: string;
  installationId: string;
  privateKeyPem: string;
  client: GitHubClient;
  /** `github.auth = "gh"`. When set, push and merge do not mint a GitHub App token. */
  tokenProvider?: GitHubTokenProvider;
};

export type RepositoryBinding = {
  owner: string;
  repo: string;
  remoteUrl: string;
};

export type OrchestratorOptions = {
  db: Database;
  jobs: JobLoop;
  outbox: OutboxDispatcher;
  pawsRoot: string;
  home?: string;
  tracker?: TrackerAdapter | null;
  catchUp?: () => Promise<void>;
  repository?: RepositoryBinding | null;
  github?: GitHubBinding | null;
  closeoutBin?: string;
  launch?: AgentLaunch;
  clock?: Clock;
  /** Comment mode posts on the Linear issue. Agent-session mode keeps the session id. */
  channel?: "comments" | "agent-session";
  caps?: { maxTurns: number; maxAwakeMs: number };
  /** Sandbox for ACP spawns. The host path is unchanged when this is omitted. */
  docker?: { proxyUrl: string; image?: string; bin?: string };
};

type AnswerWaiter = (answer: string) => void;

/**
 * One process loop: intake, one item at a time, ACP, Closeout, pull request, serial merge.
 * Linear effects go through the outbox. State changes go through `transition()`.
 */
export class Orchestrator {
  readonly bus = new CommandBus();
  private tracker: TrackerAdapter | null;
  private catchUpFn: () => Promise<void>;
  private readonly waiters = new Map<string, AnswerWaiter>();
  private readonly live = new Map<string, { itemId: string; controller: AbortController }>();
  private activitySeq = 0;

  constructor(private readonly options: OrchestratorOptions) {
    this.tracker = options.tracker ?? null;
    this.catchUpFn = options.catchUp ?? (() => Promise.resolve());
    this.bus.subscribe((command) => {
      this.abortItem(command.itemId);
    });
    this.register();
  }

  setTracker(tracker: TrackerAdapter | null): void {
    this.tracker = tracker;
  }

  setCatchUp(catchUp: () => Promise<void>): void {
    this.catchUpFn = catchUp;
  }

  agentAlive = (runId: string): boolean => this.live.has(runId);

  async onLinearEvent(event: AcceptedLinearEvent): Promise<void> {
    if (event.signal === "stop") {
      this.stopSession(event.sessionId, event.updatedAtMs);
      return;
    }
    if (event.action === "prompted") {
      this.deliverPrompt(event);
      return;
    }
    if (event.action !== "created" || event.issueId === null) return;
    const tracker = this.tracker;
    if (tracker === null) throw new Error("Linear is not connected");
    const result = await intakeDelegatedIssue(this.db, tracker, {
      linearIssueId: event.issueId,
      sessionId: event.sessionId,
    });
    if (event.sessionId !== null) this.assignSession(result.epic.id, event.sessionId);
    if (result.ok) {
      const caps = this.options.caps;
      if (caps !== undefined) {
        for (const saved of result.items) {
          configureWorkItem(this.db, saved.id, {
            maxTurns: caps.maxTurns,
            maxAwakeMs: caps.maxAwakeMs,
          });
        }
      }
      this.pump();
    }
    await this.flush();
  }

  private get db(): Database {
    return this.options.db;
  }

  private register(): void {
    const jobs = this.options.jobs;
    jobs.register(JOB_KIND.command, (_job) => {
      drainCommands(this.db, this.bus, this.now());
    });
    jobs.register(JOB_KIND.catchup, (job) => {
      enqueueOutboxOnce(this.db, {
        target: "linear",
        op: "linear.catchup",
        idempotencyKey: `catchup:${job.id}:${job.attempts}`,
        payload: job.payload,
        now: this.now(),
      });
    });
    jobs.register(JOB_KIND.start, (job, context) =>
      this.executeQueued(job.payload, context.extendLease),
    );
    jobs.register(JOB_KIND.resume, (job, context) =>
      this.executeQueued(job.payload, context.extendLease),
    );
    jobs.register(JOB_KIND.reverify, (job) => this.reverify(job.payload));
    jobs.register(JOB_KIND.merge, (job) => this.merge(job.payload));
    this.options.outbox.setHandler(async (message) => {
      if (message.target !== "linear") return;
      const tracker = this.tracker;
      if (tracker === null) throw new Error("Linear is not connected");
      await deliverLinearOutbox(message, tracker, () => this.catchUpFn());
    });
  }

  private async executeQueued(
    payload: unknown,
    extendLease: (leaseMs?: number) => boolean,
  ): Promise<void> {
    const itemId = readString(payload, "itemId");
    if (itemId === null) return;
    const loaded = getWorkItem(this.db, itemId);
    if (loaded === null) return;
    if (loaded.cancelRequested || loaded.state === "cancelled") return;
    if (loaded.state === "awaiting_input" || loaded.state === "paused") return;
    if (loaded.state === "queued") applyWorkItemEvent(this.db, loaded.id, "dispatched");
    if (loaded.state === "recovering") applyWorkItemEvent(this.db, loaded.id, "recovered");
    const item = getWorkItem(this.db, loaded.id);
    if (item === null || item.state !== "running") return;

    const lease = setInterval(() => extendLease(60_000), 10_000);
    lease.unref?.();
    try {
      await this.runItem(item, readString(payload, "handoff") ?? undefined);
    } finally {
      clearInterval(lease);
    }
  }

  private async runItem(item: WorkItemRecord, handoff?: string): Promise<void> {
    const repository = this.options.repository;
    if (repository === null || repository === undefined) {
      this.fail(item, "no_repository", "PAWS_GITHUB_REPOSITORY is not set.");
      return;
    }
    if (this.stopped(item.id)) return;
    const pathId = itemPathId(item);
    const branch = worktreeBranch(item);
    if (item.branchName !== branch) {
      this.db.run("UPDATE work_item SET branch_name = ? WHERE id = ?", [branch, item.id]);
    }
    const run = this.ensureRun(item);
    const controller = new AbortController();
    this.live.set(run.id, { itemId: item.id, controller });
    this.post(item, "action", `Working on ${item.linearIdentifier}.`, `${run.id}:working`);
    this.postStatus(item, "started");
    let posted = true;
    const first = setTimeout(() => {
      if (posted) return;
      posted = true;
      this.post(item, "thought", `Working on ${item.linearIdentifier}.`, `${run.id}:first`);
      void this.flush();
    }, FIRST_ACTIVITY_MS);
    const keepAlive = setInterval(() => {
      this.post(
        item,
        "thought",
        `Still working on ${item.linearIdentifier}.`,
        `${run.id}:keep:${this.now()}`,
      );
      void this.flush();
    }, KEEPALIVE_MS);
    first.unref?.();
    keepAlive.unref?.();
    const askTeam = this.askHook(item, run.id);

    const prompt = implementPrompt({
      identifier: item.linearIdentifier,
      title: item.title,
      ...(handoff ? { handoff } : {}),
    });
    const launched = this.launchAgent({
      role: "implementer",
      purpose: "implement",
      itemId: pathId,
      worktree: worktreePath(this.options.pawsRoot, pathId),
      prompt,
    });
    try {
      await this.flush();
      if (this.stopped(item.id)) return;
      const executed = await executeItem({
        role: "implementer",
        itemId: pathId,
        runId: run.id,
        prompt,
        owner: repository.owner,
        repo: repository.repo,
        remoteUrl: repository.remoteUrl,
        pawsRoot: this.options.pawsRoot,
        home: this.options.home ?? homedir(),
        signal: controller.signal,
        askTeam,
        onEvent: (event) => {
          const activity = activityFromAcpEvent(event);
          if (activity === null || activity.kind === "elicitation") return;
          posted = true;
          this.activitySeq += 1;
          this.post(item, activity.kind, activity.body, `${run.id}:acp:${this.activitySeq}`);
        },
        ...(launched.command ? { command: launched.command, args: launched.args ?? [] } : {}),
        ...(launched.env ? { env: launched.env } : {}),
        ...this.itemDocker("claude"),
      });
      const finished = getWorkItem(this.db, item.id);
      if (finished === null || finished.state === "cancelled" || finished.cancelRequested) return;
      if (executed.run.authRequired) {
        this.fail(finished, "auth", executed.run.errorMessage ?? "Claude login is missing.");
        return;
      }
      if (executed.run.cancelled || executed.run.stopReason === "cancelled") return;
      if (executed.run.stopReason !== "end_turn") {
        this.fail(
          finished,
          executed.run.stopReason,
          executed.run.errorMessage ?? `Run stopped (${executed.run.stopReason}).`,
        );
        return;
      }
      const head = (await git(["-C", executed.worktreePath, "rev-parse", "HEAD"])).trim();
      const base = (
        await git(["-C", executed.worktreePath, "merge-base", "HEAD", "origin/main"])
      ).trim();
      saveCheckpoint(this.db, item.id, { phase: "running", baseSha: base, wipCommit: head });
      markRunEnded(this.db, run.id, this.now());
      await this.verify(finished, executed.worktreePath, base, head, {
        session: run.id,
        model: "claude-code",
        provider: "anthropic",
      });
    } catch (error) {
      const current = getWorkItem(this.db, item.id);
      if (current && current.state !== "cancelled" && !current.cancelRequested) {
        const message = error instanceof Error ? error.message : String(error);
        this.fail(current, "run_error", message);
      }
    } finally {
      clearTimeout(first);
      clearInterval(keepAlive);
      this.live.delete(run.id);
      await this.flush();
    }
  }

  private async verify(
    item: WorkItemRecord,
    worktree: string,
    base: string,
    head: string,
    candidate: CandidateIdentity,
  ): Promise<void> {
    const current = getWorkItem(this.db, item.id);
    if (current === null || current.state !== "running") return;
    applyWorkItemEvent(this.db, item.id, "turn_ended");
    const verifying = getWorkItem(this.db, item.id);
    if (verifying === null) return;
    saveCheckpoint(this.db, item.id, { phase: "verifying", baseSha: base, wipCommit: head });
    const deps = this.agentDeps();
    const reviewer = createAcpCodexReviewer(deps);
    const fixer = createAcpFixRunner(deps);
    const recorder: VerdictRecorder = {
      record: async (verdict) => {
        this.post(
          verifying,
          verdict.outcome === "accepted" ? "response" : "error",
          verdict.summary,
          `${item.id}:verdict:${verdict.head}:${verdict.outcome}`,
        );
      },
    };
    const gate = createCloseoutGate({
      candidate,
      reviewer,
      fixer,
      recorder,
      reportDir: `${this.options.pawsRoot}/runs/${itemPathId(item)}`,
      ...(this.options.closeoutBin ? { closeoutBin: this.options.closeoutBin } : {}),
    });
    const verdict = await gate.run({
      taskId: itemPathId(item),
      worktree,
      baseSha: base,
      headSha: head,
      attempt: 1,
    });
    const after = getWorkItem(this.db, item.id);
    if (after === null || after.state === "cancelled") return;
    if (verdict.decision === "accepted" && !verdict.exhausted) {
      const acceptedHead = (await git(["-C", worktree, "rev-parse", "HEAD"])).trim();
      applyWorkItemEvent(this.db, item.id, "closeout_accepted");
      saveCheckpoint(this.db, item.id, {
        phase: "merge_queue",
        baseSha: base,
        wipCommit: acceptedHead,
      });
      enqueueJobOnce(this.db, {
        queue: JOB_KIND.merge,
        lane: MERGE_LANE,
        jobKey: `merge:${item.id}:${acceptedHead}`,
        payload: { itemId: item.id, summary: verdict.summary, head: acceptedHead },
        now: this.now(),
      });
      return;
    }
    if (verdict.exhausted || verdict.decision === "rejected") {
      if (after.state === "verifying") applyWorkItemEvent(this.db, item.id, "closeout_exhausted");
      this.post(after, "error", verdict.summary, `${item.id}:exhausted`);
      this.pump();
      return;
    }
    this.fail(after, "closeout", verdict.summary);
  }

  private async reverify(payload: unknown): Promise<void> {
    const itemId = readString(payload, "itemId");
    if (itemId === null) return;
    const item = getWorkItem(this.db, itemId);
    if (item === null) return;
    const repository = this.options.repository;
    if (repository === null || repository === undefined) {
      this.fail(item, "no_repository", "PAWS_GITHUB_REPOSITORY is not set.");
      return;
    }
    const worktree = worktreePath(this.options.pawsRoot, itemPathId(item));
    let head = "";
    let base = item.checkpoint?.baseSha ?? "";
    try {
      head = (await git(["-C", worktree, "rev-parse", "HEAD"])).trim();
      if (base === "") {
        base = (await git(["-C", worktree, "merge-base", "HEAD", "origin/main"])).trim();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.fail(item, "reverify", message);
      return;
    }
    const deps = this.agentDeps();
    const evaluation = await evaluateCandidate({
      worktree,
      taskId: itemPathId(item),
      base,
      head,
      candidate: {
        session: item.currentRunId ?? item.id,
        model: "claude-code",
        provider: "anthropic",
      },
      reviewer: createAcpCodexReviewer(deps),
      ...(this.options.closeoutBin ? { closeoutBin: this.options.closeoutBin } : {}),
    });
    if (evaluation.outcome !== "accepted") {
      this.post(
        item,
        "error",
        evaluation.error ?? `Re-verify ${evaluation.outcome}.`,
        `${item.id}:reverify:${head}`,
      );
      if (item.state === "verifying")
        this.fail(item, "reverify", evaluation.error ?? evaluation.outcome);
      return;
    }
    if (item.state === "verifying") {
      applyWorkItemEvent(this.db, item.id, "closeout_accepted");
    }
    enqueueJobOnce(this.db, {
      queue: JOB_KIND.merge,
      lane: MERGE_LANE,
      jobKey: `merge:${item.id}:${head}`,
      payload: { itemId: item.id, summary: evaluation.decision?.message ?? "Re-verified.", head },
      now: this.now(),
    });
  }

  private async merge(payload: unknown): Promise<void> {
    const itemId = readString(payload, "itemId");
    if (itemId === null) return;
    const item = getWorkItem(this.db, itemId);
    if (item === null || item.state === "cancelled" || item.state === "merged") return;
    const repository = this.options.repository;
    const github = this.options.github;
    if (
      repository === null ||
      repository === undefined ||
      github === null ||
      github === undefined
    ) {
      this.fail(item, "no_github", "GitHub App is not configured.");
      return;
    }
    if (item.state !== "merge_queue") return;
    const worktree = worktreePath(this.options.pawsRoot, itemPathId(item));
    const summary = readString(payload, "summary") ?? "Closeout accepted.";
    const published = await publishAccepted({
      accepted: true,
      evidence: summary,
      worktree,
      issue: publishIssueKey(item),
      owner: repository.owner,
      repo: repository.repo,
      title: item.title,
      client: github.client,
      remoteUrl: repository.remoteUrl,
      ...this.gitHubCredentials(github),
    });
    if (!published.published) {
      this.fail(item, "publish", published.reason);
      return;
    }
    this.post(
      item,
      "response",
      `Opened ${published.pull.url ?? `pull request #${published.pull.number}`}.`,
      `${item.id}:pr:${published.pull.number}`,
    );
    const deps = this.agentDeps();
    const reviewer = createAcpCodexReviewer(deps);
    const merged = await serialMerge({
      worktree,
      issue: itemPathId(item),
      owner: repository.owner,
      repo: repository.repo,
      prNumber: published.pull.number,
      appId: github.appId,
      installationId: github.installationId,
      privateKeyPem: github.privateKeyPem,
      client: github.client,
      ...(github.tokenProvider ? { tokenProvider: github.tokenProvider } : {}),
      remoteUrl: repository.remoteUrl,
      reverify: async (input) => {
        const evaluation = await evaluateCandidate({
          worktree: input.worktree,
          taskId: itemPathId(item),
          base: input.base,
          head: input.head,
          candidate: {
            session: item.currentRunId ?? item.id,
            model: "claude-code",
            provider: "anthropic",
          },
          reviewer,
          ...(this.options.closeoutBin ? { closeoutBin: this.options.closeoutBin } : {}),
        });
        return {
          accepted: evaluation.outcome === "accepted",
          outcome: evaluation.outcome === "accepted" ? "merged" : evaluation.outcome,
          summary: evaluation.error ?? evaluation.decision?.message ?? evaluation.outcome,
        };
      },
    });
    if (!merged.merged) {
      this.post(
        item,
        "error",
        merged.message ?? merged.outcome,
        `${item.id}:merge:${merged.outcome}`,
      );
      if (
        item.state === "merge_queue" &&
        (merged.outcome === "sha_moved" || merged.outcome === "rejected")
      ) {
        applyWorkItemEvent(this.db, item.id, "main_moved");
        enqueueJobOnce(this.db, {
          queue: JOB_KIND.reverify,
          jobKey: `reverify:${item.id}:${merged.head ?? "again"}`,
          payload: { itemId: item.id },
          now: this.now(),
        });
        return;
      }
      this.fail(item, "merge", merged.message ?? merged.outcome);
      return;
    }
    applyWorkItemEvent(this.db, item.id, "merge_accepted");
    this.postStatus(item, "completed");
    this.post(item, "response", `Merged ${item.linearIdentifier}.`, `${item.id}:merged`);
    await removeWorktree({
      owner: repository.owner,
      repo: repository.repo,
      itemId: itemPathId(item),
      pawsRoot: this.options.pawsRoot,
    }).catch(() => undefined);
    this.pump();
    await this.flush();
  }

  private askHook(item: WorkItemRecord, runId: string): AskTeamHook {
    return {
      ask: async (request, context) => {
        const sessionId = this.activitySession(item);
        if (sessionId === null) {
          throw new Error("ask_team has no Linear session");
        }
        const options = request.options ?? [];
        const question = immediate(this.db, () => {
          const opened = openQuestion(this.db, {
            itemId: item.id,
            runId,
            sessionId,
            body: request.question,
            options,
            now: this.now(),
          });
          const current = getWorkItem(this.db, item.id);
          if (current?.state === "running") {
            applyWorkItemEvent(this.db, item.id, "blocking_question");
            saveCheckpoint(this.db, item.id, {
              phase: "awaiting_input",
              ...(current.checkpoint?.wipCommit ? { wipCommit: current.checkpoint.wipCommit } : {}),
              ...(current.checkpoint?.baseSha ? { baseSha: current.checkpoint.baseSha } : {}),
            });
          }
          enqueueOutboxOnce(this.db, {
            target: "linear",
            op: "elicitation",
            orderingKey: sessionId,
            idempotencyKey: `ask:${opened.id}`,
            payload: {
              sessionId,
              body: elicitationBody(request.question, request.context),
              options,
            },
            now: this.now(),
          });
          return opened;
        });
        const answer = await new Promise<string>((resolve, reject) => {
          const onAbort = () => {
            this.waiters.delete(question.id);
            reject(new Error("cancelled"));
          };
          if (context.signal.aborted) {
            onAbort();
            return;
          }
          context.signal.addEventListener("abort", onAbort, { once: true });
          this.waiters.set(question.id, (value) => {
            context.signal.removeEventListener("abort", onAbort);
            resolve(value);
          });
          void this.flush().catch((error: unknown) => {
            this.waiters.delete(question.id);
            reject(error instanceof Error ? error : new Error(String(error)));
          });
        });
        return { answer };
      },
    };
  }

  private deliverPrompt(event: AcceptedLinearEvent): void {
    const sessionId = event.sessionId;
    const answer = event.body?.trim() ?? "";
    if (sessionId === null || answer === "") return;
    const open = findOpenQuestion(this.db, sessionId);
    if (open === null) return;
    const stored = answerQuestion(this.db, open.id, {
      answer,
      answeredBy: "linear",
      now: this.now(),
    });
    if (stored === null) return;
    const waiter = this.waiters.get(open.id);
    this.waiters.delete(open.id);
    immediate(this.db, () => {
      const item = getWorkItem(this.db, open.itemId);
      if (item?.state === "awaiting_input") {
        applyWorkItemEvent(this.db, item.id, "answer_received");
      }
      if (waiter !== undefined || item === null) return;
      enqueueJob(this.db, {
        queue: JOB_KIND.resume,
        jobKey: `resume:answer:${open.id}`,
        payload: {
          itemId: open.itemId,
          freshSession: true,
          handoff: handoffNote({ question: open.body, answer }),
          reason: "answer",
        },
        now: this.now(),
      });
    });
    waiter?.(answer);
  }

  private stopSession(sessionId: string | null, at: number): void {
    if (sessionId === null) return;
    for (const item of this.itemsForSession(sessionId)) {
      if (item.state === "merged" || item.state === "cancelled") continue;
      submitCommand(this.db, this.bus, {
        type: "stop",
        itemId: item.id,
        source: "linear",
        requestedAt: at > 0 ? at : this.now(),
      });
      this.postStatus(item, "canceled");
    }
    void this.flush();
  }

  private pump(): void {
    if (listInFlightItems(this.db).length > 0) return;
    const queued = this.allItems().filter((item) => item.state === "queued");
    queued.sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
    for (const item of queued) {
      if (!this.blockersClear(item)) continue;
      enqueueJobOnce(this.db, {
        queue: JOB_KIND.start,
        jobKey: `start:${item.id}`,
        payload: { itemId: item.id },
        now: this.now(),
      });
      return;
    }
    const epicIds = new Set(this.allItems().map((item) => item.epicId));
    for (const epicId of epicIds) this.finishEpic(epicId);
  }

  private finishEpic(epicId: string): void {
    const items = this.epicItems(epicId);
    if (items.length === 0) return;
    if (items.some((item) => item.state !== "merged")) {
      const inflight = items.some((item) => inFlight(item.state));
      const runnable = items.some((item) => item.state === "queued" && this.blockersClear(item));
      if (!inflight && !runnable && items.some((item) => !terminal(item.state))) {
        this.stallEpic(epicId, items);
      }
      return;
    }
    const row = this.epicRow(epicId);
    if (row === null || row.state !== "running") return;
    const result = transitionEpic(row.state, "completed");
    if (!result.ok) return;
    this.db.run("UPDATE epic SET state = ?, version = version + 1 WHERE id = ? AND state = ?", [
      result.to,
      epicId,
      row.state,
    ]);
    const epicIssueId = this.epicIssueId(epicId);
    const session =
      epicIssueId !== null && isGitHubIssue(epicIssueId) ? epicIssueId : this.epicSession(items);
    if (session === null) return;
    const identifiers = items.map((item) => item.linearIdentifier).join(", ");
    enqueueOutboxOnce(this.db, {
      target: "linear",
      op: "activity",
      orderingKey: session,
      idempotencyKey: `epic-done:${epicId}`,
      payload: {
        sessionId: session,
        kind: "response",
        body: `Epic complete. Merged ${identifiers}.`,
      },
      now: this.now(),
    });
  }

  private stallEpic(epicId: string, items: readonly WorkItemRecord[]): void {
    const row = this.epicRow(epicId);
    if (row === null || row.state !== "running") return;
    const result = transitionEpic(row.state, "stalled");
    if (!result.ok) return;
    this.db.run("UPDATE epic SET state = ?, version = version + 1 WHERE id = ? AND state = ?", [
      result.to,
      epicId,
      row.state,
    ]);
    const session = this.epicSession(items);
    if (session === null) return;
    enqueueOutboxOnce(this.db, {
      target: "linear",
      op: "activity",
      orderingKey: session,
      idempotencyKey: `epic-stalled:${epicId}`,
      payload: {
        sessionId: session,
        kind: "error",
        body: "The queue cannot make progress. A blocker did not merge.",
      },
      now: this.now(),
    });
  }

  private blockersClear(item: WorkItemRecord): boolean {
    const rows = this.db
      .query<{ blocker_linear_issue_id: string }, [string, string]>(
        `SELECT blocker_linear_issue_id FROM work_item_block
         WHERE epic_id = ? AND blocked_linear_issue_id = ?`,
      )
      .all(item.epicId, item.linearIssueId);
    for (const row of rows) {
      const blocker = this.db
        .query<{ state: string }, [string, string]>(
          `SELECT state FROM work_item WHERE epic_id = ? AND linear_issue_id = ?`,
        )
        .get(item.epicId, row.blocker_linear_issue_id);
      if (blocker?.state !== "merged") return false;
    }
    return true;
  }

  private ensureRun(item: WorkItemRecord): { id: string } {
    if (item.currentRunId !== null) {
      const existing = getRun(this.db, item.currentRunId);
      if (existing && existing.status === "active") return existing;
    }
    const run = insertRun(this.db, {
      itemId: item.id,
      now: this.now(),
      status: "active",
      kind: "implement",
      agent: "claude",
      freshSession: true,
    });
    setCurrentRun(this.db, item.id, run.id);
    return run;
  }

  private fail(item: WorkItemRecord, reason: string, text: string): void {
    const current = getWorkItem(this.db, item.id) ?? item;
    if (
      current.state === "running" ||
      current.state === "verifying" ||
      current.state === "recovering" ||
      current.state === "merge_queue"
    ) {
      failWorkItem(this.db, current, reason, text, this.now());
    } else {
      this.post(current, "error", text, `fail:${current.id}:${reason}`);
    }
    this.pump();
  }

  private post(
    item: WorkItemRecord,
    kind: "thought" | "action" | "response" | "error",
    body: string,
    key: string,
  ): void {
    const sessionId = this.activitySession(item);
    if (sessionId === null || body.trim() === "") return;
    enqueueOutboxOnce(this.db, {
      target: "linear",
      op: "activity",
      orderingKey: sessionId,
      idempotencyKey: key,
      payload: { sessionId, kind, body },
      now: this.now(),
    });
  }

  private postStatus(item: WorkItemRecord, stateType: "started" | "completed" | "canceled"): void {
    const sessionId = this.activitySession(item) ?? item.id;
    enqueueOutboxOnce(this.db, {
      target: "linear",
      op: "status",
      orderingKey: sessionId,
      idempotencyKey: `status:${item.id}:${stateType}`,
      payload: { linearIssueId: item.linearIssueId, stateType },
      now: this.now(),
    });
  }

  private assignSession(epicId: string, sessionId: string): void {
    for (const item of this.epicItems(epicId)) {
      configureWorkItem(this.db, item.id, { sessionKey: sessionId });
    }
  }

  private abortItem(itemId: string): void {
    for (const [runId, live] of this.live) {
      if (live.itemId !== itemId) continue;
      live.controller.abort();
      this.live.delete(runId);
    }
  }

  private itemsForSession(sessionId: string): WorkItemRecord[] {
    return this.allItems().filter((item) => item.sessionKey === sessionId);
  }

  private allItems(): WorkItemRecord[] {
    const rows = this.db.query<{ id: string }, []>("SELECT id FROM work_item").all();
    const items: WorkItemRecord[] = [];
    for (const row of rows) {
      const item = getWorkItem(this.db, row.id);
      if (item) items.push(item);
    }
    return items;
  }

  private epicItems(epicId: string): WorkItemRecord[] {
    return this.allItems()
      .filter((item) => item.epicId === epicId)
      .sort((left, right) => left.position - right.position);
  }

  private epicRow(epicId: string): { id: string; state: EpicState } | null {
    return this.db
      .query<{ id: string; state: EpicState }, [string]>("SELECT id, state FROM epic WHERE id = ?")
      .get(epicId);
  }

  private async flush(): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const claimed = this.options.outbox.tick();
      await this.options.outbox.idle();
      if (claimed.length === 0) return;
    }
  }

  private stopped(itemId: string): boolean {
    const current = getWorkItem(this.db, itemId);
    return current === null || current.state === "cancelled" || current.cancelRequested;
  }

  private agentDeps(): {
    pawsRoot: string;
    home?: string;
    launch: AgentLaunch;
    docker?: { proxyUrl: string; image?: string; bin?: string };
  } {
    return {
      pawsRoot: this.options.pawsRoot,
      ...(this.options.home ? { home: this.options.home } : {}),
      launch: this.launchAgent.bind(this),
      ...(this.options.docker ? { docker: this.options.docker } : {}),
    };
  }

  private itemDocker(agent: "claude" | "codex"):
    | {
        docker: {
          agent: "claude" | "codex";
          proxyUrl: string;
          image?: string;
          bin?: string;
        };
      }
    | Record<string, never> {
    const docker = this.options.docker;
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

  private gitHubCredentials(
    github: GitHubBinding,
  ):
    | { tokenProvider: GitHubTokenProvider }
    | { appId: string; installationId: string; privateKeyPem: string } {
    if (github.tokenProvider) return { tokenProvider: github.tokenProvider };
    return {
      appId: github.appId,
      installationId: github.installationId,
      privateKeyPem: github.privateKeyPem,
    };
  }

  private epicIssueId(epicId: string): string | null {
    const row = this.db
      .query<{ linear_issue_id: string }, [string]>("SELECT linear_issue_id FROM epic WHERE id = ?")
      .get(epicId);
    return row?.linear_issue_id ?? null;
  }

  private activitySession(item: WorkItemRecord): string | null {
    if (isGitHubIssue(item.linearIssueId)) return item.linearIssueId;
    if (this.options.channel === "comments") return item.linearIssueId;
    const session = item.sessionKey;
    if (session === null || session.length === 0) return null;
    return session;
  }

  private epicSession(items: readonly WorkItemRecord[]): string | null {
    for (const item of items) {
      const session = this.activitySession(item);
      if (session !== null) return session;
    }
    return null;
  }

  private launchAgent: AgentLaunch = (input) => {
    const launched = this.options.launch?.(input) ?? {};
    if (launched.command) return launched;
    try {
      const agents = loadConfigFile(join(this.options.pawsRoot, "config.toml")).agents;
      const adapter = resolveAdapter(input.role, process.env, undefined, undefined, agents);
      return { ...launched, command: adapter.command, args: launched.args ?? adapter.args };
    } catch {
      return launched;
    }
  };

  private now(): number {
    return (this.options.clock ?? systemClock).now();
  }
}

export function attachOrchestrator(options: OrchestratorOptions): Orchestrator {
  return new Orchestrator(options);
}

function markRunEnded(db: Database, runId: string, now: number): void {
  const run = getRun(db, runId);
  if (run && run.status === "active") markRun(db, runId, "ended", now);
}

function inFlight(state: WorkItemRecord["state"]): boolean {
  return (
    state === "running" ||
    state === "verifying" ||
    state === "recovering" ||
    state === "awaiting_input" ||
    state === "paused" ||
    state === "merge_queue"
  );
}

function terminal(state: WorkItemRecord["state"]): boolean {
  return state === "merged" || state === "cancelled" || state === "failed" || state === "exhausted";
}

function readString(payload: unknown, key: string): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}
