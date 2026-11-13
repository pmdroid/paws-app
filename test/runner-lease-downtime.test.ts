import { expect, test } from "bun:test";
import { CONTROL_PLANE_PROTOCOL_LEVEL } from "../src/runner-protocol";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
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
  lastInstanceHeartbeat,
  listJobs,
  PAWS_ALIVE_LEASE_SKEW_MS,
  prepareShutdown,
  putWorkspaceUser,
  recordLinearInstallation,
  recoverOnStartup,
  registerInstance,
  runOwner,
  stopInstance,
  takeOverGoneRuns,
  type Db,
} from "../src/db";
import { createRunnerControl } from "../src/runner-control";
import { createRunnerKey, initializeRunnerAuthority } from "../src/runner-identity";
import {
  RUNNER_LEASE_GRACE_MS,
  type RunnerCommand,
  type RunnerResult,
} from "../src/runner-protocol";
import { createRunnerResults } from "../src/runner-results";
import { createRunnerWork } from "../src/runner-work";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../src/workspace";
import { json, seed } from "./dialects";
import { tempStore } from "./pglite";

const MINUTE = 60_000;
const BUDGET = 30 * MINUTE;

const repository = {
  owner: "fixture",
  repo: "repository",
  remoteUrl: "https://github.com/fixture/repository.git",
  baseSha: "a".repeat(40),
};

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "paws-lease-downtime-"));
  const clock = { at: Date.now() };
  const now = () => clock.at;
  const { db, close } = await tempStore();
  const userId = await putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const workspace = await consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "org",
    name: "Fixture",
    userId,
    tokenHash: workspaceTokenHash(await issueWorkspaceBootstrap(db, "org", now())),
    now: now(),
  });
  await seed(db, (q) =>
    q.orm
      .insert(q.t.workspaceRepository)
      .values({ workspaceId: workspace.id, repository: "fixture/repository", teamId: "team" }),
  );
  const issuer = join(root, "issuer");
  const control = createRunnerControl({
    store: db,
    authority: await initializeRunnerAuthority(issuer),
    certificateRoot: issuer,
    disconnect() {},
    now,
  });
  const pending = { name: "Runner", csr: (await createRunnerKey(join(root, "client"))).csr };
  const { runnerId } = await control.enroll({
    ...pending,
    token: (
      await control.createEnrollment(
        { workspaceId: workspace.id, userId, role: "admin", authenticatedAt: now(), teamIds: [] },
        pending,
      )
    ).token,
  });
  await seed(
    db,
    (q) => q.orm.update(q.t.runner).set({ status: "active" }).where(eq(q.t.runner.id, runnerId)),
    (q) =>
      q.orm
        .insert(q.t.runnerHostStatus)
        .values({ runnerId, runnerVersion: "0.1.53", reportedAt: now() }),
  );
  const item = await insertQueuedItem(db, { id: "item", now: now(), sessionKey: "session" });
  const { run } = await beginImplementRun(db, item.id, now());
  const start = async () =>
    await registerInstance(db, { role: "all", host: "acme", version: null, now: now() });
  let instance = await start();
  await claimRun(db, run.id, instance.id);
  await recordLinearInstallation(db, {
    organizationId: "org",
    oauthClientId: "app",
    appUserId: "app-user",
    sessionId: "session",
    teamId: "team",
    observedAtMs: now(),
  });
  await bindLinearSessionTask(db, "session", item.delegationId, { actorId: "owner" });
  await bindWorkItemRepository(db, item.id, repository);
  const keys = generateKeyPairSync("ed25519");
  const open = () => {
    const work = createRunnerWork({
      store: db,
      keyId: "fixture",
      privateKey: keys.privateKey,
      eventKey: Buffer.alloc(32, 7),
      now,
    });
    return { work, results: createRunnerResults({ store: db, work, now }) };
  };
  let services = open();
  async function admit(expiresInMs = 4 * 60 * MINUTE) {
    const command: Extract<RunnerCommand, { type: "run" }> = {
      type: "run",
      id: workspaceId(),
      runnerId,
      workspaceId: workspace.id,
      issuedAt: now(),
      expiresAt: now() + expiresInMs,
      runId: run.id,
      itemId: item.id,
      generation: 1,
      repository,
      profile: { agent: "codex", model: "scripted" },
      prompt: "Fixture",
    };
    await services.work.assign(command);
    const token = (
      await services.work.issueGrant({
        runnerId,
        runId: run.id,
        commandId: command.id,
        generation: 1,
      })
    ).token;
    const result: RunnerResult = {
      executionId: workspaceId(),
      commandId: command.id,
      role: "implementer",
      stopReason: "end_turn",
      timedOut: false,
      cancelled: false,
      authRequired: false,
      agentExited: true,
      candidateSha: "b".repeat(40),
    };
    const submit = () =>
      services.results.submit({ runnerId, runId: run.id, generation: 1, token, result });
    return { command, submit };
  }
  return {
    clock,
    runnerId,
    run,
    item,
    admit,
    db,
    get work() {
      return services.work;
    },
    /** A second Paws process on the same database. */
    second: (): Db => db,
    version: (runnerVersion: string) =>
      seed(db, (q) =>
        q.orm
          .update(q.t.runnerHostStatus)
          .set({ runnerVersion })
          .where(eq(q.t.runnerHostStatus.runnerId, runnerId)),
      ),
    /** The instance serving now. */
    get instance() {
      return instance;
    },
    /** Paws dies without a clean stop, and a new instance starts at the current time. */
    async crash() {
      instance = await start();
    },
    async leaseUntil(): Promise<number> {
      const row = await db.run((q) =>
        q.one(
          q.orm
            .select({ leaseUntil: q.t.runnerWork.leaseUntil })
            .from(q.t.runnerWork)
            .where(eq(q.t.runnerWork.runId, run.id)),
        ),
      );
      return row!.leaseUntil;
    },
    /** Shut Paws down now, stay down for `ms`, then open the database again. */
    async down(ms: number) {
      await prepareShutdown(db, clock.at, undefined, instance.id);
      await stopInstance(db, instance.id, clock.at);
      clock.at += ms;
      instance = await start();
      services = open();
    },
    async close() {
      await close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const resumes = async (db: Db) =>
  (await listJobs(db)).filter((job) => job.queue === "run.resume" && job.status === "pending");

test("a runner that never returns retains only its remaining lease plus grace after startup", async () => {
  const f = await fixture();
  try {
    await f.admit();
    const remaining = (await f.leaseUntil()) - f.clock.at;
    await f.down(25 * MINUTE);
    await recoverOnStartup(f.db, f.clock.at, BUDGET, f.instance.id);
    expect((await f.leaseUntil()) - f.clock.at).toBe(remaining);
    // No renewal arrives. The shifted deadline expires after the original remaining lease
    // and grace, rather than another offline budget after startup.
    f.clock.at = (await f.leaseUntil()) + RUNNER_LEASE_GRACE_MS;
    await stopInstance(f.db, f.instance.id, f.clock.at);
    await f.crash();
    expect(await recoverOnStartup(f.db, f.clock.at, BUDGET, f.instance.id)).toEqual([
      { type: "resume", freshSession: true, checkpoint: null },
    ]);
  } finally {
    await f.close();
  }
}, 30_000);

test("Paws down 20 minutes with a 30-minute budget: the runner still holds the work and the run reattaches", async () => {
  const f = await fixture();
  try {
    await f.admit();
    const before = await f.leaseUntil();
    await f.down(20 * MINUTE);
    expect(await recoverOnStartup(f.db, f.clock.at, BUDGET, f.instance.id)).toEqual([
      { type: "resume", freshSession: true, checkpoint: null, reattach: true },
    ]);
    expect(await f.leaseUntil()).toBe(before + 20 * MINUTE);
    expect(await resumes(f.db)).toHaveLength(1);
    expect((await resumes(f.db))[0]?.payload).toMatchObject({ reason: "process_restart" });
    expect(await getWorkItem(f.db, f.item.id)).toMatchObject({
      state: "running",
      recoveryAttempts: 0,
    });
    const beat = await f.work.heartbeat(f.runnerId);
    expect(beat.fenced).toEqual([]);
    expect(beat.offlineBudgetMs).toBe(BUDGET);
    expect(beat.aliveAt).toBe(f.clock.at);
    expect(await f.leaseUntil()).toBe(f.clock.at + BUDGET - RUNNER_LEASE_GRACE_MS);
    const renewed = await f.leaseUntil();
    await recoverOnStartup(f.db, f.clock.at, BUDGET, f.instance.id);
    expect(await f.leaseUntil()).toBe(renewed);
  } finally {
    await f.close();
  }
}, 30_000);

/**
 * Run a second instance in 5-second steps until it closes the run's expired lease. It takes over
 * gone instances' runs every 30 seconds unless `step` scripts the first instance instead.
 */
async function serveUntilExpiry(
  f: Awaited<ReturnType<typeof fixture>>,
  b: Db,
  step: ((at: number) => Promise<void>) | null,
): Promise<number> {
  const other = await registerInstance(b, {
    role: "all",
    host: "acme-b",
    version: null,
    now: f.clock.at,
  });
  for (let i = 0; i < 20 * 12; i++) {
    f.clock.at += 5_000;
    await heartbeatInstance(b, other.id, f.clock.at);
    if (step) await step(f.clock.at);
    else if (i % 6 === 0) await takeOverGoneRuns(b, other.id, f.clock.at);
    if ((await closeExpiredRunnerLeases(b, f.clock.at)).includes(f.run.id)) return f.clock.at;
  }
  throw new Error("The lease never expired.");
}

test("with a second instance alive throughout, a restart gives no credit and the lease expires", async () => {
  const f = await fixture();
  const b = f.second();
  try {
    await f.admit();
    const before = await f.leaseUntil();
    const acme = f.instance.id;
    const expiredAt = await serveUntilExpiry(f, b, async (at) => {
      // The first instance stops cleanly, and its replacement starts four minutes later.
      if (at === before) {
        await prepareShutdown(f.db, at, undefined, acme);
        await stopInstance(f.db, acme, at);
      }
      if (at === before + 4 * MINUTE) {
        await f.crash();
        await recoverOnStartup(f.db, at, BUDGET, f.instance.id);
        expect(await runOwner(f.db, f.run.id)).toBe(f.instance.id);
        expect(await f.leaseUntil()).toBe(before);
      }
    });
    expect(f.instance.id).not.toBe(acme);
    expect(await f.leaseUntil()).toBe(before);
    expect(expiredAt).toBe(before + RUNNER_LEASE_GRACE_MS);
  } finally {
    await f.close();
  }
}, 30_000);

test("an instance alive throughout takes over a crashed instance's run without credit", async () => {
  const f = await fixture();
  const b = f.second();
  try {
    await f.admit();
    const before = await f.leaseUntil();
    const acme = f.instance.id;
    const expiredAt = await serveUntilExpiry(f, b, null);
    expect(await runOwner(b, f.run.id)).not.toBe(acme);
    expect(await f.leaseUntil()).toBe(before);
    expect(expiredAt).toBe(before + RUNNER_LEASE_GRACE_MS);
  } finally {
    await f.close();
  }
}, 30_000);

test("a second instance started during the outage credits only the time before it started", async () => {
  const f = await fixture();
  const b = f.second();
  try {
    await f.admit();
    const before = await f.leaseUntil();
    f.clock.at += 10 * MINUTE;
    const other = await registerInstance(b, {
      role: "all",
      host: "acme-b",
      version: null,
      now: f.clock.at,
    });
    f.clock.at += 5 * MINUTE;
    await heartbeatInstance(b, other.id, f.clock.at);
    await takeOverGoneRuns(b, other.id, f.clock.at);
    expect(await runOwner(b, f.run.id)).toBe(other.id);
    expect(await f.leaseUntil()).toBe(before + 10 * MINUTE);
  } finally {
    await f.close();
  }
}, 30_000);

test("an instance that outlived the owner and then stopped credits only the time after it stopped", async () => {
  const f = await fixture();
  const b = f.second();
  try {
    await f.admit();
    const before = await f.leaseUntil();
    const other = await registerInstance(b, {
      role: "all",
      host: "acme-b",
      version: null,
      now: f.clock.at,
    });
    // The owner dies now; the other instance stops 20 seconds later without taking over.
    f.clock.at += 20_000;
    await stopInstance(b, other.id, f.clock.at);
    const stoppedAt = f.clock.at;
    f.clock.at += 20 * MINUTE;
    await f.crash();
    await recoverOnStartup(f.db, f.clock.at, BUDGET, f.instance.id);
    expect(await runOwner(f.db, f.run.id)).toBe(f.instance.id);
    expect(await f.leaseUntil()).toBe(before + f.clock.at - stoppedAt);
  } finally {
    await f.close();
  }
}, 30_000);

test("an instance that came and went during the outage without taking over leaves the rest credited", async () => {
  const f = await fixture();
  const b = f.second();
  try {
    await f.admit();
    const before = await f.leaseUntil();
    // The owner dies now; another instance runs from minute 5 to minute 6 and takes nothing over.
    f.clock.at += 5 * MINUTE;
    const other = await registerInstance(b, {
      role: "web",
      host: "acme-b",
      version: null,
      now: f.clock.at,
    });
    f.clock.at += MINUTE;
    await stopInstance(b, other.id, f.clock.at);
    f.clock.at += 14 * MINUTE;
    await f.crash();
    await recoverOnStartup(f.db, f.clock.at, BUDGET, f.instance.id);
    expect(await f.leaseUntil()).toBe(before + 19 * MINUTE);
  } finally {
    await f.close();
  }
}, 30_000);

test("Paws down longer than the budget: the run resumes as today", async () => {
  const f = await fixture();
  try {
    await f.admit();
    const before = await f.leaseUntil();
    await f.down(40 * MINUTE);
    expect(await recoverOnStartup(f.db, f.clock.at, BUDGET, f.instance.id)).toEqual([
      { type: "resume", freshSession: true, checkpoint: null },
    ]);
    expect(await f.leaseUntil()).toBe(before + BUDGET);
    expect(await getWorkItem(f.db, f.item.id)).toMatchObject({
      state: "recovering",
      recoveryAttempts: 1,
    });
    expect((await f.work.heartbeat(f.runnerId)).fenced).toEqual([
      { runId: f.run.id, generation: 1 },
    ]);
  } finally {
    await f.close();
  }
}, 30_000);

test("the shift stops at the command's expiresAt", async () => {
  const f = await fixture();
  try {
    const { command } = await f.admit(10 * MINUTE);
    await f.down(20 * MINUTE);
    expect(await recoverOnStartup(f.db, f.clock.at, BUDGET, f.instance.id)).toEqual([
      { type: "resume", freshSession: true, checkpoint: null },
    ]);
    expect(await f.leaseUntil()).toBe(command.expiresAt);
  } finally {
    await f.close();
  }
}, 30_000);

test("work with a result or an acknowledged cancel is not extended", async () => {
  const withResult = await fixture();
  try {
    const { submit } = await withResult.admit();
    await submit();
    const before = await withResult.leaseUntil();
    await withResult.down(20 * MINUTE);
    await recoverOnStartup(withResult.db, withResult.clock.at, BUDGET, withResult.instance.id);
    expect(await withResult.leaseUntil()).toBe(before);
  } finally {
    await withResult.close();
  }
  const cancelled = await fixture();
  try {
    await cancelled.admit();
    await seed(cancelled.db, (q) =>
      q.orm.insert(q.t.runnerCommand).values({
        id: "cancel",
        runnerId: cancelled.runnerId,
        runId: cancelled.run.id,
        generation: 1,
        kind: "cancel",
        envelope: json(cancelled.db, {}),
        expiresAt: cancelled.clock.at + MINUTE,
        acknowledgedAt: cancelled.clock.at,
      }),
    );
    const before = await cancelled.leaseUntil();
    await cancelled.down(20 * MINUTE);
    expect(
      await recoverOnStartup(cancelled.db, cancelled.clock.at, BUDGET, cancelled.instance.id),
    ).toEqual([{ type: "resume", freshSession: true, checkpoint: null }]);
    expect(await cancelled.leaseUntil()).toBe(before);
  } finally {
    await cancelled.close();
  }
}, 30_000);

test("a runner silent past the grace while Paws is up is still fenced", async () => {
  const f = await fixture();
  try {
    await f.admit();
    const before = await f.leaseUntil();
    // Paws stays up and keeps recording that it is alive while the runner is silent.
    while (f.clock.at <= before + RUNNER_LEASE_GRACE_MS) {
      f.clock.at += 15_000;
      await heartbeatInstance(f.db, f.instance.id, f.clock.at);
    }
    await f.down(1_000);
    expect(await f.leaseUntil()).toBe(before);
    expect(await recoverOnStartup(f.db, f.clock.at, BUDGET, f.instance.id)).toEqual([
      { type: "resume", freshSession: true, checkpoint: null },
    ]);
    expect(await f.leaseUntil()).toBe(before);
    expect((await f.work.heartbeat(f.runnerId)).fenced).toEqual([
      { runId: f.run.id, generation: 1 },
    ]);
  } finally {
    await f.close();
  }
}, 30_000);

test("heartbeats recover after the wall clock moves backward", async () => {
  const { db, close } = await tempStore();
  try {
    const { id } = await registerInstance(db, {
      role: "all",
      host: "acme",
      version: null,
      now: 0,
    });
    await heartbeatInstance(db, id, 4 * 60 * MINUTE);
    await heartbeatInstance(db, id, 3 * 60 * MINUTE);
    expect(await lastInstanceHeartbeat(db)).toBe(3 * 60 * MINUTE);
  } finally {
    await close();
  }
});

test("a lease renewed within the alive skew still receives downtime credit", async () => {
  const f = await fixture();
  try {
    await f.admit();
    const before = await f.leaseUntil();
    const aliveAt = before - PAWS_ALIVE_LEASE_SKEW_MS;
    await heartbeatInstance(f.db, f.instance.id, aliveAt);
    f.clock.at += 20 * MINUTE;
    await f.crash();
    expect(await recoverOnStartup(f.db, f.clock.at, BUDGET, f.instance.id)).toEqual([
      { type: "resume", freshSession: true, checkpoint: null, reattach: true },
    ]);
    expect(await f.leaseUntil()).toBe(before + f.clock.at - aliveAt);
  } finally {
    await f.close();
  }
}, 30_000);

test("a lease renewed past the alive skew receives no downtime credit", async () => {
  const f = await fixture();
  try {
    await f.admit();
    const before = await f.leaseUntil();
    await heartbeatInstance(f.db, f.instance.id, before - PAWS_ALIVE_LEASE_SKEW_MS - 1);
    f.clock.at += 20 * MINUTE;
    await f.crash();
    expect(await recoverOnStartup(f.db, f.clock.at, BUDGET, f.instance.id)).toEqual([
      { type: "resume", freshSession: true, checkpoint: null },
    ]);
    expect(await f.leaseUntil()).toBe(before);
  } finally {
    await f.close();
  }
}, 30_000);

test("leases renewed after an obsolete alive mark receive no downtime credit", async () => {
  const f = await fixture();
  try {
    await f.admit();
    await heartbeatInstance(f.db, f.instance.id, f.clock.at - 24 * 60 * MINUTE);
    const before = await f.leaseUntil();
    // Model an older build renewing work without updating the heartbeat.
    f.clock.at += 20 * MINUTE;
    await f.crash();
    expect(await recoverOnStartup(f.db, f.clock.at, BUDGET, f.instance.id)).toEqual([
      { type: "resume", freshSession: true, checkpoint: null },
    ]);
    expect(await f.leaseUntil()).toBe(before);
  } finally {
    await f.close();
  }
}, 30_000);

test("a runner that parses the level is told it on the heartbeat reply", async () => {
  const f = await fixture();
  await f.version("0.1.76");
  expect((await f.work.heartbeat(f.runnerId)).protocolLevel).toBe(CONTROL_PLANE_PROTOCOL_LEVEL);
  await seed(f.db, (q) =>
    q.orm.delete(q.t.runnerHostStatus).where(eq(q.t.runnerHostStatus.runnerId, f.runnerId)),
  );
  expect((await f.work.heartbeat(f.runnerId)).protocolLevel).toBe(CONTROL_PLANE_PROTOCOL_LEVEL);
  await f.close();
});

test("a runner older than the offline lease release is not extended", async () => {
  const f = await fixture();
  try {
    await f.admit();
    await f.version("0.1.52");
    const beat = await f.work.heartbeat(f.runnerId);
    expect(beat).not.toHaveProperty("offlineBudgetMs");
    expect(beat).not.toHaveProperty("aliveAt");
    expect(beat).not.toHaveProperty("protocolLevel");
    const before = await f.leaseUntil();
    await f.down(20 * MINUTE);
    expect(await recoverOnStartup(f.db, f.clock.at, BUDGET, f.instance.id)).toEqual([
      { type: "resume", freshSession: true, checkpoint: null },
    ]);
    expect(await f.leaseUntil()).toBe(before);
  } finally {
    await f.close();
  }
}, 30_000);

test("revoked runners receive no downtime credit", async () => {
  const f = await fixture();
  try {
    await f.admit();
    await seed(f.db, (q) =>
      q.orm
        .update(q.t.runner)
        .set({ status: "revoked", revokedAt: f.clock.at })
        .where(eq(q.t.runner.id, f.runnerId)),
    );
    const before = await f.leaseUntil();
    await f.down(20 * MINUTE);
    expect(await recoverOnStartup(f.db, f.clock.at, BUDGET, f.instance.id)).toEqual([
      { type: "resume", freshSession: true, checkpoint: null },
    ]);
    expect(await f.leaseUntil()).toBe(before);
  } finally {
    await f.close();
  }
}, 30_000);
