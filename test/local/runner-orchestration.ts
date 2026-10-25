import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAgent, type RunAgentOptions } from "../../src/acp";
import { JOB_KIND, systemClock, FakeClock } from "../../src/core";
import {
  JobLoop,
  getJob,
  beginImplementRun,
  OutboxDispatcher,
  getRun,
  enqueueJob,
  listJobs,
  listRuns,
  applyWorkItemEvent,
  insertRun,
  setCurrentRun,
  getWorkItem,
  listOutbox,
  listWorkItems,
  putWorkspaceUser,
  syncWorkspaceMember,
  markRun,
  recoverOnStartup,
  saveTaskMode,
  bindWorkItemRepository,
  getLinearSession,
  ensureLinearSession,
  bindLinearSessionTask,
  saveCheckpoint,
  type WorkItemRecord,
} from "../../src/db";
import { createFakeTracker, LinearRateLimitError } from "../../src/linear";
import { findOpenQuestion } from "../../src/questions";
import { intakeDelegatedIssue } from "../../src/intake";
import { fakeMergeReadiness, fakeRequiredChecks } from "../../src/github";
import { attachOrchestrator } from "../../src/loop";
import { saveSchedulingContext } from "../../src/scheduler";
import { migratedDatabase } from "../helpers";
import { workspaceAdmission } from "../fake-workspace";

export const RUNNER_ORCHESTRATION_SCENARIOS = [
  "success",
  "error",
  "cancelled",
  "reassigned",
  "stale",
  "merge",
  "unavailable",
  "crashed-implementation",
  "crashed-review",
  "start-lease",
  "resume-lease",
  "reverify-lease",
  "merge-lease",
  "rebase",
  "rebase-failing",
  "rebase-unreachable",
  "rebase-empty-report",
  "rebase-rate-limited",
] as const;

export async function probeRunnerOrchestration(
  root: string,
  observe: (name: string, passed: boolean, value: unknown) => void,
  mergeDependencyYield = false,
  scenarios: readonly string[] = RUNNER_ORCHESTRATION_SCENARIOS,
) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const source = join(root, "source");
  const origin = join(root, "origin.git");
  async function git(args: string[]) {
    const child = Bun.spawn(["/usr/bin/git", ...args], {
      env: {
        PATH: "/usr/bin:/bin",
        HOME: root,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    assert.equal(code, 0, err);
    return out.trim();
  }
  await git(["init", "-b", "main", source]);
  mkdirSync(join(source, ".agents/skills/review"), { recursive: true });
  writeFileSync(join(source, "README.md"), "Fixture\n");
  writeFileSync(
    join(source, ".agents/skills/review/SKILL.md"),
    "Review the candidate and return findings.\n",
  );
  writeFileSync(
    join(source, ".agents/closeout.yaml"),
    JSON.stringify({
      specVersion: "0.1",
      setup: [{ id: "prepare", exec: ["/forbidden-local-check", "setup"], timeoutSeconds: 5 }],
      items: [
        {
          id: "check",
          kind: "command",
          gate: "beforePR",
          exec: ["/forbidden-local-check", "check"],
          timeoutSeconds: 5,
        },
        {
          id: "review",
          kind: "review",
          gate: "beforePR",
          skill: ".agents/skills/review/SKILL.md",
          independence: { differentSession: true, differentModel: true },
          failOn: "P1",
        },
      ],
    }),
  );
  await git(["-C", source, "add", "."]);
  await git(["-C", source, "commit", "-m", "Fixture policy"]);
  await git(["clone", "--bare", source, origin]);
  for (const scenario of mergeDependencyYield ? ["merge"] : scenarios) {
    const unavailable = scenario === "unavailable";
    const rebase = scenario.startsWith("rebase");
    let rateLimited = 0;
    const merging = scenario === "merge" || scenario === "merge-lease" || rebase;
    const home = join(root, scenario);
    mkdirSync(home, { mode: 0o700 });
    const db = migratedDatabase(join(home, "paws.db"));
    const tracker = createFakeTracker([
      {
        linearIssueId: "issue",
        identifier: "ENG-42",
        title: "Write output",
        description: null,
        subIssues: [],
      },
    ]);
    const leaseScenario = scenario.endsWith("-lease");
    const initialLease = scenario === "start-lease" || scenario === "resume-lease";
    const clock = leaseScenario || mergeDependencyYield ? new FakeClock(Date.now()) : systemClock;
    const jobs = new JobLoop(db, clock, leaseScenario ? { leaseMs: 300 } : {});
    const outbox = new OutboxDispatcher(db, systemClock);
    const calls: {
      role: string;
      prepare: boolean;
      checks: boolean;
      reverifying: boolean;
      prompt: string;
      networkGit: boolean;
      mainSha?: string;
    }[] = [];
    const checkedHeads: string[] = [];
    const witnessCalls = 0;
    const appChecks: { currentRunId: string | null; checkpoint: unknown }[] = [];
    let implementationCount = 0;
    let reverifying = false;
    let originalRunId = "";
    let originalProfile = Buffer.alloc(0);
    let reviewRunId = "";
    let replacementRunId = "";
    let reclaimedJobId = 0;
    let replacementTick: Promise<unknown> | undefined;
    let releaseReplacement: (() => void) | undefined;
    let leaseAborted = false;
    async function reclaim(signal: AbortSignal | undefined) {
      assert(signal);
      const owned = listJobs(db).find(
        (job) =>
          job.status === "running" &&
          (job.payload as { itemId?: string }).itemId === listWorkItems(db)[0]?.id,
      )!;
      assert(owned);
      const other = new JobLoop(db, clock, { leaseMs: 300 });
      let entered!: () => void;
      const started = new Promise<void>((r) => (entered = r));
      const blocked = new Promise<void>((r) => (releaseReplacement = r));
      other.register(owned.queue, async () => {
        const item = listWorkItems(db)[0]!;
        replacementRunId = insertRun(db, {
          itemId: item.id,
          kind: initialLease ? "implement" : "review",
          status: "active",
          now: clock.now(),
        }).id;
        setCurrentRun(db, item.id, replacementRunId);
        entered();
        await blocked;
      });
      assert(clock instanceof FakeClock);
      clock.advance(30001);
      replacementTick = other.tick();
      if (owned.queue === JOB_KIND.start) {
        assert.equal(await replacementTick, null);
        db.run("UPDATE job SET locked_by = ? WHERE id = ?", ["replacement:claim", owned.id]);
        replacementRunId = listWorkItems(db)[0]!.currentRunId!;
      } else {
        await Promise.race([
          started,
          Bun.sleep(10_000).then(() => {
            throw new Error("Replacement could not claim job");
          }),
        ]);
        assert.notEqual(getJob(db, owned.id)?.lockedBy, owned.lockedBy);
      }
      reclaimedJobId = owned.id;
      await Promise.race([
        new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        }),
        Bun.sleep(10_000).then(() => {
          throw new Error("Lease loss did not abort selected transport");
        }),
      ]);
      leaseAborted = signal.aborted;
      assert(leaseAborted);
    }
    // runner-wait: the task's runner is paused when Closeout starts and resumes later.
    const runnerWait = scenario === "runner-wait";
    const waitReason = "Waiting: runner goldbox is paused. Resume it on the Runners page.";
    let runnerResumed = false;
    let runnerWatch: Promise<void> | undefined;
    function pauseTaskRunner(runId: string) {
      const now = Date.now();
      const userId = putWorkspaceUser(db, {
        id: "user-1",
        linearUserId: "user-linear",
        name: "Owner",
        email: "owner@example.invalid",
      });
      db.run("INSERT INTO workspace VALUES(?,?,?,?)", ["ws-1", "org-1", "Workspace", now]);
      syncWorkspaceMember(db, {
        workspaceId: "ws-1",
        userId,
        role: "owner",
        active: true,
        teamIds: [],
        now,
      });
      db.run(
        "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES(?,?,?,?,'paused',?,?)",
        ["runner-1", "ws-1", userId, "goldbox", now, now],
      );
      db.run(
        "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until,last_sequence) VALUES(?,?,?,1,0,?,?,0)",
        [runId, "runner-1", "ws-1", `cmd-${runId}`, now + 600_000],
      );
    }
    async function until(label: string, check: () => boolean) {
      for (let tries = 0; tries < 500; tries++) {
        if (check()) return;
        await Bun.sleep(10);
      }
      throw new Error(`Timed out waiting until ${label}`);
    }
    async function watchRunnerWait(itemId: string) {
      const waiting = () =>
        db
          .query<{ id: string; attempt: number; detail: string | null }, [string]>(
            `SELECT s.step_id AS id,s.attempt,s.detail FROM closeout_step s
             JOIN closeout_progress p ON p.id=s.progress_id WHERE p.item_id=? AND s.state='running'`,
          )
          .all(itemId);
      const thoughts = () =>
        listOutbox(db).filter((row) => (row.payload as { body?: string }).body === waitReason)
          .length;
      await until("the waiting step shows its reason", () =>
        waiting().some((step) => step.detail === waitReason),
      );
      assert.equal(
        calls.filter((call) => call.checks).length,
        0,
        "no checks are sent to a paused runner",
      );
      await until("the team is asked about the unavailable runner", () =>
        Boolean(findOpenQuestion(db, "session")),
      );
      const question = findOpenQuestion(db, "session")!;
      assert(question.body.includes("Runner goldbox has been unavailable"), question.body);
      assert.deepEqual(question.options, ["Move to another runner", "Keep waiting"]);
      assert(
        listOutbox(db).some(
          (row) =>
            row.op === "elicitation" &&
            (row.payload as { questionId?: string }).questionId === question.id,
        ),
      );
      await orchestrator.onLinearEvent({
        dedupeKey: "activity:keep-waiting",
        deliveryId: null,
        source: "webhook",
        action: "prompted",
        sessionId: "session",
        issueId: "issue",
        activityId: "keep-waiting",
        actorId: "human-1",
        body: "Keep waiting",
        signal: null,
        updatedAtMs: Date.now() + 1_000,
        payload: "{}",
      });
      await until("the answer is recorded", () => !findOpenQuestion(db, "session"));
      assert.equal(getWorkItem(db, itemId)?.state, "verifying");
      await Bun.sleep(100);
      const held = waiting();
      assert(held.some((step) => step.detail === waitReason && step.attempt <= 1));
      assert.equal(calls.filter((call) => call.checks).length, 0);
      assert.equal(thoughts(), 1, "one Linear thought for the wait");
      runnerResumed = true;
      db.run("UPDATE runner SET status='active',last_seen_at=? WHERE id='runner-1'", [Date.now()]);
      observe("Closeout waits for a paused runner and asks after the wait limit", true, {
        steps: held,
        question: question.body,
      });
    }
    let changed = false;
    let laterDispatches = 0;
    const crashed = scenario.startsWith("crashed-");
    let verificationExclusions: readonly string[] = [];
    let exclusionsForReverify = false;
    // These scenarios check that a rebase before the merge runs Closeout again on the runner.
    const mergeSettings = "[merge]\ncloseout_after_update = true\n";
    writeFileSync(
      join(home, "config.toml"),
      `${mergeSettings}[checkout.projects."acme/fixture"]\nexclude = ["large"]\n`,
    );
    const orchestrator = attachOrchestrator({
      db,
      admission: workspaceAdmission(db),
      clock,
      jobs,
      outbox,
      pawsRoot: home,
      home,
      tracker,
      repository: { owner: "acme", repo: "fixture", remoteUrl: origin },
      ...(scenario === "success"
        ? {
            githubInstallation: {
              check: async (current: WorkItemRecord) => {
                appChecks.push({
                  currentRunId: current.currentRunId,
                  checkpoint: current.checkpoint,
                });
                return true;
              },
              identity: () => "workspace-installation-repository",
              administrators: () => [],
              recoveryUrl: "https://paws.example/status/#/settings/integrations",
            },
            repositoryToken: async () => "fixture",
          }
        : {}),
      linearTaskModes: mergeDependencyYield,
      ...(mergeDependencyYield
        ? {
            scheduling: () => ({}),
            publicationReady(itemId: string) {
              assert.equal(getLinearSession(db, "session")?.activeItemId, itemId);
              assert.equal(getWorkItem(db, "new-blocker")?.state, "completed");
              return true;
            },
          }
        : {}),
      remoteCloseoutRetry: { attempts: 2, delayMs: 0 },
      ...(runnerWait ? { runnerWait: { pollMs: 20, askAfterMs: 300 } } : {}),
      ...(merging
        ? {
            github: {
              appId: "",
              installationId: "",
              privateKeyPem: "",
              tokenProvider: {
                mode: "token" as const,
                tokenFor: async () => "fixture-github-token",
              },
              client: {
                async request(request: { method: string; path: string; body?: unknown }) {
                  if (request.path === "/graphql") {
                    const { head } = (request.body as { variables: { head: string } }).variables;
                    return { status: 200, body: fakeMergeReadiness(head) };
                  }
                  const required = fakeRequiredChecks(request);
                  if (required) return required;
                  if (request.method === "POST" && request.path.endsWith("/pulls"))
                    return {
                      status: 201,
                      body: {
                        number: 1,
                        html_url: "https://github.com/acme/fixture/pull/1",
                        body: (request.body as { body: string }).body,
                      },
                    };
                  if (request.method === "POST" && request.path.endsWith("/labels"))
                    return { status: 201, body: { name: "paws" } };
                  if (request.method === "PUT" && request.path.endsWith("/merge")) {
                    const { sha } = request.body as { sha: string };
                    await git(["-C", source, "fetch", origin, sha]);
                    await git(["-C", source, "merge", "--squash", sha]);
                    await git(["-C", source, "commit", "-m", "Fixture merge"]);
                    await git(["-C", source, "push", origin, "HEAD:main"]);
                    return {
                      status: 200,
                      body: { merged: true, sha: await git(["-C", source, "rev-parse", "HEAD"]) },
                    };
                  }
                  throw new Error(
                    `Unexpected fixture GitHub request ${request.method} ${request.path}`,
                  );
                },
              },
            },
          }
        : {}),
      launch() {
        return { command: "/forbidden-local-agent", args: [] };
      },
      remoteExecution: {
        agentForSession() {
          throw new Error("This fixture does not request a routing helper");
        },
        agentForItem(itemId) {
          return async (options: RunAgentOptions) => {
            const reviewing = options.role === "reviewer" && !options.prepareOnly;
            if (reviewing) {
              if (reverifying !== exclusionsForReverify) {
                verificationExclusions = [];
                exclusionsForReverify = reverifying;
              }
              if (verificationExclusions.length === 0) {
                verificationExclusions = [...(options.checkoutExclusions ?? [])];
                assert(verificationExclusions.length > 0);
                writeFileSync(
                  join(home, "config.toml"),
                  `${mergeSettings}[checkout.projects."acme/fixture"]\nexclude = ["changed-after-capture"]\n`,
                );
              }
              assert.deepEqual(
                [...(options.checkoutExclusions ?? [])],
                [...verificationExclusions],
              );
            }
            if (reverifying) laterDispatches++;
            const item = getWorkItem(db, itemId)!;
            assert.equal(getRun(db, item.currentRunId!)?.status, "active");
            const checks = options.runId.startsWith("checks-");
            calls.push({
              role: options.role,
              prepare: !!options.prepareOnly,
              checks,
              reverifying,
              prompt: options.prompt,
              networkGit: !!options.networkGit,
              mainSha: options.mainSha,
            });
            if (unavailable) throw new Error("fixture remote transport unavailable");
            if (checks) {
              assert.equal(options.role, "implementer");
              if (runnerWait) assert(runnerResumed, "checks wait until the runner resumes");
              assert(options.closeoutPolicy);
              if (scenario === "rebase-unreachable" && reverifying)
                throw new Error("fixture runner is offline");
              if (scenario === "rebase-rate-limited" && reverifying && rateLimited < 2) {
                rateLimited += 1;
                throw new LinearRateLimitError(0, {
                  requestsRemaining: 0,
                  requestsLimit: 5000,
                  requestsResetMs: null,
                  complexityRemaining: null,
                  complexityLimit: null,
                  complexityResetMs: null,
                  complexity: null,
                });
              }
              const head = await git(["-C", options.worktreePath, "rev-parse", "HEAD"]);
              checkedHeads.push(head);
              const script = join(home, `agent-${calls.length}.json`);
              writeFileSync(
                script,
                JSON.stringify({
                  sessionId: `session-${calls.length}`,
                  model: "fixture-implement-model",
                  steps: [{ type: "end" }],
                }),
              );
              const result = await runAgent({
                ...options,
                command: process.execPath,
                args: [join(import.meta.dir, "../../src/acp/testing/fake-agent.ts"), "", script],
                env: { PATH: process.env.PATH!, HOME: home },
              });
              if (scenario === "rebase-empty-report" && reverifying)
                return {
                  ...result,
                  closeoutReport: JSON.stringify({
                    required: [],
                    pending: [],
                    blocked: null,
                    bypassed: false,
                  }),
                };
              const failing =
                !reverifying ||
                (scenario === "rebase-failing" &&
                  calls.filter((call) => call.checks && call.reverifying).length === 1);
              return {
                ...result,
                closeoutReport: JSON.stringify({
                  required: ["prepare", "check"].map((id) => ({
                    id,
                    status: failing && id === "check" ? "failed" : "passed",
                    result: {
                      argv: ["/forbidden-local-check", id === "prepare" ? "setup" : "check"],
                      head,
                      exitCode: failing && id === "check" ? 1 : 0,
                      timedOut: false,
                      durationMs: 42,
                      timeoutSeconds: 5,
                      stdout:
                        failing && id === "check"
                          ? `RUNNER_CHECK_FAILED on ${head}\n`
                          : `runner ${id} output\n`,
                      stderr: "",
                      truncated: false,
                    },
                  })),
                  pending: [],
                  blocked: null,
                  bypassed: false,
                }),
              };
            }
            if (initialLease && !options.prepareOnly && options.role === "implementer")
              await reclaim(options.signal);
            if (
              scenario === "success" &&
              !options.prepareOnly &&
              options.role === "implementer" &&
              implementationCount === 0
            ) {
              const baseSha = await git(["-C", options.worktreePath, "rev-parse", "HEAD"]);
              const checkpoint = { phase: "running" as const, baseSha, wipCommit: baseSha };
              saveCheckpoint(db, item.id, checkpoint);
              assert(options.networkGit);
              const before = appChecks.length;
              await options.networkGit(["-C", options.worktreePath, "fetch", origin, baseSha]);
              assert(appChecks.length > before);
              for (const check of appChecks.slice(before))
                assert.deepEqual(check, { currentRunId: item.currentRunId, checkpoint });
              setCurrentRun(db, item.id, null);
              try {
                await assert.rejects(
                  options.networkGit(["-C", options.worktreePath, "fetch", origin, baseSha]),
                  /obsolete task/,
                );
              } finally {
                setCurrentRun(db, item.id, item.currentRunId);
              }
              observe(
                "candidate import revalidates the current checkpoint with the workspace App",
                true,
                {
                  itemId,
                  currentRunId: item.currentRunId,
                  baseSha,
                  appRechecks: appChecks.length - before,
                  supersededRunRejected: true,
                },
              );
            }
            const script = join(home, `agent-${calls.length}.json`);
            const reviewer = options.role === "reviewer";
            const answer = mergeDependencyYield && itemId === "new-blocker";
            if (!reviewer && !options.prepareOnly) implementationCount++;
            if (runnerWait && !reviewer && !options.prepareOnly && implementationCount === 1) {
              pauseTaskRunner(item.currentRunId!);
              runnerWatch = watchRunnerWait(item.id);
            }
            if (reverifying && reviewing) {
              assert.equal(item.state, "verifying");
              assert.notEqual(item.currentRunId, originalRunId);
              assert.equal(getRun(db, item.currentRunId!)?.kind, "recheck");
              reviewRunId = item.currentRunId!;
              if (implementationCount === 2)
                assert.deepEqual(
                  readFileSync(join(home, "runs", reviewRunId, "agent-profile.json")),
                  originalProfile,
                );
              if (scenario === "reverify-lease" || scenario === "merge-lease")
                await reclaim(options.signal);
              if (scenario === "error") throw new Error("fixture remote verification unavailable");
              if (!changed) {
                changed = true;
                if (scenario === "cancelled") applyWorkItemEvent(db, item.id, "cancel");
                if (scenario === "reassigned") {
                  const replacement = insertRun(db, {
                    itemId: item.id,
                    kind: "review",
                    status: "active",
                    now: clock.now(),
                  });
                  setCurrentRun(db, item.id, replacement.id);
                }
                if (scenario === "stale") {
                  const path = join(home, "runs", reviewRunId, "agent-profile.json");
                  const snapshot = JSON.parse(readFileSync(path, "utf8")) as {
                    candidate: { model: string };
                  };
                  snapshot.candidate.model = "unexpected-candidate";
                  writeFileSync(path, JSON.stringify(snapshot));
                }
              }
            }
            writeFileSync(
              script,
              JSON.stringify({
                sessionId: `session-${calls.length}`,
                model: reviewer ? "fixture-review-model" : "fixture-implement-model",
                steps: reviewer
                  ? [
                      {
                        type: "update",
                        update: {
                          sessionUpdate: "agent_message_chunk",
                          content: { type: "text", text: "[]" },
                        },
                      },
                      { type: "end" },
                    ]
                  : answer
                    ? [
                        {
                          type: "update",
                          update: {
                            sessionUpdate: "agent_message_chunk",
                            content: { type: "text", text: "Blocker delivered remotely." },
                          },
                        },
                        { type: "end" },
                      ]
                    : [
                        {
                          type: "fs_write",
                          path: join(options.worktreePath, "result.txt"),
                          content:
                            implementationCount === 1
                              ? `${scenario} initial\n`
                              : `${scenario} fix ${implementationCount}\n`,
                        },
                        {
                          type: "update",
                          update: {
                            sessionUpdate: "agent_message_chunk",
                            content: { type: "text", text: "PUBLIC_REMOTE_RESPONSE" },
                          },
                        },
                        { type: "end" },
                      ],
              }),
            );
            const result = await runAgent({
              ...options,
              command: process.execPath,
              args: [join(import.meta.dir, "../../src/acp/testing/fake-agent.ts"), "", script],
              env: { PATH: process.env.PATH!, HOME: home },
            });
            if (reviewer || options.prepareOnly) return result;
            return {
              ...result,
              closeoutReport: JSON.stringify(
                implementationCount > 1
                  ? {
                      required: ["prepare", "check"].map((id) => ({
                        id,
                        status: "passed",
                        result: {
                          argv: ["/forbidden-local-check", id === "prepare" ? "setup" : "check"],
                          head: result.checkpoint?.sha ?? "",
                          exitCode: 0,
                          timedOut: false,
                          durationMs: 42,
                          timeoutSeconds: 5,
                          stdout: `remote ${id} output\n`,
                          stderr: "",
                          truncated: false,
                        },
                      })),
                      pending: [],
                      blocked: null,
                      bypassed: false,
                    }
                  : { required: ["check"], pending: ["check"], blocked: null, bypassed: false },
              ),
            };
          };
        },
      },
    });
    try {
      if (mergeDependencyYield) {
        const intake = await intakeDelegatedIssue(db, tracker, {
          linearIssueId: "issue",
          now: clock.now(),
        });
        assert(intake.ok);
        ensureLinearSession(db, { sessionId: "session", issueId: "issue", now: clock.now() });
        bindLinearSessionTask(db, "session", intake.delegation.id);
      } else
        await orchestrator.onLinearEvent({
          dedupeKey: "created:issue",
          deliveryId: null,
          source: "webhook",
          action: "created",
          sessionId: "session",
          issueId: "issue",
          activityId: null,
          actorId: null,
          body: null,
          signal: null,
          updatedAtMs: Date.now(),
          payload: "{}",
        });
      if (mergeDependencyYield) {
        const queued = listWorkItems(db)[0]!;
        saveTaskMode(db, queued.id, "code", 0, true);
        bindWorkItemRepository(db, queued.id, {
          owner: "acme",
          repo: "fixture",
          remoteUrl: origin,
        });
        saveSchedulingContext(db, {
          itemId: queued.id,
          projectId: "project",
          paths: ["src/shared"],
        });
        orchestrator.reconcileExecution();
      }
      if (scenario === "resume-lease") {
        const pending = listWorkItems(db)[0]!;
        beginImplementRun(db, pending.id, clock.now(), {
          phase: "running",
          baseSha: await git(["-C", source, "rev-parse", "HEAD"]),
        });
        applyWorkItemEvent(db, pending.id, "lease_expired");
        enqueueJob(db, {
          queue: JOB_KIND.resume,
          payload: { itemId: pending.id },
          priority: -100,
          now: clock.now(),
        });
      }
      await jobs.tick();
      const item = listWorkItems(db)[0]!;
      if (initialLease) {
        assert.equal(item.state, "running");
        assert.equal(item.currentRunId, replacementRunId);
        assert.equal(getRun(db, replacementRunId)?.status, "active");
        assert.equal(getJob(db, reclaimedJobId)?.status, "running");
        assert(leaseAborted);
        assert.equal(witnessCalls, 0);
        observe(
          "selected initial transport aborts on lease loss without ending current run: " + scenario,
          true,
          { state: item.state, replacementRunId, job: getJob(db, reclaimedJobId), leaseAborted },
        );
        continue;
      }
      if (unavailable) {
        assert.equal(item.state, "awaiting_input", JSON.stringify(item));
        assert.equal(calls.length, 1);
        assert.equal(witnessCalls, 0);
      } else {
        assert.equal(item.state, "merge_queue", JSON.stringify(item));
        assert.equal(implementationCount, 2);
        assert(calls.filter((call) => call.prepare).length === 2);
        assert(calls.some((call) => call.role === "reviewer" && !call.prepare));
        const [implementation, fix] = calls.filter(
          (call) => call.role === "implementer" && !call.prepare && !call.checks,
        );
        assert(implementation && fix);
        assert(fix.prompt.includes("PUBLIC_REMOTE_RESPONSE"));
        assert(fix.prompt.includes("Write output"));
        assert.equal(calls.filter((call) => call.checks).length, 1);
        assert(fix.prompt.includes(`RUNNER_CHECK_FAILED on ${checkedHeads[0]}`), fix.prompt);
        assert.equal(fix.networkGit, implementation.networkGit);
        assert.equal(witnessCalls, 0);
      }
      assert.equal(getRun(db, item.currentRunId!)?.status, "ended");
      assert.equal(existsSync(join(home, "local-agent")), false);
      if (runnerWait) {
        await runnerWatch;
        const steps = db
          .query<{ detail: string | null }, [string]>(
            `SELECT s.detail FROM closeout_step s JOIN closeout_progress p ON p.id=s.progress_id
             WHERE p.item_id=?`,
          )
          .all(item.id);
        assert(steps.every((step) => step.detail !== waitReason));
        observe("resuming the runner continues Closeout without using an attempt", true, {
          state: item.state,
          checks: calls.filter((call) => call.checks).length,
        });
        continue;
      }
      if (!unavailable) {
        originalRunId = item.currentRunId!;
        originalProfile = readFileSync(join(home, "runs", originalRunId, "agent-profile.json"));
        let foreignRunId = originalRunId;
        if (crashed) {
          if (scenario === "crashed-review") {
            foreignRunId = insertRun(db, {
              itemId: item.id,
              kind: "review",
              status: "active",
              now: clock.now(),
            }).id;
            mkdirSync(join(home, "runs", foreignRunId), { mode: 0o700 });
            writeFileSync(join(home, "runs", foreignRunId, "agent-profile.json"), originalProfile, {
              mode: 0o600,
            });
            setCurrentRun(db, item.id, foreignRunId);
          } else markRun(db, originalRunId, "active", Date.now());
          assert.deepEqual(recoverOnStartup(db), [{ type: "reverify" }]);
          assert.equal(getWorkItem(db, item.id)?.state, "verifying");
          assert.equal(getRun(db, foreignRunId)?.status, "active");
        }
        if (mergeDependencyYield) {
          db.run(
            `INSERT INTO work_item(id,delegation_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at,session_key)
             VALUES('new-blocker',?,'new-blocker','ENG-43','New blocker','queued','paws/new-blocker',1,?,'session')`,
            [item.delegationId, clock.now()],
          );
          saveTaskMode(db, "new-blocker", "answer");
          bindWorkItemRepository(db, "new-blocker", {
            owner: "acme",
            repo: "fixture",
            remoteUrl: origin,
          });
          saveSchedulingContext(db, {
            itemId: "new-blocker",
            projectId: "project",
            paths: ["src/shared"],
          });
          db.run(
            "INSERT INTO task_block(blocker_linear_issue_id,blocked_linear_issue_id) VALUES(?,?)",
            ["new-blocker", item.linearIssueId],
          );
          const before = getLinearSession(db, "session")?.activeItemId;
          assert.equal(before, item.id);
          const deferred = await jobs.tick();
          assert.equal(deferred?.queue, JOB_KIND.merge);
          assert.equal(getWorkItem(db, item.id)?.state, "merge_queue");
          assert.equal(getLinearSession(db, "session")?.activeItemId, item.id);
          observe("The owned merge defers and joins without releasing its session early", true, {
            job: deferred?.id,
            activeItemId: before,
          });
          orchestrator.reconcileExecution();
          assert.equal(getLinearSession(db, "session")?.activeItemId, null);
          const blocker = await jobs.tick();
          assert(blocker);
          assert.equal((blocker.payload as { itemId: string }).itemId, "new-blocker");
          assert.equal(getWorkItem(db, "new-blocker")?.state, "completed");
          assert.equal(getLinearSession(db, "session")?.activeItemId, "new-blocker");
          observe(
            "The same-session blocker acquires the shared footprint and delivers through the selected remote port",
            true,
            { job: blocker?.id, state: getWorkItem(db, "new-blocker")?.state },
          );
          assert(clock instanceof FakeClock);
          clock.advance(30001);
        }
        reverifying = true;
        const accepted = item.checkpoint?.wipCommit;
        let movedMain = "";
        if (rebase) {
          writeFileSync(join(source, "other.txt"), `Another task merged before ${scenario}\n`);
          await git(["-C", source, "add", "other.txt"]);
          await git(["-C", source, "commit", "-m", "Another task"]);
          await git(["-C", source, "push", origin, "HEAD:main"]);
          movedMain = await git(["-C", source, "rev-parse", "HEAD"]);
        }
        const reverifyId = merging
          ? listJobs(db).find((job) => job.queue === JOB_KIND.merge && job.status === "pending")!.id
          : enqueueJob(db, {
              queue: JOB_KIND.reverify,
              priority: -100,
              payload: { itemId: item.id },
              now: clock.now(),
            });
        assert.equal((await jobs.tick())?.id, reverifyId);
        const verified = getWorkItem(db, item.id)!;
        if (rebase) {
          const reverifyChecks = calls.filter((call) => call.checks && call.reverifying);
          const question = findOpenQuestion(db, "session");
          const rebased = checkedHeads.at(-1);
          if (scenario === "rebase-unreachable" || scenario === "rebase-empty-report") {
            assert.equal(verified.state, "awaiting_input");
            assert.equal(reverifyChecks.length, 2);
            assert.equal(reviewRunId, "");
            assert(question);
            assert(question.body.includes("The Closeout checks could not run on the runner"));
            assert(
              question.body.includes(
                scenario === "rebase-unreachable"
                  ? "fixture runner is offline"
                  : "the runner's Closeout listed no checks",
              ),
              question.body,
            );
            assert(!question.body.includes("Checks you can bypass"), question.body);
            assert(!question.body.includes("output is missing"), question.body);
          } else {
            assert.equal(verified.state, "merged", question?.body ?? "no question");
            assert.equal(question, null);
            assert(rebased && rebased !== accepted);
            await git(["-C", source, "merge-base", "--is-ancestor", movedMain, rebased]);
            assert.equal(reverifyChecks.length, scenario === "rebase-rate-limited" ? 3 : 1);
            assert.deepEqual(
              db
                .query<{ payload: string }, []>("SELECT payload FROM outbox")
                .all()
                .filter((row) => row.payload.includes("rate-limiting")),
              [],
            );
            assert.equal(reverifyChecks.at(-1)!.mainSha, movedMain);
            assert.notEqual(reviewRunId, "");
            if (scenario === "rebase-failing") {
              const fixes = calls.filter(
                (call) =>
                  call.reverifying && call.role === "implementer" && !call.checks && !call.prepare,
              );
              assert.equal(fixes.length, 1);
              assert(fixes[0]!.prompt.includes(`RUNNER_CHECK_FAILED on ${rebased}`));
              assert.equal(implementationCount, 3);
            } else assert.equal(implementationCount, 2);
          }
          observe(`remote rebase before merge runs the checks on the runner: ${scenario}`, true, {
            accepted,
            rebased,
            state: verified.state,
            checks: reverifyChecks.length,
          });
        } else if (scenario === "reverify-lease" || scenario === "merge-lease") {
          assert(leaseAborted);
          assert.equal(verified.currentRunId, replacementRunId);
          assert.equal(verified.state, "verifying");
          assert.equal(getRun(db, replacementRunId)?.status, "active");
          assert.equal(getRun(db, reviewRunId)?.status, "ended");
          assert.equal(getJob(db, reclaimedJobId)?.status, "running");
          observe(
            "selected verification transport aborts on job reclaim without accepting stale result: " +
              scenario,
            true,
            {
              state: verified.state,
              replacementRunId,
              reviewRunId,
              job: getJob(db, reclaimedJobId),
              leaseAborted,
            },
          );
        } else if (crashed) {
          assert.equal(laterDispatches, 0);
          assert.equal(reviewRunId, "");
          assert.equal(verified.currentRunId, foreignRunId);
          assert.equal(verified.state, "verifying");
          assert.equal(getRun(db, foreignRunId)?.status, "active");
          assert.equal(witnessCalls, 0);
          assert.equal(listRuns(db, item.id).length, scenario === "crashed-review" ? 2 : 1);
          assert.equal(listJobs(db).find((job) => job.id === reverifyId)?.status, "pending");
          observe(
            "persisted foreign active lifetime is refused after startup recovery: " + scenario,
            true,
            {
              foreignRunId,
              state: verified.state,
              status: getRun(db, foreignRunId)?.status,
              laterDispatches,
            },
          );
        } else {
          assert.notEqual(reviewRunId, "");
          assert.equal(getRun(db, reviewRunId)?.status, "ended");
          assert.equal(getRun(db, originalRunId)?.status, "ended");
          if (scenario === "success" || scenario === "merge" || scenario === "merge-lease") {
            assert.equal(
              listJobs(db).find((job) => job.id === reverifyId)?.status,
              "done",
              JSON.stringify(listJobs(db).find((job) => job.id === reverifyId)),
            );
            assert.equal(
              verified.state,
              scenario === "merge" || scenario === "merge-lease" ? "merged" : "merge_queue",
            );
            assert(laterDispatches > 0);
            assert.equal(witnessCalls, 0);
            assert.deepEqual(
              readFileSync(join(home, "runs", reviewRunId, "agent-profile.json")),
              originalProfile,
            );
          } else if (scenario === "error") assert.equal(verified.state, "awaiting_input");
          else if (scenario === "cancelled") assert.equal(verified.state, "cancelled");
          else {
            assert.equal(verified.state, "verifying");
            if (scenario === "reassigned") {
              assert.notEqual(verified.currentRunId, reviewRunId);
              assert.equal(getRun(db, verified.currentRunId!)?.status, "active");
            }
          }
          if (mergeDependencyYield) {
            assert.equal(getLinearSession(db, "session")?.activeItemId, item.id);
            observe(
              "The original merge reacquires its canonical session and completes a verified local squash merge",
              true,
              {
                state: verified.state,
                head: await git(["--git-dir", origin, "rev-parse", "main"]),
              },
            );
          }
          assert.equal(listRuns(db, item.id).length, scenario === "reassigned" ? 3 : 2);
          observe(
            `later remote reverify preserves candidate and owns only its lifetime: ${scenario}`,
            true,
            {
              originalRunId,
              reviewRunId,
              currentRunId: verified.currentRunId,
              state: verified.state,
              jobStatus: listJobs(db).find((job) => job.id === reverifyId)?.status,
              laterDispatches,
              witnessCalls,
            },
          );
        }
      }
      observe(
        unavailable
          ? "unavailable remote preparation blocks without local fallback"
          : "Linear orchestration routes preparation, implementation, fixes and reviews through the selected port and accepts command checks from the session report",
        true,
        {
          state: item.state,
          agentCalls: calls.map(({ role, prepare }) => ({ role, prepare })),
          witnessCalls,
          transport: "recording port with real scripted ACP, Git and SQLite",
        },
      );
    } finally {
      releaseReplacement?.();
      await replacementTick;
      await orchestrator.shutdown();
      db.close();
    }
  }
}
