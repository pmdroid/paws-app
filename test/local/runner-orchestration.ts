import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  listWorkItems,
  migrate,
  markRun,
  recoverOnStartup,
  openDatabase,
} from "../../src/db";
import { createFakeTracker } from "../../src/linear";
import { fakeMergeReadiness } from "../../src/github";
import { attachOrchestrator } from "../../src/loop";

export async function probeRunnerOrchestration(
  root: string,
  observe: (name: string, passed: boolean, value: unknown) => void,
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
  for (const scenario of [
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
  ]) {
    const unavailable = scenario === "unavailable";
    const home = join(root, scenario);
    mkdirSync(home, { mode: 0o700 });
    const db = openDatabase(join(home, "paws.db"));
    migrate(db);
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
    const clock = leaseScenario ? new FakeClock(Date.now()) : systemClock;
    const jobs = new JobLoop(db, clock, leaseScenario ? { leaseMs: 300 } : {});
    const outbox = new OutboxDispatcher(db, systemClock);
    const calls: { role: string; prepare: boolean; prompt: string }[] = [];
    const checks: { argv: string[]; active: boolean }[] = [];
    let commandCount = 0;
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
        replacementRunId = listWorkItems(db)[0]!.currentRunId!;
      } else {
        await Promise.race([
          started,
          Bun.sleep(2000).then(() => {
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
        Bun.sleep(2000).then(() => {
          throw new Error("Lease loss did not abort selected transport");
        }),
      ]);
      leaseAborted = signal.aborted;
      assert(leaseAborted);
    }
    let changed = false;
    let laterDispatches = 0;
    const crashed = scenario.startsWith("crashed-");
    const orchestrator = attachOrchestrator({
      db,
      clock,
      jobs,
      outbox,
      pawsRoot: home,
      home,
      tracker,
      repository: { owner: "acme", repo: "fixture", remoteUrl: origin },
      ...(scenario === "merge" || scenario === "merge-lease"
        ? {
            github: {
              appId: "",
              installationId: "",
              privateKeyPem: "",
              tokenProvider: {
                mode: "oauth" as const,
                tokenFor: async () => "fixture-github-token",
              },
              client: {
                async request(request: { method: string; path: string; body?: unknown }) {
                  if (request.path === "/graphql") {
                    const { head } = (request.body as { variables: { head: string } }).variables;
                    return { status: 200, body: fakeMergeReadiness(head) };
                  }
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
        agentForItem(itemId) {
          return async (options: RunAgentOptions) => {
            if (reverifying) laterDispatches++;
            const item = getWorkItem(db, itemId)!;
            assert.equal(getRun(db, item.currentRunId!)?.status, "active");
            calls.push({
              role: options.role,
              prepare: !!options.prepareOnly,
              prompt: options.prompt,
            });
            if (unavailable) throw new Error("fixture remote transport unavailable");
            if (initialLease && !options.prepareOnly && options.role === "implementer")
              await reclaim(options.signal);
            const script = join(home, `agent-${calls.length}.json`);
            const reviewer = options.role === "reviewer";
            if (!reviewer && !options.prepareOnly) implementationCount++;
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
                  : [
                      {
                        type: "fs_write",
                        path: join(options.worktreePath, "result.txt"),
                        content: implementationCount === 1 ? "initial\n" : "fixed\n",
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
            return runAgent({
              ...options,
              command: process.execPath,
              args: [join(import.meta.dir, "../../src/acp/testing/fake-agent.ts"), "", script],
              env: { PATH: process.env.PATH!, HOME: home },
            });
          };
        },
        closeoutForItem(itemId, signal) {
          return {
            async runLogged(request) {
              if (reverifying) laterDispatches++;
              const item = getWorkItem(db, itemId)!;
              const active = getRun(db, item.currentRunId!)?.status === "active";
              assert.equal(active, true);
              assert.equal(
                await git(["-C", request.cwd, "rev-parse", "HEAD"]),
                request.expectedHead,
              );
              if (reverifying) {
                assert.equal(item.state, "verifying");
                assert.notEqual(item.currentRunId, originalRunId);
                assert.equal(getRun(db, item.currentRunId!)?.kind, "review");
                reviewRunId = item.currentRunId!;
                assert.deepEqual(
                  readFileSync(join(home, "runs", reviewRunId, "agent-profile.json")),
                  originalProfile,
                );
                if (scenario === "reverify-lease" || scenario === "merge-lease")
                  await reclaim(signal);
                if (scenario === "error")
                  throw new Error("fixture remote verification unavailable");
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
                    const snapshot = JSON.parse(readFileSync(path, "utf8"));
                    snapshot.candidate.model = "unexpected-candidate";
                    writeFileSync(path, JSON.stringify(snapshot));
                  }
                }
              }
              checks.push({ argv: request.argv, active });
              if (request.argv[1] === "check") commandCount++;
              const bytes = Buffer.from("Recorded remote execution\n");
              mkdirSync(join(request.logFile, ".."), { recursive: true });
              writeFileSync(request.logFile, bytes, { mode: 0o600, flag: "wx" });
              return {
                argv: request.argv,
                exitCode: request.argv[1] === "check" && commandCount === 1 ? 1 : 0,
                timedOut: false,
                dirty: false,
                headMoved: false,
                durationMs: 1,
                truncated: false,
                artifacts: [
                  {
                    path: request.artifactPath,
                    sha256: createHash("sha256").update(bytes).digest("hex"),
                  },
                ],
              };
            },
          };
        },
      },
    });
    try {
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
        assert.equal(checks.length, 0);
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
        assert.equal(checks.length, 0);
      } else {
        assert.equal(item.state, "merge_queue", JSON.stringify(item));
        assert.equal(implementationCount, 2);
        assert(calls.filter((call) => call.prepare).length === 2);
        assert(calls.some((call) => call.role === "reviewer" && !call.prepare));
        const fix = calls.filter((call) => call.role === "implementer" && !call.prepare)[1]!;
        assert(fix.prompt.includes("PUBLIC_REMOTE_RESPONSE"));
        assert(fix.prompt.includes("Write output"));
        assert(checks.length >= 3);
      }
      assert.equal(getRun(db, item.currentRunId!)?.status, "ended");
      assert.equal(existsSync(join(home, "local-agent")), false);
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
        reverifying = true;
        const priorChecks = checks.length;
        const reverifyId =
          scenario === "merge" || scenario === "merge-lease"
            ? listJobs(db).find((job) => job.queue === JOB_KIND.merge)!.id
            : enqueueJob(db, {
                queue: JOB_KIND.reverify,
                priority: -100,
                payload: { itemId: item.id },
                now: clock.now(),
              });
        assert.equal((await jobs.tick())?.id, reverifyId);
        const verified = getWorkItem(db, item.id)!;
        if (scenario === "reverify-lease" || scenario === "merge-lease") {
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
          assert.equal(checks.length, priorChecks);
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
            assert(checks.length > priorChecks);
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
              priorChecks,
              checks: checks.length,
            },
          );
        }
      }
      observe(
        unavailable
          ? "unavailable remote preparation blocks without local fallback"
          : "Linear orchestration routes preparation, implementation, fixes, reviews and commands through selected execution ports",
        true,
        {
          state: item.state,
          agentCalls: calls.map(({ role, prepare }) => ({ role, prepare })),
          commandCalls: checks,
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
