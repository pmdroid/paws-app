import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginImplementRun,
  bindLinearSessionTask,
  bindWorkItemRepository,
  consumeWorkspaceBootstrap,
  insertQueuedItem,
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordLinearInstallation,
  sqliteDb,
} from "../src/db";
import { createRunnerWork, createRunnerWorkHttp, RUNNER_LIVE_GRACE_MS } from "../src/runner-work";
import { CONFIRMED_TEARDOWN_RUNNER_VERSION, type RunnerCommand } from "../src/runner-protocol";
import { issueWorkspaceBootstrap, workspaceTokenHash } from "../src/workspace";

type Live = { runId: string; generation: number }[];

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "paws-liveness-"));
  const db = openDatabase(join(root, "paws.sqlite"));
  migrate(db);
  const clock = { now: Date.now() };
  const userId = putWorkspaceUser(db, {
    id: "me",
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const workspace = await consumeWorkspaceBootstrap(sqliteDb(db), {
    id: "ws",
    organizationId: "org",
    name: "Test",
    userId,
    tokenHash: workspaceTokenHash(await issueWorkspaceBootstrap(db, "org", clock.now)),
    now: clock.now,
  });
  db.run(
    "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES('box',?,?,'box','active',?,?)",
    [workspace.id, userId, clock.now, clock.now],
  );
  db.run("INSERT INTO workspace_repository VALUES(?,?,?)", [
    workspace.id,
    "fixture/repository",
    "team",
  ]);
  const item = insertQueuedItem(db, { id: "item", now: clock.now, sessionKey: "session" });
  const { run } = beginImplementRun(db, item.id, clock.now);
  recordLinearInstallation(db, {
    organizationId: "org",
    oauthClientId: "client",
    appUserId: "app",
    sessionId: "session",
    teamId: "team",
    observedAtMs: clock.now,
  });
  bindLinearSessionTask(db, "session", item.delegationId, { actorId: "owner" });
  const repository = {
    owner: "fixture",
    repo: "repository",
    remoteUrl: "https://github.com/fixture/repository.git",
    baseSha: "a".repeat(40),
  };
  await bindWorkItemRepository(sqliteDb(db), item.id, repository);
  const keys = generateKeyPairSync("ed25519");
  const work = createRunnerWork({
    db,
    keyId: "fixture",
    privateKey: keys.privateKey,
    eventKey: Buffer.alloc(32, 7),
    now: () => clock.now,
  });
  const host = { runnerVersion: CONFIRMED_TEARDOWN_RUNNER_VERSION.join(".") };
  const command = (generation: number): Extract<RunnerCommand, { type: "run" }> => ({
    id: `work-${generation}`,
    type: "run",
    runnerId: "box",
    workspaceId: workspace.id,
    runId: run.id,
    itemId: item.id,
    generation,
    issuedAt: clock.now,
    expiresAt: clock.now + 3_600_000,
    repository,
    profile: { agent: "claude", model: null },
    prompt: "Implement the issue",
  });
  return {
    db,
    clock,
    work,
    runId: run.id,
    command,
    async heartbeat(
      live: Live,
      liveAfter?: number,
      terminated?: { runId: string; generation: number; commandId: string }[],
    ) {
      return work.heartbeat(
        "box",
        1,
        host,
        undefined,
        undefined,
        undefined,
        undefined,
        live,
        undefined,
        terminated,
        liveAfter,
      );
    },
    row() {
      return db
        .query<
          {
            generation: number;
            endedAt: number | null;
            confirmedAt: number | null;
            lostAt: number | null;
            teardownAt: number | null;
          },
          []
        >(
          "SELECT generation,ended_at AS endedAt,confirmed_at AS confirmedAt,lost_at AS lostAt,teardown_confirmed_at AS teardownAt FROM runner_work",
        )
        .get()!;
    },
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("a delayed heartbeat sampled before the acknowledgement cannot fence the work as lost", async () => {
  const f = await fixture();
  try {
    const before = await f.heartbeat([], 0);
    expect(before.observedAt).toBe(f.clock.now);
    f.clock.now += 1_000;
    await f.work.assign(f.command(1));
    f.clock.now += 1_000;
    await f.work.acknowledge("box", "work-1");
    f.clock.now += 2 * RUNNER_LIVE_GRACE_MS;
    const http = createRunnerWorkHttp(f.work);
    const response = await http(
      new Request("https://paws.invalid/v1/heartbeat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ live: [], liveAfter: before.observedAt }),
      }),
      "box",
    );
    expect(response!.status).toBe(200);
    const delayed = (await response!.json()) as {
      fenced: Live;
      leases: Live;
      observedAt: number;
    };
    expect(delayed.fenced).toEqual([]);
    expect(delayed.leases.map(({ runId }) => runId)).toEqual([f.runId]);
    expect(delayed.observedAt).toBe(f.clock.now);
    expect(f.row()).toMatchObject({ endedAt: null, lostAt: null });

    f.clock.now += 1_000;
    const missing = await f.heartbeat([], delayed.observedAt);
    expect(missing.fenced).toEqual([{ runId: f.runId, generation: 1 }]);
    expect(f.row()).toMatchObject({ endedAt: f.clock.now, lostAt: f.clock.now });
  } finally {
    f.close();
  }
});

test("a sample that names the work confirms it, and out-of-order older samples never fence it", async () => {
  const f = await fixture();
  try {
    const first = await f.heartbeat([], 0);
    f.clock.now += 1_000;
    await f.work.assign(f.command(1));
    await f.work.acknowledge("box", "work-1");
    f.clock.now += 1_000;
    const named = await f.heartbeat([{ runId: f.runId, generation: 1 }], first.observedAt);
    expect(f.row().confirmedAt).toBe(f.clock.now);
    f.clock.now += 3 * RUNNER_LIVE_GRACE_MS;
    expect((await f.heartbeat([], first.observedAt)).fenced).toEqual([]);
    expect((await f.heartbeat([], 0)).fenced).toEqual([]);
    expect(f.row()).toMatchObject({ endedAt: null, lostAt: null });
    expect((await f.heartbeat([], named.observedAt)).fenced).toEqual([
      { runId: f.runId, generation: 1 },
    ]);
  } finally {
    f.close();
  }
});

test("a runner without a cursor keeps the grace rule", async () => {
  const f = await fixture();
  try {
    await f.work.assign(f.command(1));
    await f.work.acknowledge("box", "work-1");
    f.clock.now += RUNNER_LIVE_GRACE_MS - 1;
    const early = await f.heartbeat([]);
    expect(early.fenced).toEqual([]);
    expect(early.observedAt).toBeUndefined();
    f.clock.now += 1;
    expect((await f.heartbeat([])).fenced).toEqual([{ runId: f.runId, generation: 1 }]);
  } finally {
    f.close();
  }
});

test("a new generation inherits neither confirmation nor loss, and an old report cannot confirm it", async () => {
  const f = await fixture();
  try {
    const first = await f.heartbeat([], 0);
    f.clock.now += 1_000;
    await f.work.assign(f.command(1));
    await f.work.acknowledge("box", "work-1");
    f.clock.now += 1_000;
    const named = await f.heartbeat([{ runId: f.runId, generation: 1 }], first.observedAt);
    f.clock.now += 1_000;
    const lost = await f.heartbeat([], named.observedAt, [
      { runId: f.runId, generation: 1, commandId: "work-1" },
    ]);
    expect(lost.fenced).toEqual([{ runId: f.runId, generation: 1 }]);
    expect(f.row()).toMatchObject({ generation: 1 });
    expect(f.row().confirmedAt).not.toBeNull();
    expect(f.row().lostAt).not.toBeNull();
    expect(f.row().teardownAt).not.toBeNull();

    f.clock.now += 1_000;
    await f.work.assign(f.command(2));
    expect(f.row()).toEqual({
      generation: 2,
      endedAt: null,
      confirmedAt: null,
      lostAt: null,
      teardownAt: null,
    });
    f.clock.now += 1_000;
    await f.heartbeat([{ runId: f.runId, generation: 1 }], lost.observedAt);
    expect(f.row()).toMatchObject({ generation: 2, confirmedAt: null, lostAt: null });
  } finally {
    f.close();
  }
});
