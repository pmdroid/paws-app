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
  openDatabase,
  prepareShutdown,
  putWorkspaceUser,
  recordLinearInstallation,
  recoverOnStartup,
} from "../src/db";
import { createRunnerControl } from "../src/runner-control";
import { createRunnerKey, initializeRunnerAuthority } from "../src/runner-identity";
import type { RunnerCommand, RunnerResult } from "../src/runner-protocol";
import { createRunnerResults } from "../src/runner-results";
import { createRunnerWork } from "../src/runner-work";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../src/workspace";
import { migratedDatabase } from "./helpers";

const repository = {
  owner: "fixture",
  repo: "repository",
  remoteUrl: "https://github.com/fixture/repository.git",
  baseSha: "a".repeat(40),
};

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "paws-result-recovery-"));
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
  const pending = await control.beginPairing({
    name: "Runner",
    csr: (await createRunnerKey(join(root, "client"))).csr,
  });
  const { runnerId } = await control.approvePairing(
    { workspaceId: workspace.id, userId, role: "owner", authenticatedAt: now(), teamIds: [] },
    pending.code,
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
  function admit(generation: number) {
    const command: Extract<RunnerCommand, { type: "run" }> = {
      type: "run",
      id: workspaceId(),
      runnerId,
      workspaceId: workspace.id,
      issuedAt: now(),
      expiresAt: now() + 300_000,
      runId: run.id,
      itemId: item.id,
      generation,
      repository,
      profile: { agent: "codex", model: "scripted" },
      prompt: "Fixture",
    };
    services.work.assign(command);
    const token = services.work.issueGrant({
      runnerId,
      runId: run.id,
      commandId: command.id,
      generation,
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
      services.results.submit({ runnerId, runId: run.id, generation, token, result });
    return { command, result, submit };
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
    get results() {
      return services.results;
    },
    reopen() {
      db.close();
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

test("an accepted result survives a reopen and lease expiry, and recovery reattaches to it", async () => {
  const f = await fixture();
  try {
    const { command, result, submit } = f.admit(1);
    expect(submit()).toEqual({ duplicate: false });
    f.reopen();
    f.clock.at += 60_001;
    expect(f.results.read(f.run.id, 1, command.id)).toEqual(result);
    expect(() => submit()).toThrow();
    expect(f.work.heartbeat(f.runnerId).fenced).toEqual([]);
    prepareShutdown(f.db, f.clock.at);
    const decisions = recoverOnStartup(f.db, f.clock.at);
    expect(decisions).toEqual([
      { type: "resume", freshSession: true, checkpoint: null, reattach: true },
    ]);
    recoverOnStartup(f.db, f.clock.at);
    expect(resumes(f.db)).toHaveLength(1);
    expect(resumes(f.db)[0]?.payload).not.toHaveProperty("handoff");
    expect(getWorkItem(f.db, f.item.id)).toMatchObject({ state: "running", recoveryAttempts: 0 });
    f.work.finish(f.run.id, 1);
    expect(() => f.results.read(f.run.id, 1, command.id)).toThrow();
  } finally {
    f.close();
  }
}, 30_000);

test("an expired execution without an accepted result follows the existing recovery path", async () => {
  const f = await fixture();
  try {
    const { command } = f.admit(1);
    f.clock.at += 60_001;
    expect(() => f.results.read(f.run.id, 1, command.id)).toThrow(
      "Runner work is fenced or its lease expired.",
    );
    expect(f.work.heartbeat(f.runnerId).fenced).toEqual([{ runId: f.run.id, generation: 1 }]);
    expect(recoverOnStartup(f.db, f.clock.at)).toEqual([
      { type: "resume", freshSession: true, checkpoint: null },
    ]);
    expect(getWorkItem(f.db, f.item.id)).toMatchObject({
      state: "recovering",
      recoveryAttempts: 1,
    });
  } finally {
    f.close();
  }
}, 30_000);

test("a cancelled item does not consume its accepted result after expiry", async () => {
  const f = await fixture();
  try {
    const { command, submit } = f.admit(1);
    submit();
    f.clock.at += 60_001;
    f.db.run("UPDATE work_item SET cancel_requested=1 WHERE id=?", [f.item.id]);
    expect(() => f.results.read(f.run.id, 1, command.id)).toThrow();
    expect(recoverOnStartup(f.db, f.clock.at)).toEqual([
      { type: "resume", freshSession: true, checkpoint: null },
    ]);
  } finally {
    f.close();
  }
}, 30_000);

test("a superseding generation fences the earlier accepted result", async () => {
  const f = await fixture();
  try {
    const first = f.admit(1);
    first.submit();
    f.clock.at += 60_001;
    const second = f.admit(2);
    expect(() => f.results.read(f.run.id, 1, first.command.id)).toThrow();
    expect(() => f.results.read(f.run.id, 2, first.command.id)).toThrow();
    expect(f.results.read(f.run.id, 2, second.command.id)).toBeNull();
    f.clock.at += 60_001;
    expect(recoverOnStartup(f.db, f.clock.at)).toEqual([
      { type: "resume", freshSession: true, checkpoint: null },
    ]);
  } finally {
    f.close();
  }
}, 30_000);
