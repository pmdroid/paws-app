import { expect, test } from "bun:test";
import { CONTROL_PLANE_PROTOCOL_LEVEL } from "../src/runner-protocol";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
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
  openDatabase,
  PAWS_ALIVE_LEASE_SKEW_MS,
  prepareShutdown,
  putWorkspaceUser,
  recordLinearInstallation,
  recoverOnStartup,
  registerInstance,
  runOwner,
  stopInstance,
  takeOverGoneRuns,
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
import { migratedDatabase, tempDb } from "./helpers";

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
  const path = join(root, "paws.db");
  const clock = { at: Date.now() };
  const now = () => clock.at;
  let db = migratedDatabase(path);
  const userId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const workspace = consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "org",
    name: "Fixture",
    userId,
    tokenHash: workspaceTokenHash(issueWorkspaceBootstrap(db, "org", now())),
    now: now(),
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
  db.run("UPDATE runner SET status='active' WHERE id=?", [runnerId]);
  db.run(
    "INSERT INTO runner_host_status(runner_id,runner_version,reported_at) VALUES(?,'0.1.53',?)",
    [runnerId, now()],
  );
  const item = insertQueuedItem(db, { id: "item", now: now(), sessionKey: "session" });
  const { run } = beginImplementRun(db, item.id, now());
  const start = () =>
    registerInstance(db, { role: "all", host: "acme", version: null, now: now() });
  let instance = start();
  claimRun(db, run.id, instance.id);
  recordLinearInstallation(db, {
    organizationId: "org",
    oauthClientId: "app",
    appUserId: "app-user",
    sessionId: "session",
    teamId: "team",
    observedAtMs: now(),
  });
  bindLinearSessionTask(db, "session", item.delegationId, { actorId: "owner" });
  bindWorkItemRepository(db, item.id, repository);
  const keys = generateKeyPairSync("ed25519");
  const open = () => {
    const work = createRunnerWork({
      db,
      keyId: "fixture",
      privateKey: keys.privateKey,
      eventKey: Buffer.alloc(32, 7),
      now,
    });
    return { work, results: createRunnerResults({ db, work, now }) };
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
    get db(): Database {
      return db;
    },
    get work() {
      return services.work;
    },
    /** A second Paws process on the same database. */
    second: () => openDatabase(path),
    /** The instance serving now. */
    get instance() {
      return instance;
    },
    /** Paws dies without a clean stop, and a new instance starts at the current time. */
    crash() {
      instance = start();
    },
    leaseUntil(): number {
      return db
        .query<{ lease_until: number }, [string]>(
          "SELECT lease_until FROM runner_work WHERE run_id=?",
        )
        .get(run.id)!.lease_until;
    },
    /** Shut Paws down now, stay down for `ms`, then open the database again. */
    down(ms: number) {
      prepareShutdown(db, clock.at, undefined, instance.id);
      stopInstance(db, instance.id, clock.at);
      db.close();
      clock.at += ms;
      db = openDatabase(path);
      instance = start();
      services = open();
    },
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const resumes = (db: Database) =>
  listJobs(db).filter((job) => job.queue === "run.resume" && job.status === "pending");

test("a runner that never returns retains only its remaining lease plus grace after startup", async () => {
  const f = await fixture();
  try {
    await f.admit();
    const remaining = f.leaseUntil() - f.clock.at;
    f.down(25 * MINUTE);
    recoverOnStartup(f.db, f.clock.at, BUDGET, f.instance.id);
    expect(f.leaseUntil() - f.clock.at).toBe(remaining);
    // No renewal arrives. The shifted deadline expires after the original remaining lease
    // and grace, rather than another offline budget after startup.
    f.clock.at = f.leaseUntil() + RUNNER_LEASE_GRACE_MS;
    stopInstance(f.db, f.instance.id, f.clock.at);
    f.crash();
    expect(recoverOnStartup(f.db, f.clock.at, BUDGET, f.instance.id)).toEqual([
      { type: "resume", freshSession: true, checkpoint: null },
    ]);
  } finally {
    f.close();
  }
}, 30_000);

test("Paws down 20 minutes with a 30-minute budget: the runner still holds the work and the run reattaches", async () => {
  const f = await fixture();
  try {
    await f.admit();
    const before = f.leaseUntil();
    f.down(20 * MINUTE);
    expect(recoverOnStartup(f.db, f.clock.at, BUDGET, f.instance.id)).toEqual([
      { type: "resume", freshSession: true, checkpoint: null, reattach: true },
    ]);
    expect(f.leaseUntil()).toBe(before + 20 * MINUTE);
    expect(resumes(f.db)).toHaveLength(1);
    expect(resumes(f.db)[0]?.payload).toMatchObject({ reason: "process_restart" });
    expect(getWorkItem(f.db, f.item.id)).toMatchObject({ state: "running", recoveryAttempts: 0 });
    const beat = await f.work.heartbeat(f.runnerId);
    expect(beat.fenced).toEqual([]);
    expect(beat.offlineBudgetMs).toBe(BUDGET);
    expect(beat.aliveAt).toBe(f.clock.at);
    expect(f.leaseUntil()).toBe(f.clock.at + BUDGET - RUNNER_LEASE_GRACE_MS);
    const renewed = f.leaseUntil();
    recoverOnStartup(f.db, f.clock.at, BUDGET, f.instance.id);
    expect(f.leaseUntil()).toBe(renewed);
  } finally {
    f.close();
  }
}, 30_000);

/**
 * Run a second instance in 5-second steps until it closes the run's expired lease. It takes over
 * gone instances' runs every 30 seconds unless `step` scripts the first instance instead.
 */
function serveUntilExpiry(
  f: Awaited<ReturnType<typeof fixture>>,
  b: Database,
  step: ((at: number) => void) | null,
): number {
  const other = registerInstance(b, {
    role: "all",
    host: "acme-b",
    version: null,
    now: f.clock.at,
  });
  for (let i = 0; i < 20 * 12; i++) {
    f.clock.at += 5_000;
    heartbeatInstance(b, other.id, f.clock.at);
    if (step) step(f.clock.at);
    else if (i % 6 === 0) takeOverGoneRuns(b, other.id, f.clock.at);
    if (closeExpiredRunnerLeases(b, f.clock.at).includes(f.run.id)) return f.clock.at;
  }
  throw new Error("The lease never expired.");
}

test("with a second instance alive throughout, a restart gives no credit and the lease expires", async () => {
  const f = await fixture();
  const b = f.second();
  try {
    await f.admit();
    const before = f.leaseUntil();
    const acme = f.instance.id;
    const expiredAt = serveUntilExpiry(f, b, (at) => {
      // The first instance stops cleanly, and its replacement starts four minutes later.
      if (at === before) {
        prepareShutdown(f.db, at, undefined, acme);
        stopInstance(f.db, acme, at);
      }
      if (at === before + 4 * MINUTE) {
        f.crash();
        recoverOnStartup(f.db, at, BUDGET, f.instance.id);
        expect(runOwner(f.db, f.run.id)).toBe(f.instance.id);
        expect(f.leaseUntil()).toBe(before);
      }
    });
    expect(f.instance.id).not.toBe(acme);
    expect(f.leaseUntil()).toBe(before);
    expect(expiredAt).toBe(before + RUNNER_LEASE_GRACE_MS);
  } finally {
    b.close();
    f.close();
  }
}, 30_000);

test("an instance alive throughout takes over a crashed instance's run without credit", async () => {
  const f = await fixture();
  const b = f.second();
  try {
    await f.admit();
    const before = f.leaseUntil();
    const acme = f.instance.id;
    const expiredAt = serveUntilExpiry(f, b, null);
    expect(runOwner(b, f.run.id)).not.toBe(acme);
    expect(f.leaseUntil()).toBe(before);
    expect(expiredAt).toBe(before + RUNNER_LEASE_GRACE_MS);
  } finally {
    b.close();
    f.close();
  }
}, 30_000);

test("a second instance started during the outage credits only the time before it started", async () => {
  const f = await fixture();
  const b = f.second();
  try {
    await f.admit();
    const before = f.leaseUntil();
    f.clock.at += 10 * MINUTE;
    const other = registerInstance(b, {
      role: "all",
      host: "acme-b",
      version: null,
      now: f.clock.at,
    });
    f.clock.at += 5 * MINUTE;
    heartbeatInstance(b, other.id, f.clock.at);
    takeOverGoneRuns(b, other.id, f.clock.at);
    expect(runOwner(b, f.run.id)).toBe(other.id);
    expect(f.leaseUntil()).toBe(before + 10 * MINUTE);
  } finally {
    b.close();
    f.close();
  }
}, 30_000);

test("an instance that outlived the owner and then stopped credits only the time after it stopped", async () => {
  const f = await fixture();
  const b = f.second();
  try {
    await f.admit();
    const before = f.leaseUntil();
    const other = registerInstance(b, {
      role: "all",
      host: "acme-b",
      version: null,
      now: f.clock.at,
    });
    // The owner dies now; the other instance stops 20 seconds later without taking over.
    f.clock.at += 20_000;
    stopInstance(b, other.id, f.clock.at);
    const stoppedAt = f.clock.at;
    f.clock.at += 20 * MINUTE;
    f.crash();
    recoverOnStartup(f.db, f.clock.at, BUDGET, f.instance.id);
    expect(runOwner(f.db, f.run.id)).toBe(f.instance.id);
    expect(f.leaseUntil()).toBe(before + f.clock.at - stoppedAt);
  } finally {
    b.close();
    f.close();
  }
}, 30_000);

test("an instance that came and went during the outage without taking over leaves the rest credited", async () => {
  const f = await fixture();
  const b = f.second();
  try {
    await f.admit();
    const before = f.leaseUntil();
    // The owner dies now; another instance runs from minute 5 to minute 6 and takes nothing over.
    f.clock.at += 5 * MINUTE;
    const other = registerInstance(b, {
      role: "web",
      host: "acme-b",
      version: null,
      now: f.clock.at,
    });
    f.clock.at += MINUTE;
    stopInstance(b, other.id, f.clock.at);
    f.clock.at += 14 * MINUTE;
    f.crash();
    recoverOnStartup(f.db, f.clock.at, BUDGET, f.instance.id);
    expect(f.leaseUntil()).toBe(before + 19 * MINUTE);
  } finally {
    b.close();
    f.close();
  }
}, 30_000);

test("Paws down longer than the budget: the run resumes as today", async () => {
  const f = await fixture();
  try {
    await f.admit();
    const before = f.leaseUntil();
    f.down(40 * MINUTE);
    expect(recoverOnStartup(f.db, f.clock.at, BUDGET, f.instance.id)).toEqual([
      { type: "resume", freshSession: true, checkpoint: null },
    ]);
    expect(f.leaseUntil()).toBe(before + BUDGET);
    expect(getWorkItem(f.db, f.item.id)).toMatchObject({
      state: "recovering",
      recoveryAttempts: 1,
    });
    expect((await f.work.heartbeat(f.runnerId)).fenced).toEqual([
      { runId: f.run.id, generation: 1 },
    ]);
  } finally {
    f.close();
  }
}, 30_000);

test("the shift stops at the command's expiresAt", async () => {
  const f = await fixture();
  try {
    const { command } = await f.admit(10 * MINUTE);
    f.down(20 * MINUTE);
    expect(recoverOnStartup(f.db, f.clock.at, BUDGET, f.instance.id)).toEqual([
      { type: "resume", freshSession: true, checkpoint: null },
    ]);
    expect(f.leaseUntil()).toBe(command.expiresAt);
  } finally {
    f.close();
  }
}, 30_000);

test("work with a result or an acknowledged cancel is not extended", async () => {
  const withResult = await fixture();
  try {
    const { submit } = await withResult.admit();
    await submit();
    const before = withResult.leaseUntil();
    withResult.down(20 * MINUTE);
    recoverOnStartup(withResult.db, withResult.clock.at, BUDGET, withResult.instance.id);
    expect(withResult.leaseUntil()).toBe(before);
  } finally {
    withResult.close();
  }
  const cancelled = await fixture();
  try {
    await cancelled.admit();
    cancelled.db.run(
      `INSERT INTO runner_command(id,runner_id,run_id,generation,kind,envelope,expires_at,acknowledged_at)
       VALUES('cancel',?,?,1,'cancel','{}',?,?)`,
      [cancelled.runnerId, cancelled.run.id, cancelled.clock.at + MINUTE, cancelled.clock.at],
    );
    const before = cancelled.leaseUntil();
    cancelled.down(20 * MINUTE);
    expect(
      recoverOnStartup(cancelled.db, cancelled.clock.at, BUDGET, cancelled.instance.id),
    ).toEqual([{ type: "resume", freshSession: true, checkpoint: null }]);
    expect(cancelled.leaseUntil()).toBe(before);
  } finally {
    cancelled.close();
  }
}, 30_000);

test("a runner silent past the grace while Paws is up is still fenced", async () => {
  const f = await fixture();
  try {
    await f.admit();
    const before = f.leaseUntil();
    // Paws stays up and keeps recording that it is alive while the runner is silent.
    while (f.clock.at <= before + RUNNER_LEASE_GRACE_MS) {
      f.clock.at += 15_000;
      heartbeatInstance(f.db, f.instance.id, f.clock.at);
    }
    f.down(1_000);
    expect(f.leaseUntil()).toBe(before);
    expect(recoverOnStartup(f.db, f.clock.at, BUDGET, f.instance.id)).toEqual([
      { type: "resume", freshSession: true, checkpoint: null },
    ]);
    expect(f.leaseUntil()).toBe(before);
    expect((await f.work.heartbeat(f.runnerId)).fenced).toEqual([
      { runId: f.run.id, generation: 1 },
    ]);
  } finally {
    f.close();
  }
}, 30_000);

test("heartbeats recover after the wall clock moves backward", () => {
  const db = tempDb();
  try {
    const { id } = registerInstance(db, { role: "all", host: "acme", version: null, now: 0 });
    heartbeatInstance(db, id, 4 * 60 * MINUTE);
    heartbeatInstance(db, id, 3 * 60 * MINUTE);
    expect(lastInstanceHeartbeat(db)).toBe(3 * 60 * MINUTE);
  } finally {
    db.close();
  }
});

test("a lease renewed within the alive skew still receives downtime credit", async () => {
  const f = await fixture();
  try {
    await f.admit();
    const before = f.leaseUntil();
    const aliveAt = before - PAWS_ALIVE_LEASE_SKEW_MS;
    heartbeatInstance(f.db, f.instance.id, aliveAt);
    f.clock.at += 20 * MINUTE;
    f.crash();
    expect(recoverOnStartup(f.db, f.clock.at, BUDGET, f.instance.id)).toEqual([
      { type: "resume", freshSession: true, checkpoint: null, reattach: true },
    ]);
    expect(f.leaseUntil()).toBe(before + f.clock.at - aliveAt);
  } finally {
    f.close();
  }
}, 30_000);

test("a lease renewed past the alive skew receives no downtime credit", async () => {
  const f = await fixture();
  try {
    await f.admit();
    const before = f.leaseUntil();
    heartbeatInstance(f.db, f.instance.id, before - PAWS_ALIVE_LEASE_SKEW_MS - 1);
    f.clock.at += 20 * MINUTE;
    f.crash();
    expect(recoverOnStartup(f.db, f.clock.at, BUDGET, f.instance.id)).toEqual([
      { type: "resume", freshSession: true, checkpoint: null },
    ]);
    expect(f.leaseUntil()).toBe(before);
  } finally {
    f.close();
  }
}, 30_000);

test("leases renewed after an obsolete alive mark receive no downtime credit", async () => {
  const f = await fixture();
  try {
    await f.admit();
    heartbeatInstance(f.db, f.instance.id, f.clock.at - 24 * 60 * MINUTE);
    const before = f.leaseUntil();
    // Model an older build renewing work without updating the heartbeat.
    f.clock.at += 20 * MINUTE;
    f.crash();
    expect(recoverOnStartup(f.db, f.clock.at, BUDGET, f.instance.id)).toEqual([
      { type: "resume", freshSession: true, checkpoint: null },
    ]);
    expect(f.leaseUntil()).toBe(before);
  } finally {
    f.close();
  }
}, 30_000);

test("a runner that parses the level is told it on the heartbeat reply", async () => {
  const f = await fixture();
  f.db.run("UPDATE runner_host_status SET runner_version='0.1.76' WHERE runner_id=?", [f.runnerId]);
  expect((await f.work.heartbeat(f.runnerId)).protocolLevel).toBe(CONTROL_PLANE_PROTOCOL_LEVEL);
  f.db.run("DELETE FROM runner_host_status WHERE runner_id=?", [f.runnerId]);
  expect((await f.work.heartbeat(f.runnerId)).protocolLevel).toBe(CONTROL_PLANE_PROTOCOL_LEVEL);
  f.close();
});

test("a runner older than the offline lease release is not extended", async () => {
  const f = await fixture();
  try {
    await f.admit();
    f.db.run("UPDATE runner_host_status SET runner_version='0.1.52' WHERE runner_id=?", [
      f.runnerId,
    ]);
    const beat = await f.work.heartbeat(f.runnerId);
    expect(beat).not.toHaveProperty("offlineBudgetMs");
    expect(beat).not.toHaveProperty("aliveAt");
    expect(beat).not.toHaveProperty("protocolLevel");
    const before = f.leaseUntil();
    f.down(20 * MINUTE);
    expect(recoverOnStartup(f.db, f.clock.at, BUDGET, f.instance.id)).toEqual([
      { type: "resume", freshSession: true, checkpoint: null },
    ]);
    expect(f.leaseUntil()).toBe(before);
  } finally {
    f.close();
  }
}, 30_000);

test("revoked runners receive no downtime credit", async () => {
  const f = await fixture();
  try {
    await f.admit();
    f.db.run("UPDATE runner SET status='revoked',revoked_at=? WHERE id=?", [
      f.clock.at,
      f.runnerId,
    ]);
    const before = f.leaseUntil();
    f.down(20 * MINUTE);
    expect(recoverOnStartup(f.db, f.clock.at, BUDGET, f.instance.id)).toEqual([
      { type: "resume", freshSession: true, checkpoint: null },
    ]);
    expect(f.leaseUntil()).toBe(before);
  } finally {
    f.close();
  }
}, 30_000);
