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
import { createExecutionControlsFixture } from "./execution-controls";

async function until(predicate: () => boolean, message: string, timeout = 5000) {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    assert(performance.now() < deadline, message);
    await Bun.sleep(5);
  }
}

async function remoteFixture(
  fixture: ReturnType<typeof createExecutionControlsFixture>,
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
    fetch: (request) => coordinator.enrollment(request),
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
    const pairing = await daemon.beginPairing(`Stop ${state}`);
    assert(pairing.phase === "pending");
    const { runnerId } = await coordinator.control.approvePairing(
      {
        workspaceId: "workspace",
        userId: "owner",
        role: "owner",
        teamIds: [],
        authenticatedAt: Date.now(),
      },
      pairing.code,
    );
    assert.equal((await daemon.pollPairing()).phase, "paired");
    await daemon.heartbeat();
    const repository = {
      owner: "fixture",
      repo: "allowed",
      remoteUrl: "https://github.com/fixture/allowed.git",
      baseSha: "a".repeat(40),
    };
    bindWorkItemRepository(db, "controlled", repository);
    if (state === "verifying") db.run("UPDATE run SET kind='review' WHERE id=?", [runId]);
    coordinator.work.assign({
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
                  applyWorkItemEvent(db, "controlled", "blocking_question");
                  openQuestion(db, {
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
            const row = db
              .query<{ acknowledgedAt: number }, [string]>(
                "SELECT acknowledged_at AS acknowledgedAt FROM runner_command WHERE id=?",
              )
              .get(command.id);
            assert.equal(typeof row?.acknowledgedAt, "number");
            acknowledgements.push({
              id: command.id,
              acknowledgedAt: row!.acknowledgedAt,
              joinedBeforeAck: joined,
            });
          }
        }
        await Bun.sleep(5);
      }
    })();
    void loop.catch(() => undefined);
    await until(
      () =>
        ready &&
        (state !== "awaiting_input" || getWorkItem(db, "controlled")!.state === "awaiting_input"),
      "Remote ACP did not become ready",
    );
    const backend = createRemoteAgentRunner({
      db,
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
    const fixture = createExecutionControlsFixture(directory);
    const { db } = fixture;
    let remote: Awaited<ReturnType<typeof remoteFixture>> | undefined;
    let orchestrator: Orchestrator | undefined;
    let server: ReturnType<typeof startServer> | undefined;
    let access: WorkspaceAccess | undefined;
    try {
      db.run("UPDATE work_item SET state=? WHERE id='controlled'", [
        state === "awaiting_input" ? "running" : state,
      ]);
      if (!["running", "verifying", "awaiting_input"].includes(state))
        db.run("UPDATE run SET status='ended' WHERE id=?", [fixture.runId]);
      if (state === "awaiting_signoff")
        openQuestion(db, {
          itemId: "controlled",
          runId: fixture.runId,
          sessionId: "session-controlled",
          body: "Approve the verified evidence?",
        });
      if (state === "running" || state === "awaiting_input" || state === "verifying")
        remote = await remoteFixture(fixture, directory, state);
      const options: OrchestratorOptions = {
        db,
        clock: systemClock,
        jobs: new JobLoop(db, systemClock),
        outbox: new OutboxDispatcher(db, systemClock),
        pawsRoot: directory,
        dispatchReady() {},
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
                closeoutForItem() {
                  throw new Error("Unexpected verification dispatch");
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
        db,
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
      const pending = enqueueJob(db, {
        queue: state === "merge_queue" ? "github.merge" : "run.resume",
        payload: { itemId: "controlled" },
      });
      const unrelated = getWorkItem(db, "other")!;
      const branch = getWorkItem(db, "controlled")!.branchName;
      const initialQuestions = db
        .query<{ id: string }, []>(
          "SELECT id FROM question WHERE item_id='controlled' AND cancelled_at IS NULL",
        )
        .all();
      if (state === "awaiting_input" || state === "awaiting_signoff")
        assert(initialQuestions.length > 0, "The waiting state must own its canonical question");
      let returned = false;
      remote?.beforeAck(() =>
        assert.equal(returned, false, "HTTP Stop returned before persisted remote ACK"),
      );
      const initialState = getWorkItem(db, "controlled")!.state;
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
      assert.equal(getWorkItem(db, "controlled")!.state, "cancelled");
      assert.equal(getWorkItem(db, "controlled")!.branchName, branch);
      assert.deepEqual(getWorkItem(db, "other"), unrelated);
      assert.equal(
        db
          .query<{ n: number }, []>(
            "SELECT COUNT(*) AS n FROM question WHERE item_id='controlled' AND cancelled_at IS NULL",
          )
          .get()!.n,
        0,
      );
      assert.equal(
        db.query<{ status: string }, [number]>("SELECT status FROM job WHERE id=?").get(pending)!
          .status,
        "cancelled",
      );
      if (state === "merge_queue")
        assert(
          db
            .query("SELECT 1 FROM job WHERE queue='github.close_stopped' AND status='pending'")
            .get(),
        );
      const questionWithdrawn = initialQuestions.every(({ id }) =>
        Number.isInteger(
          db
            .query<{ cancelled_at: number | null }, [string]>(
              "SELECT cancelled_at FROM question WHERE id=?",
            )
            .get(id)?.cancelled_at,
        ),
      );
      assert(questionWithdrawn, "Stop must withdraw those same canonical question rows");
      if (remote) assert(remote.acknowledgements.length > 0);
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
