import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import {
  beginImplementRun,
  bindLinearSessionTask,
  bindWorkItemRepository,
  consumeWorkspaceBootstrap,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  markPawsAlive,
  openDatabase,
  PAWS_ALIVE_LEASE_SKEW_MS,
  prepareShutdown,
  pawsAliveAt,
  putWorkspaceUser,
  recordLinearInstallation,
  recoverOnStartup,
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
    token: control.createEnrollment(
      { workspaceId: workspace.id, userId, role: "admin", authenticatedAt: now(), teamIds: [] },
      pending,
    ).token,
  });
  db.run("UPDATE runner SET status='active' WHERE id=?", [runnerId]);
  db.run(
    "INSERT INTO runner_host_status(runner_id,runner_version,reported_at) VALUES(?,'0.1.52',?)",
    [runnerId, now()],
  );
  const item = insertQueuedItem(db, { id: "item", now: now(), sessionKey: "session" });
  const { run } = beginImplementRun(db, item.id, now());
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
    const work = createRunnerWork({ db, keyId: "fixture", privateKey: keys.privateKey, now });
    return { work, results: createRunnerResults({ db, work, now }) };
  };
  let services = open();
  function admit(expiresInMs = 4 * 60 * MINUTE) {
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
    services.work.assign(command);
    const token = services.work.issueGrant({
      runnerId,
      runId: run.id,
      commandId: command.id,
      generation: 1,
    }).token;
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
    leaseUntil(): number {
      return db
        .query<{ lease_until: number }, [string]>(
          "SELECT lease_until FROM runner_work WHERE run_id=?",
        )
        .get(run.id)!.lease_until;
    },
    /** Shut Paws down now, stay down for `ms`, then open the database again. */
    down(ms: number) {
      prepareShutdown(db, clock.at);
      db.close();
      clock.at += ms;
      db = openDatabase(path);
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
    f.admit();
    const remaining = f.leaseUntil() - f.clock.at;
    f.down(25 * MINUTE);
    recoverOnStartup(f.db, f.clock.at, BUDGET);
    expect(f.leaseUntil() - f.clock.at).toBe(remaining);
    // No renewal arrives. The shifted deadline expires after the original remaining lease
    // and grace, rather than another offline budget after startup.
    f.clock.at = f.leaseUntil() + RUNNER_LEASE_GRACE_MS;
    markPawsAlive(f.db, f.clock.at);
    expect(recoverOnStartup(f.db, f.clock.at, BUDGET)).toEqual([
      { type: "resume", freshSession: true, checkpoint: null },
    ]);
  } finally {
    f.close();
  }
}, 30_000);

test("Paws down 20 minutes with a 30-minute budget: the runner still holds the work and the run reattaches", async () => {
  const f = await fixture();
  try {
    f.admit();
    const before = f.leaseUntil();
    f.down(20 * MINUTE);
    expect(recoverOnStartup(f.db, f.clock.at, BUDGET)).toEqual([
      { type: "resume", freshSession: true, checkpoint: null, reattach: true },
    ]);
    expect(f.leaseUntil()).toBe(before + 20 * MINUTE);
    expect(resumes(f.db)).toHaveLength(1);
    expect(resumes(f.db)[0]?.payload).toMatchObject({ reason: "process_restart" });
    expect(getWorkItem(f.db, f.item.id)).toMatchObject({ state: "running", recoveryAttempts: 0 });
    const beat = f.work.heartbeat(f.runnerId);
    expect(beat.fenced).toEqual([]);
    expect(beat.offlineBudgetMs).toBe(BUDGET);
    expect(beat.aliveAt).toBe(f.clock.at);
    // A second recovery in the same process does not shift the lease again.
    recoverOnStartup(f.db, f.clock.at, BUDGET);
    expect(f.leaseUntil()).toBe(before + 20 * MINUTE);
  } finally {
    f.close();
  }
}, 30_000);

test("Paws down longer than the budget: the run resumes as today", async () => {
  const f = await fixture();
  try {
    f.admit();
    const before = f.leaseUntil();
    f.down(40 * MINUTE);
    expect(recoverOnStartup(f.db, f.clock.at, BUDGET)).toEqual([
      { type: "resume", freshSession: true, checkpoint: null },
    ]);
    expect(f.leaseUntil()).toBe(before + BUDGET);
    expect(getWorkItem(f.db, f.item.id)).toMatchObject({
      state: "recovering",
      recoveryAttempts: 1,
    });
    expect(f.work.heartbeat(f.runnerId).fenced).toEqual([{ runId: f.run.id, generation: 1 }]);
  } finally {
    f.close();
  }
}, 30_000);

test("the shift stops at the command's expiresAt", async () => {
  const f = await fixture();
  try {
    const { command } = f.admit(10 * MINUTE);
    f.down(20 * MINUTE);
    expect(recoverOnStartup(f.db, f.clock.at, BUDGET)).toEqual([
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
    const { submit } = withResult.admit();
    submit();
    const before = withResult.leaseUntil();
    withResult.down(20 * MINUTE);
    recoverOnStartup(withResult.db, withResult.clock.at, BUDGET);
    expect(withResult.leaseUntil()).toBe(before);
  } finally {
    withResult.close();
  }
  const cancelled = await fixture();
  try {
    cancelled.admit();
    cancelled.db.run(
      `INSERT INTO runner_command(id,runner_id,run_id,generation,kind,envelope,expires_at,acknowledged_at)
       VALUES('cancel',?,?,1,'cancel','{}',?,?)`,
      [cancelled.runnerId, cancelled.run.id, cancelled.clock.at + MINUTE, cancelled.clock.at],
    );
    const before = cancelled.leaseUntil();
    cancelled.down(20 * MINUTE);
    expect(recoverOnStartup(cancelled.db, cancelled.clock.at, BUDGET)).toEqual([
      { type: "resume", freshSession: true, checkpoint: null },
    ]);
    expect(cancelled.leaseUntil()).toBe(before);
  } finally {
    cancelled.close();
  }
}, 30_000);

test("a runner silent past the grace while Paws is up is still fenced", async () => {
  const f = await fixture();
  try {
    f.admit();
    const before = f.leaseUntil();
    // Paws stays up and keeps recording that it is alive while the runner is silent.
    while (f.clock.at <= before + RUNNER_LEASE_GRACE_MS) {
      f.clock.at += 15_000;
      markPawsAlive(f.db, f.clock.at);
    }
    f.down(1_000);
    expect(f.leaseUntil()).toBe(before);
    expect(recoverOnStartup(f.db, f.clock.at, BUDGET)).toEqual([
      { type: "resume", freshSession: true, checkpoint: null },
    ]);
    expect(f.leaseUntil()).toBe(before);
    expect(f.work.heartbeat(f.runnerId).fenced).toEqual([{ runId: f.run.id, generation: 1 }]);
  } finally {
    f.close();
  }
}, 30_000);

test("alive marks recover after the wall clock moves backward", () => {
  const db = tempDb();
  try {
    markPawsAlive(db, 4 * 60 * MINUTE);
    markPawsAlive(db, 3 * 60 * MINUTE);
    expect(pawsAliveAt(db)).toBe(3 * 60 * MINUTE);
  } finally {
    db.close();
  }
});

test("a lease renewed within the alive skew still receives downtime credit", async () => {
  const f = await fixture();
  try {
    f.admit();
    const before = f.leaseUntil();
    markPawsAlive(f.db, before - PAWS_ALIVE_LEASE_SKEW_MS);
    f.clock.at += 20 * MINUTE;
    expect(recoverOnStartup(f.db, f.clock.at, BUDGET)).toEqual([
      { type: "resume", freshSession: true, checkpoint: null, reattach: true },
    ]);
    expect(f.leaseUntil()).toBe(before + 20 * MINUTE);
  } finally {
    f.close();
  }
}, 30_000);

test("a lease renewed past the alive skew receives no downtime credit", async () => {
  const f = await fixture();
  try {
    f.admit();
    const before = f.leaseUntil();
    markPawsAlive(f.db, before - PAWS_ALIVE_LEASE_SKEW_MS - 1);
    f.clock.at += 20 * MINUTE;
    expect(recoverOnStartup(f.db, f.clock.at, BUDGET)).toEqual([
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
    f.admit();
    markPawsAlive(f.db, f.clock.at - 24 * 60 * MINUTE);
    const before = f.leaseUntil();
    // Model an older build renewing work without updating the alive timestamp.
    f.clock.at += 20 * MINUTE;
    expect(recoverOnStartup(f.db, f.clock.at, BUDGET)).toEqual([
      { type: "resume", freshSession: true, checkpoint: null },
    ]);
    expect(f.leaseUntil()).toBe(before);
  } finally {
    f.close();
  }
}, 30_000);

test("a runner older than the offline lease release is not extended", async () => {
  const f = await fixture();
  try {
    f.admit();
    f.db.run("UPDATE runner_host_status SET runner_version='0.1.51' WHERE runner_id=?", [
      f.runnerId,
    ]);
    const beat = f.work.heartbeat(f.runnerId);
    expect(beat).not.toHaveProperty("offlineBudgetMs");
    expect(beat).not.toHaveProperty("aliveAt");
    const before = f.leaseUntil();
    f.down(20 * MINUTE);
    expect(recoverOnStartup(f.db, f.clock.at, BUDGET)).toEqual([
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
    f.admit();
    f.db.run("UPDATE runner SET status='revoked',revoked_at=? WHERE id=?", [
      f.clock.at,
      f.runnerId,
    ]);
    const before = f.leaseUntil();
    f.down(20 * MINUTE);
    expect(recoverOnStartup(f.db, f.clock.at, BUDGET)).toEqual([
      { type: "resume", freshSession: true, checkpoint: null },
    ]);
    expect(f.leaseUntil()).toBe(before);
  } finally {
    f.close();
  }
}, 30_000);
