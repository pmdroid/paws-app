import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginImplementRun,
  bindLinearSessionTask,
  bindWorkItemRepository,
  claimRun,
  closeExpiredRunnerLeases,
  consumeWorkspaceBootstrap,
  getWorkItem,
  heartbeatInstance,
  insertQueuedItem,
  openDatabase,
  prepareShutdown,
  putWorkspaceUser,
  recordLinearInstallation,
  recoverOnStartup,
  registerInstance,
  runnerHasCapacity,
  stopInstance,
  updateRunnerStatus,
  sqliteDb,
} from "../src/db";
import { createRunnerControl } from "../src/runner-control";
import { RunnerRequestError } from "../src/runner-daemon";
import { createRunnerKey, initializeRunnerAuthority } from "../src/runner-identity";
import {
  RUNNER_AUTHORITY_STOP_MS,
  RUNNER_LEASE_GRACE_MS,
  RUNNER_OFFLINE_BUDGET_MS,
  type RunnerCommand,
  type RunnerResult,
} from "../src/runner-protocol";
import { createRunnerResults } from "../src/runner-results";
import { openRunnerRuntime } from "../src/runner-runtime";
import { createRunnerWork, runnerFailureStatus } from "../src/runner-work";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../src/workspace";
import { migratedDatabase } from "./helpers";

const MINUTE = 60_000;
const STEP = 15_000;
const linuxUser =
  process.platform === "linux" && process.getuid!() !== 0 && process.getgid!() !== 0;

const repository = {
  owner: "fixture",
  repo: "repository",
  remoteUrl: "https://github.com/fixture/repository.git",
  baseSha: "a".repeat(40),
};

async function fixture(options: { skewMs?: number; expiresInMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "paws-offline-authority-"));
  const path = join(root, "paws.db");
  const clock = { at: Date.now(), monotonic: 0 };
  const pawsNow = () => clock.at;
  let db = migratedDatabase(path);
  const userId = await putWorkspaceUser(sqliteDb(db), {
    id: workspaceId(),
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const workspace = await consumeWorkspaceBootstrap(sqliteDb(db), {
    id: workspaceId(),
    organizationId: "org",
    name: "Fixture",
    userId,
    tokenHash: workspaceTokenHash(await issueWorkspaceBootstrap(db, "org", pawsNow())),
    now: pawsNow(),
  });
  db.run("INSERT INTO workspace_repository VALUES(?,?,?)", [
    workspace.id,
    "fixture/repository",
    "team",
  ]);
  const issuer = join(root, "issuer");
  const control = createRunnerControl({
    db,
    authority: await initializeRunnerAuthority(issuer),
    certificateRoot: issuer,
    disconnect() {},
    now: pawsNow,
  });
  const pending = { name: "Runner", csr: (await createRunnerKey(join(root, "client"))).csr };
  const { runnerId } = await control.enroll({
    ...pending,
    token: (
      await control.createEnrollment(
        {
          workspaceId: workspace.id,
          userId,
          role: "admin",
          authenticatedAt: pawsNow(),
          teamIds: [],
        },
        pending,
      )
    ).token,
  });
  db.run("UPDATE runner SET status='active' WHERE id=?", [runnerId]);
  db.run(
    "INSERT INTO runner_host_status(runner_id,runner_version,reported_at) VALUES(?,'0.1.59',?)",
    [runnerId, pawsNow()],
  );
  const item = insertQueuedItem(db, { id: "item", now: pawsNow(), sessionKey: "session" });
  const { run } = await beginImplementRun(sqliteDb(db), item.id, pawsNow());
  await recordLinearInstallation(sqliteDb(db), {
    organizationId: "org",
    oauthClientId: "app",
    appUserId: "app-user",
    sessionId: "session",
    teamId: "team",
    observedAtMs: pawsNow(),
  });
  await bindLinearSessionTask(sqliteDb(db), "session", item.delegationId, { actorId: "owner" });
  await bindWorkItemRepository(sqliteDb(db), item.id, repository);
  const start = async () =>
    await registerInstance(sqliteDb(db), {
      role: "all",
      host: "acme",
      version: null,
      now: pawsNow(),
    });
  let instance = await start();
  await claimRun(sqliteDb(db), run.id, instance.id);
  const keys = generateKeyPairSync("ed25519");
  const open = () => {
    const work = createRunnerWork({
      db,
      keyId: "fixture",
      privateKey: keys.privateKey,
      eventKey: Buffer.alloc(32, 7),
      now: pawsNow,
    });
    return { work, results: createRunnerResults({ db, work, now: pawsNow }) };
  };
  let paws = open();
  const command = (generation: number): Extract<RunnerCommand, { type: "run" }> => ({
    type: "run",
    id: workspaceId(),
    runnerId,
    workspaceId: workspace.id,
    issuedAt: pawsNow(),
    expiresAt: pawsNow() + (options.expiresInMs ?? 4 * 60 * MINUTE),
    runId: run.id,
    itemId: item.id,
    generation,
    repository,
    profile: { agent: "codex", model: "scripted" },
    prompt: "Fixture",
  });
  const first = command(1);
  await paws.work.assign(first);

  let link: "up" | "partitioned" | "revoked" | "paws-down" = "up";
  const remote = async <T>(route: string, call: () => T | Promise<T>): Promise<T> => {
    if (link === "partitioned") throw new Error(`connect ECONNREFUSED ${route}`);
    if (link === "paws-down") throw new RunnerRequestError(503, "POST", route, 1);
    if (link === "revoked")
      throw new RunnerRequestError(403, "POST", route, 1, "Runner is revoked; its work is fenced.");
    try {
      return await call();
    } catch (error) {
      throw new RunnerRequestError(
        runnerFailureStatus(error),
        "POST",
        route,
        1,
        error instanceof Error ? error.message : undefined,
      );
    }
  };

  const spool = {
    root: join(root, "spool"),
    runnerUid: process.getuid!(),
    agentGid: process.getgid!(),
  };
  const resultsDir = {
    root: join(root, "results"),
    agentUid: process.getuid!(),
    resultsGid: process.getgid!(),
  };
  for (const directory of [spool.root, resultsDir.root]) {
    mkdirSync(directory);
    chmodSync(directory, directory === resultsDir.root ? 0o770 : 0o750);
  }
  const task: RunnerCommand = {
    id: first.id,
    type: "task",
    runnerId,
    workspaceId: workspace.id,
    runId: run.id,
    itemId: item.id,
    generation: 1,
    sessionId: "session",
    sessionGeneration: 1,
    taskModeGeneration: 1,
    purpose: "answer",
    issuedAt: first.issuedAt,
    expiresAt: first.expiresAt,
    profile: { agent: "claude", model: null },
    prompt: "signed prompt",
  };
  let commands: RunnerCommand[] = [task];
  let execution = "";
  let finished = false;
  let stops = 0;
  const posted: RunnerResult[] = [];
  const refusedResults: number[] = [];
  const errors: string[] = [];
  const paired = {
    phase: "paired" as const,
    runnerId,
    workspaceId: workspace.id,
    fingerprint: "fixture",
    expiresAt: pawsNow() + 24 * 60 * MINUTE,
  };
  const runtime = await openRunnerRuntime({
    root,
    resultRetryMs: 0,
    spool,
    results: resultsDir,
    repositoryRoot: join(root, "repositories"),
    home: root,
    now: () => clock.at + (options.skewMs ?? 0),
    monotonic: () => clock.monotonic,
    onError: (error) => errors.push(error.message),
    broker: {
      async start(id) {
        execution = id;
        const directory = join(resultsDir.root, id);
        mkdirSync(directory);
        chmodSync(directory, 0o750);
        writeFileSync(join(directory, "events.jsonl"), "");
        chmodSync(join(directory, "events.jsonl"), 0o640);
        return { alreadyAdmitted: false };
      },
      async stop() {
        stops++;
      },
      alive: () => !finished && stops === 0,
    },
    daemon: {
      status: () => paired,
      async heartbeat(_skills, _runtimes, _agents, live, terminated) {
        return remote("/v1/heartbeat", () =>
          paws.work.heartbeat(
            runnerId,
            1,
            { runnerVersion: "0.1.59" },
            undefined,
            undefined,
            undefined,
            undefined,
            live,
            undefined,
            terminated,
          ),
        );
      },
      async pollCommands() {
        return remote("/v1/commands", () => ({ commands, rejected: [], deniedRepositories: [] }));
      },
      pendingCommands: () => commands,
      async acknowledgeCommand(id) {
        await remote("/v1/commands/ack", () => paws.work.acknowledge(runnerId, id));
        commands = commands.filter((entry) => entry.id !== id);
      },
      async issueRunGrant(runId, request) {
        return remote("/grant", () =>
          paws.work.issueGrant({
            runnerId,
            runId,
            commandId: request.commandId ?? first.id,
            generation: request.generation,
          }),
        );
      },
      async sendEvent() {
        return remote("/v1/events", () => ({ duplicate: false }));
      },
      async answers() {
        return remote("/answers", () => ({ answers: [] }));
      },
      async postResult(runId, generation, result, token) {
        try {
          const receipt = await remote("/result", () =>
            paws.results.submit({ runnerId, runId, generation, token, result }),
          );
          posted.push(result);
          return receipt;
        } catch (error) {
          if (error instanceof RunnerRequestError && error.status !== 503) {
            refusedResults.push(error.status);
          }
          throw error;
        }
      },
      async repositoryCredential() {
        throw new Error("Repository-free task");
      },
      async renewCertificate() {
        return paired;
      },
      async uploadArtifact() {
        return { ok: true };
      },
      async uploadTranscript(_runId, chunk) {
        return remote("/transcript", () => ({ offset: chunk.offset, duplicate: false }));
      },
      async finishTranscript() {
        return remote("/finish", () => ({ uri: "transcript" }));
      },
    },
  });
  const tick = async () => {
    await runtime.tick().catch((error: Error) => errors.push(error.message));
    await Bun.sleep(1);
  };
  const started = () => execution !== "";
  for (let index = 0; index < 400 && !started(); index++) await tick();
  if (!execution) throw new Error("The runner never started the work.");

  const replaced: number[] = [];
  const pawsStep = async () => {
    await heartbeatInstance(sqliteDb(db), instance.id, clock.at);
    if ((await closeExpiredRunnerLeases(sqliteDb(db), clock.at)).includes(run.id))
      replaced.push(clock.at);
  };
  const executing = () => stops === 0 && !finished;
  const overlaps: number[] = [];
  return {
    clock,
    runnerId,
    workspaceId: workspace.id,
    userId,
    run,
    item,
    first,
    errors,
    posted,
    refusedResults,
    replaced,
    overlaps,
    stopped: () => stops,
    executing,
    get db() {
      return db;
    },
    get paws() {
      return paws;
    },
    setLink: (next: typeof link) => (link = next),
    tick,
    async tickUntil(done: () => boolean | Promise<boolean>) {
      for (let index = 0; index < 400 && !(await done()); index++) await tick();
    },
    async advance(ms: number, pawsUp = true) {
      for (let spent = 0; spent < ms; spent += STEP) {
        const step = Math.min(STEP, ms - spent);
        clock.at += step;
        clock.monotonic += step;
        await tick();
        if (pawsUp) await pawsStep();
        if (replaced.length > 0 && executing()) overlaps.push(clock.at);
      }
    },
    leaseUntil: () =>
      db
        .query<{ lease_until: number }, [string]>(
          "SELECT lease_until FROM runner_work WHERE run_id=?",
        )
        .get(run.id)!.lease_until,
    workEnded: () =>
      db
        .query<{ ended: number | null }, [string]>(
          "SELECT ended_at AS ended FROM runner_work WHERE run_id=?",
        )
        .get(run.id)!.ended !== null,
    finish() {
      writeFileSync(
        join(resultsDir.root, execution, "result.json"),
        JSON.stringify({
          executionId: execution,
          commandId: first.id,
          run: {
            role: "implementer",
            stopReason: "end_turn",
            timedOut: false,
            cancelled: false,
            authRequired: false,
            agentExited: true,
          },
        }),
      );
      chmodSync(join(resultsDir.root, execution, "result.json"), 0o640);
      finished = true;
    },
    async pawsOutage(ms: number) {
      link = "paws-down";
      await prepareShutdown(sqliteDb(db), clock.at, undefined, instance.id);
      stopInstance(db, instance.id, clock.at);
      db.close();
      await this.advance(ms, false);
      db = openDatabase(path);
      instance = await start();
      paws = open();
      link = "up";
      return await recoverOnStartup(sqliteDb(db), clock.at, RUNNER_OFFLINE_BUDGET_MS, instance.id);
    },
    nextGeneration: () => paws.work.assign(command(2)),
    async cleanup() {
      await runtime.stop();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test.skipIf(!linuxUser)(
  "a runner partitioned while Paws stays up keeps authority and its result is accepted on a timely reconnect",
  async () => {
    const f = await fixture();
    try {
      await f.advance(STEP);
      f.setLink("partitioned");
      await f.advance(RUNNER_OFFLINE_BUDGET_MS - RUNNER_AUTHORITY_STOP_MS - 2 * STEP);
      expect(f.replaced).toEqual([]);
      expect(f.workEnded()).toBe(false);
      expect(f.executing()).toBe(true);
      expect(getWorkItem(f.db, f.item.id)?.state).toBe("running");
      await expect(f.nextGeneration()).rejects.toThrow();
      f.finish();
      f.setLink("up");
      await f.tickUntil(() => f.posted.length > 0);
      expect(f.posted.map((result) => result.stopReason)).toEqual(["end_turn"]);
      expect(f.refusedResults).toEqual([]);
      expect(f.errors.join("\n")).not.toContain("lease deadline passed");
    } finally {
      await f.cleanup();
    }
  },
  60_000,
);

test.skipIf(!linuxUser)(
  "a partition past the offline budget stops the old worker before Paws replaces it and fences its late result",
  async () => {
    const f = await fixture();
    try {
      await f.advance(STEP);
      f.setLink("partitioned");
      await f.advance(RUNNER_OFFLINE_BUDGET_MS + 2 * STEP);
      expect(f.replaced).toHaveLength(1);
      expect(f.overlaps).toEqual([]);
      expect(f.stopped()).toBe(1);
      expect(f.errors.join("\n")).toContain("lease deadline passed");
      expect(getWorkItem(f.db, f.item.id)?.state).toBe("recovering");
      f.finish();
      f.setLink("up");
      await f.tickUntil(() => f.refusedResults.length > 0 || f.posted.length > 0);
      expect(f.posted.map((result) => result.stopReason)).not.toContain("end_turn");
    } finally {
      await f.cleanup();
    }
  },
  60_000,
);

for (const skewMs of [-10 * MINUTE, 30_000]) {
  test.skipIf(!linuxUser)(
    `a runner clock ${skewMs > 0 ? "ahead" : "behind"} by ${Math.abs(skewMs) / 1000} s still stops before Paws replaces its work`,
    async () => {
      const f = await fixture({ skewMs });
      try {
        await f.advance(STEP);
        f.setLink("partitioned");
        await f.advance(RUNNER_OFFLINE_BUDGET_MS + 2 * STEP);
        expect(f.replaced).toHaveLength(1);
        expect(f.overlaps).toEqual([]);
        expect(f.stopped()).toBe(1);
      } finally {
        await f.cleanup();
      }
    },
    60_000,
  );
}

test.skipIf(!linuxUser)(
  "a command expiring inside the budget ends authority on both sides at its expiresAt",
  async () => {
    const f = await fixture({ expiresInMs: 12 * MINUTE });
    try {
      await f.advance(STEP);
      f.setLink("partitioned");
      await f.advance(12 * MINUTE + 2 * STEP);
      expect(f.replaced).toHaveLength(1);
      expect(f.replaced[0]!).toBeLessThanOrEqual(f.first.expiresAt + RUNNER_LEASE_GRACE_MS);
      expect(f.overlaps).toEqual([]);
      expect(f.stopped()).toBe(1);
    } finally {
      await f.cleanup();
    }
  },
  60_000,
);

test.skipIf(!linuxUser)(
  "a revoked runner gets no offline authority: both sides end the work at once",
  async () => {
    const f = await fixture();
    try {
      await f.advance(STEP);
      await updateRunnerStatus(sqliteDb(f.db), {
        runnerId: f.runnerId,
        workspaceId: f.workspaceId,
        userId: f.userId,
        status: "revoked",
        now: f.clock.at,
      });
      f.setLink("revoked");
      await f.advance(STEP);
      expect(f.replaced).toHaveLength(1);
      await f.tickUntil(() => f.stopped() > 0);
      expect(f.stopped()).toBe(1);
      expect(f.errors.join("\n")).toContain("fenced by Paws");
      expect(f.errors.join("\n")).not.toContain("lease deadline passed");
    } finally {
      await f.cleanup();
    }
  },
  60_000,
);

test.skipIf(!linuxUser)(
  "a replacement waits for the authority deadline and confirmed teardown, and the old result stays fenced",
  async () => {
    const f = await fixture();
    try {
      await f.advance(STEP);
      f.setLink("partitioned");
      await f.advance(RUNNER_OFFLINE_BUDGET_MS / 2);
      await expect(f.nextGeneration()).rejects.toThrow("Run assignment generation conflicts.");
      expect(await runnerHasCapacity(sqliteDb(f.db), f.runnerId, f.clock.at)).toBe(false);
      await f.advance(RUNNER_OFFLINE_BUDGET_MS / 2 + 2 * STEP);
      expect(f.replaced).toHaveLength(1);
      expect(f.overlaps).toEqual([]);
      expect(await runnerHasCapacity(sqliteDb(f.db), f.runnerId, f.clock.at)).toBe(false);
      f.finish();
      f.setLink("up");
      await f.tickUntil(
        async () => await runnerHasCapacity(sqliteDb(f.db), f.runnerId, f.clock.at),
      );
      expect(await runnerHasCapacity(sqliteDb(f.db), f.runnerId, f.clock.at)).toBe(true);
      await f.tickUntil(() => f.refusedResults.length > 0);
      expect(f.posted.map((result) => result.stopReason)).not.toContain("end_turn");
    } finally {
      await f.cleanup();
    }
  },
  60_000,
);

test.skipIf(!linuxUser)(
  "a Paws restart within the budget keeps the runner's work and accepts its result",
  async () => {
    const f = await fixture();
    try {
      await f.advance(STEP);
      const recovered = await f.pawsOutage(20 * MINUTE);
      expect(recovered).toEqual([
        { type: "resume", freshSession: true, checkpoint: null, reattach: true },
      ]);
      expect(f.executing()).toBe(true);
      f.finish();
      await f.tickUntil(() => f.posted.length > 0);
      expect(f.posted.map((result) => result.stopReason)).toEqual(["end_turn"]);
      expect(f.refusedResults).toEqual([]);
    } finally {
      await f.cleanup();
    }
  },
  60_000,
);
