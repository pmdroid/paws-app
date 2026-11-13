import { and, eq, isNotNull, isNull } from "drizzle-orm";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAgent, type RunAgentResult } from "../../src/acp";
import { WORK_ITEM_STATES, TERMINAL_WORK_ITEM_STATES, systemClock } from "../../src/core";
import {
  applyWorkItemEvent,
  bindWorkItemRepository,
  enqueueJob,
  getWorkItem,
  JobLoop,
  OutboxDispatcher,
  type Db,
  type Q,
} from "../../src/db";
import { createExecutionControls } from "../../src/execution-controls";
import { createLinearMembershipReads } from "../../src/linear";
import { Orchestrator, type OrchestratorOptions } from "../../src/loop";
import { openQuestion } from "../../src/questions";
import { createRemoteAgentRunner } from "../../src/runner-backend";
import { initializeRunnerCoordinator, openRunnerCoordinator } from "../../src/runner-coordinator";
import { openRunnerDaemon } from "../../src/runner-daemon";
import { startServer } from "../../src/server";
import { createWorkspaceAccess, type WorkspaceAccess } from "../../src/workspace";
import { createExecutionControlsFixturePg } from "./execution-controls";

function write(db: Db, query: (q: Q) => PromiseLike<unknown>) {
  return db.run((q) => q.exec(query(q)));
}

async function until(predicate: () => boolean | Promise<boolean>, message: string, timeout = 5000) {
  const deadline = performance.now() + timeout;
  while (!(await predicate())) {
    assert(performance.now() < deadline, message);
    await Bun.sleep(5);
  }
}

async function remoteFixture(
  fixture: Awaited<ReturnType<typeof createExecutionControlsFixturePg>>,
  root: string,
  state: "running" | "awaiting_input" | "verifying",
) {
  const { db, runId } = fixture;
  const key = join(root, "server.key");
  const cert = join(root, "server.pem");
  const generated = Bun.spawnSync(
    [
      "/usr/bin/openssl",
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-config",
      "/dev/null",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { stdout: "ignore", stderr: "pipe", env: { PATH: "/usr/bin:/bin", HOME: root } },
  );
  assert.equal(generated.exitCode, 0, generated.stderr.toString());
  const tls = { key: readFileSync(key, "utf8"), cert: readFileSync(cert, "utf8") };
  const issuer = join(root, "issuer");
  await initializeRunnerCoordinator(issuer);
  const coordinator = await openRunnerCoordinator({
    eventKey: Buffer.alloc(32, 7),
    db,
    root: issuer,
    tls,
    port: 0,
    onError(error) {
      throw error;
    },
  });
  const enrollment = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls,
    fetch: (request) => coordinator.hostEnrollment(request),
  });
  const daemon = openRunnerDaemon({
    root: join(root, "daemon"),
    controlPlaneUrl: `https://localhost:${enrollment.port}`,
    runnerApiUrl: `https://localhost:${coordinator.port}`,
    serverCa: tls.cert,
    allowedRepositories: ["fixture/allowed"],
  });
  const abort = new AbortController();
  let execution: Promise<RunAgentResult> | undefined;
  let joined = false;
  let ready = false;
  let beforeAck: (() => void) | undefined;
  const acknowledgements: { id: string; acknowledgedAt: number; joinedBeforeAck: boolean }[] = [];
  const polling = new AbortController();
  let loop: Promise<void> | undefined;
  try {
    const enrollmentGrant = await coordinator.control.createEnrollment(
      {
        workspaceId: "workspace",
        userId: "admin",
        role: "admin",
        teamIds: [],
        authenticatedAt: Date.now(),
      },
      { name: `Stop ${state}` },
    );
    const enrolled = await daemon.enroll(`Stop ${state}`, enrollmentGrant.token);
    if (enrolled.phase !== "paired") throw new Error("Runner enrollment failed");
    const { runnerId } = enrolled;
    await write(db, (q) =>
      q.orm.update(q.t.runner).set({ status: "active" }).where(eq(q.t.runner.id, runnerId)),
    );
    await daemon.heartbeat();
    const repository = {
      owner: "fixture",
      repo: "allowed",
      remoteUrl: "https://github.com/fixture/allowed.git",
      baseSha: "a".repeat(40),
    };
    await bindWorkItemRepository(db, "controlled", repository);
    if (state === "verifying")
      await write(db, (q) =>
        q.orm.update(q.t.run).set({ kind: "review" }).where(eq(q.t.run.id, runId)),
      );
    await coordinator.work.assign({
      id: randomUUID(),
      type: state === "verifying" ? "review" : "run",
      runnerId,
      workspaceId: "workspace",
      runId,
      itemId: "controlled",
      generation: 1,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      repository,
      profile: { agent: "claude", model: "fixture-model" },
      prompt: "Wait for the selected Stop verification.",
    });
    const script = join(root, "agent-script.json");
    const result = join(root, "agent-result.json");
    writeFileSync(
      script,
      JSON.stringify({
        model: "fixture-model",
        steps:
          state === "awaiting_input"
            ? [{ type: "ask_team", question: "Continue the selected item?" }, { type: "hang" }]
            : [
                {
                  type: "update",
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: "Ready to stop." },
                  },
                },
                { type: "hang" },
              ],
      }),
    );
    const worktree = join(root, "agent-work");
    mkdirSync(worktree, { mode: 0o700 });
    loop = (async () => {
      while (!polling.signal.aborted) {
        const commands = (await daemon.pollCommands()).commands;
        for (const command of commands) {
          if ((command.type === "run" || command.type === "review") && !execution) {
            await daemon.acknowledgeCommand(command.id);
            execution = runAgent({
              command: process.execPath,
              args: [join(import.meta.dir, "../../src/acp/testing/fake-agent.ts"), result, script],
              env: { PATH: process.env["PATH"], HOME: root },
              home: root,
              pawsRoot: join(root, "agent-paws"),
              worktreePath: worktree,
              itemId: "controlled",
              runId,
              profile: command.profile,
              role: command.type === "review" ? "reviewer" : "implementer",
              readOnly: command.type === "review",
              prompt: command.prompt,
              signal: abort.signal,
              onEvent(event) {
                if (event.type === "session_update") ready = true;
              },
              askTeam: {
                async ask(request, context) {
                  await applyWorkItemEvent(db, "controlled", "blocking_question");
                  await openQuestion(db, {
                    itemId: "controlled",
                    runId,
                    sessionId: "session-controlled",
                    body: request.question,
                  });
                  ready = true;
                  await new Promise<void>((_, reject) => {
                    context.signal.addEventListener("abort", () => reject(context.signal.reason), {
                      once: true,
                    });
                  });
                  throw new Error("Question did not stop");
                },
              },
            }).finally(() => {
              joined = true;
            });
            void execution.catch(() => undefined);
          }
          if (command.type === "cancel") {
            abort.abort(new Error("Selected remote Stop"));
            const stopped = await execution;
            assert(stopped?.cancelled);
            assert(stopped.agentExited);
            assert.equal(stopped.errorMessage, undefined);
            assert(joined);
            const trace = JSON.parse(readFileSync(result, "utf8")) as { methods: string[] };
            assert(trace.methods.includes("session/cancel"));
            await Bun.sleep(40);
            beforeAck?.();
            await daemon.acknowledgeCommand(command.id);
            const row = await db.run((q) =>
              q.one(
                q.orm
                  .select({ acknowledgedAt: q.t.runnerCommand.acknowledgedAt })
                  .from(q.t.runnerCommand)
                  .where(eq(q.t.runnerCommand.id, command.id)),
              ),
            );
            assert.equal(typeof row?.acknowledgedAt, "number");
            acknowledgements.push({
              id: command.id,
              acknowledgedAt: row!.acknowledgedAt!,
              joinedBeforeAck: joined,
            });
          }
        }
        await Bun.sleep(5);
      }
    })();
    void loop.catch(() => undefined);
    await until(
      async () =>
        ready &&
        (state !== "awaiting_input" ||
          (await getWorkItem(db, "controlled"))!.state === "awaiting_input"),
      "Remote ACP did not become ready",
    );
    const backend = createRemoteAgentRunner({
      store: db,
      work: coordinator.work,
      results: coordinator.results,
      health: coordinator.health,
      pollIntervalMs: 5,
      async fetchCandidate() {
        throw new Error("Stop must not import a candidate");
      },
    });
    return {
      cancelItem: backend.cancelItem,
      acknowledgements,
      beforeAck(callback: () => void) {
        beforeAck = callback;
      },
      async close() {
        polling.abort();
        abort.abort();
        await execution?.catch(() => undefined);
        await loop;
        daemon.close();
        await enrollment.stop(true);
        await coordinator.stop();
      },
    };
  } catch (error) {
    polling.abort();
    abort.abort();
    await execution?.catch(() => undefined);
    await loop?.catch(() => undefined);
    daemon.close();
    await enrollment.stop(true);
    await coordinator.stop();
    throw error;
  }
}

export async function probeExecutionStopStates(root: string) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const observations: { name: string; passed: boolean; observed: unknown }[] = [];
  const states = WORK_ITEM_STATES.filter(
    (state) => !(TERMINAL_WORK_ITEM_STATES as readonly string[]).includes(state),
  );
  for (const state of states) {
    const directory = join(root, state);
    const fixture = await createExecutionControlsFixturePg(directory);
    const { db } = fixture;
    let remote: Awaited<ReturnType<typeof remoteFixture>> | undefined;
    let orchestrator: Orchestrator | undefined;
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    let access: WorkspaceAccess | undefined;
    try {
      await write(db, (q) =>
        q.orm
          .update(q.t.workItem)
          .set({ state: state === "awaiting_input" ? "running" : state })
          .where(eq(q.t.workItem.id, "controlled")),
      );
      if (!["running", "verifying", "awaiting_input"].includes(state))
        await write(db, (q) =>
          q.orm.update(q.t.run).set({ status: "ended" }).where(eq(q.t.run.id, fixture.runId)),
        );
      if (state === "running" || state === "awaiting_input" || state === "verifying")
        remote = await remoteFixture(fixture, directory, state);
      const options: OrchestratorOptions = {
        store: db,
        clock: systemClock,
        jobs: new JobLoop(db, systemClock),
        outbox: new OutboxDispatcher(db, systemClock),
        pawsRoot: directory,
        scheduling: async () => ({}),
        ...(remote
          ? {
              remoteExecution: {
                cancelItem: remote.cancelItem,
                agentForSession() {
                  throw new Error("Unexpected helper dispatch");
                },
                agentForItem() {
                  throw new Error("Unexpected item dispatch");
                },
              },
            }
          : {}),
      };
      orchestrator = new Orchestrator(options);
      const controls = createExecutionControls({
        db,
        bus: orchestrator.bus,
        getPort: () => orchestrator!,
      });
      const ready = Promise.withResolvers<WorkspaceAccess>();
      server = startServer({
        hostname: "127.0.0.1",
        port: 0,
        db,
        webhooks: false,
        statusEnv: {},
        workspaceAccess: ready.promise,
        executionControls: controls.handle,
      });
      const origin = `http://127.0.0.1:${server.port}`;
      access = createWorkspaceAccess({
        store: db,
        publicUrl: origin,
        clientId: "client",
        installedOrganization: { id: "org", name: "Stop states" },
        memberships: createLinearMembershipReads({
          async query() {
            throw new Error("Unexpected hosted membership call");
          },
        }),
      });
      ready.resolve(access);
      const pending = await enqueueJob(db, {
        queue: state === "merge_queue" ? "github.merge" : "run.resume",
        payload: { itemId: "controlled" },
      });
      const unrelated = (await getWorkItem(db, "other"))!;
      const branch = (await getWorkItem(db, "controlled"))!.branchName;
      const openQuestions = () =>
        db.run((q) =>
          q.all(
            q.orm
              .select({ id: q.t.question.id })
              .from(q.t.question)
              .where(and(eq(q.t.question.itemId, "controlled"), isNull(q.t.question.cancelledAt))),
          ),
        );
      const initialQuestions = await openQuestions();
      if (state === "awaiting_input")
        assert(initialQuestions.length > 0, "The waiting state must own its canonical question");
      let returned = false;
      remote?.beforeAck(() =>
        assert.equal(returned, false, "HTTP Stop returned before persisted remote ACK"),
      );
      const initialState = (await getWorkItem(db, "controlled"))!.state;
      assert.equal(initialState, state, "Stop must begin in the claimed canonical state");
      const started = performance.now();
      const response = await fetch(`${origin}/api/execution-controls`, {
        method: "POST",
        headers: { ...fixture.headers(), origin },
        body: JSON.stringify({ itemId: "controlled", action: "stop" }),
        signal: AbortSignal.timeout(9000),
      }).then((value) => {
        returned = true;
        return value;
      });
      const elapsedMs = performance.now() - started;
      assert.equal(response.status, 200, await response.text());
      assert(elapsedMs < 10_000);
      assert.equal((await getWorkItem(db, "controlled"))!.state, "cancelled");
      assert.equal((await getWorkItem(db, "controlled"))!.branchName, branch);
      assert.deepEqual(await getWorkItem(db, "other"), unrelated);
      assert.deepEqual(await openQuestions(), []);
      const job = await db.run((q) =>
        q.one(
          q.orm.select({ status: q.t.job.status }).from(q.t.job).where(eq(q.t.job.id, pending)),
        ),
      );
      assert.equal(job!.status, "cancelled");
      if (state === "merge_queue")
        assert(
          await db.run((q) =>
            q.one(
              q.orm
                .select({ id: q.t.job.id })
                .from(q.t.job)
                .where(
                  and(eq(q.t.job.queue, "github.close_stopped"), eq(q.t.job.status, "pending")),
                ),
            ),
          ),
        );
      const withdrawn = await db.run((q) =>
        q.all(
          q.orm
            .select({ id: q.t.question.id, cancelledAt: q.t.question.cancelledAt })
            .from(q.t.question)
            .where(eq(q.t.question.itemId, "controlled")),
        ),
      );
      const questionWithdrawn = initialQuestions.every(({ id }) =>
        Number.isInteger(withdrawn.find((row) => row.id === id)?.cancelledAt),
      );
      assert(questionWithdrawn, "Stop must withdraw those same canonical question rows");
      if (remote)
        assert(
          (await db.run((q) =>
            q.one(
              q.orm
                .select({ id: q.t.runnerCommand.id })
                .from(q.t.runnerCommand)
                .innerJoin(q.t.run, eq(q.t.run.id, q.t.runnerCommand.runId))
                .where(
                  and(
                    eq(q.t.run.itemId, "controlled"),
                    eq(q.t.runnerCommand.kind, "cancel"),
                    isNotNull(q.t.runnerCommand.acknowledgedAt),
                  ),
                ),
            ),
          )) !== undefined,
          "Stop must return after the persisted remote cancel acknowledgement",
        );
      observations.push({
        name: `Selected Stop from ${state} joins within ten seconds and preserves unrelated work`,
        passed: true,
        observed: {
          initialState,
          finalState: "cancelled",
          elapsedMs,
          branchPreserved: true,
          unrelatedPreserved: true,
          initialQuestions: initialQuestions.map(({ id }) => id),
          questionWithdrawn,
          oldJobCancelled: true,
          remoteAcknowledgements: remote?.acknowledgements ?? [],
        },
      });
      writeFileSync(join(root, "observations.json"), JSON.stringify(observations, null, 2));
    } finally {
      await server?.stop(true);
      await access?.stop();
      await remote?.close();
      await orchestrator?.shutdown();
      await fixture.close();
    }
  }
  return observations;
}

if (import.meta.main) {
  const root = process.argv[2];
  assert(root, "Provide a disposable evidence directory");
  const observations = await probeExecutionStopStates(root);
  console.log(JSON.stringify({ root, observations: observations.length }));
}
