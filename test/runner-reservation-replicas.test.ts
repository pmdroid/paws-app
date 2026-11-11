import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunnerCapacityWait } from "../src/core";
import {
  RUNNER_RESERVATION_MS,
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
import { createRemoteAgentRunner } from "../src/runner-backend";
import { createRunnerControl } from "../src/runner-control";
import { createRunnerHealth } from "../src/runner-health";
import { createRunnerKey, initializeRunnerAuthority } from "../src/runner-identity";
import { createRunnerPlacement } from "../src/runner-placement";
import type { RunnerCommand } from "../src/runner-protocol";
import { createRunnerResults } from "../src/runner-results";
import { createRunnerWork } from "../src/runner-work";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../src/workspace";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function replicas() {
  const root = mkdtempSync(join(tmpdir(), "paws-reservation-replicas-"));
  roots.push(root);
  const path = join(root, "paws.sqlite");
  const db = openDatabase(path);
  migrate(db);
  let clock = Date.now();
  const userId = await putWorkspaceUser(sqliteDb(db), {
    id: workspaceId(),
    linearUserId: "acme-owner",
    name: "Acme Owner",
    email: "owner@acme.invalid",
  });
  const workspace = await consumeWorkspaceBootstrap(sqliteDb(db), {
    id: workspaceId(),
    organizationId: "acme",
    name: "Acme",
    userId,
    tokenHash: workspaceTokenHash(await issueWorkspaceBootstrap(db, "acme", clock)),
    now: clock,
  });
  db.run("INSERT INTO workspace_repository VALUES(?,?,?)", [
    workspace.id,
    "acme/fixture",
    "acme-team",
  ]);
  const issuer = join(root, "issuer");
  const control = createRunnerControl({
    db,
    authority: await initializeRunnerAuthority(issuer),
    certificateRoot: issuer,
    disconnect() {},
  });
  const owner = {
    workspaceId: workspace.id,
    userId,
    role: "admin" as const,
    authenticatedAt: clock,
    teamIds: [],
  };
  const enrollment = { name: "acme-box", csr: (await createRunnerKey(join(root, "box"))).csr };
  const { runnerId } = await control.enroll({
    ...enrollment,
    token: (await control.createEnrollment(owner, enrollment)).token,
  });
  db.run("UPDATE runner SET status='active' WHERE id=?", [runnerId]);
  db.run("INSERT INTO runner_policy(runner_id) VALUES(?)", [runnerId]);
  db.run("INSERT INTO runner_agent_policy(runner_id,agent,ready) VALUES(?,'claude',1)", [runnerId]);
  db.run("INSERT INTO runner_capacity(runner_id,capacity) VALUES(?,1)", [runnerId]);

  const privateKey = generateKeyPairSync("ed25519").privateKey;
  const instance = (instanceId: string) => {
    const own = openDatabase(path);
    const work = createRunnerWork({
      db: own,
      keyId: "acme",
      privateKey,
      eventKey: Buffer.alloc(32, 7),
      now: () => clock,
    });
    const backend = createRemoteAgentRunner({
      db: own,
      work,
      results: createRunnerResults({ db: own, work }),
      health: createRunnerHealth({ db: own, work }),
      now: () => clock,
      pollIntervalMs: 5,
      instanceId,
      placement: createRunnerPlacement({ store: sqliteDb(own), now: () => clock }),
      async fetchCandidate() {
        throw new Error("This fixture does not return a candidate");
      },
    });
    return { db: own, work, backend };
  };
  const first = instance("acme-a");
  const second = instance("acme-b");
  await first.work.heartbeat(runnerId, 1);

  let sequence = 0;
  const item = async () => {
    const id = `acme-${++sequence}`;
    const sessionId = `acme-session-${sequence}`;
    const record = await insertQueuedItem(db, { id, now: clock, sessionKey: sessionId });
    const { run } = await beginImplementRun(sqliteDb(db), id, clock);
    await recordLinearInstallation(sqliteDb(db), {
      organizationId: "acme",
      oauthClientId: "acme-app",
      appUserId: "acme-app-user",
      sessionId,
      teamId: "acme-team",
      observedAtMs: clock,
    });
    await bindLinearSessionTask(sqliteDb(db), sessionId, record.delegationId, {
      actorId: "acme-owner",
    });
    db.run("UPDATE work_item SET owner_user_id=? WHERE id=?", [userId, id]);
    await bindWorkItemRepository(sqliteDb(db), id, {
      owner: "acme",
      repo: "fixture",
      remoteUrl: "https://github.com/acme/fixture.git",
    });
    return { id, runId: run.id };
  };
  const prepare = (
    on: ReturnType<typeof instance>,
    target: Awaited<ReturnType<typeof item>>,
    signal: AbortSignal,
  ) => {
    const worktreePath = join(root, target.id);
    mkdirSync(worktreePath, { recursive: true });
    return on.backend.forItem(target.id)({
      profile: { agent: "claude", model: "model" },
      role: "implementer",
      itemId: target.id,
      runId: target.runId,
      prompt: "Prepare acme",
      worktreePath,
      pawsRoot: root,
      prepareOnly: true,
      signal,
      async networkGit() {
        throw new Error("Preparation does not reach Git");
      },
    });
  };
  const probes = async () =>
    (await first.work.commands(runnerId))
      .map(
        (envelope) =>
          JSON.parse(Buffer.from(envelope.payload, "base64url").toString()) as RunnerCommand,
      )
      .filter((command) => command.type === "probe");
  return {
    db,
    runnerId,
    first,
    second,
    item,
    prepare,
    probes,
    now: () => clock,
    async tick(ms: number) {
      clock += ms;
      await first.work.heartbeat(runnerId, 1);
    },
    close() {
      for (const handle of [first.db, second.db, db]) handle.close();
    },
  };
}

test("two instances placing on a one-slot runner at once: only one wins", async () => {
  const fixture = await replicas();
  const stop = new AbortController();
  try {
    const first = await fixture.item();
    const second = await fixture.item();
    const outcomes = await Promise.allSettled([
      Promise.race([
        fixture.prepare(fixture.first, first, stop.signal),
        Bun.sleep(500).then(() => "placed"),
      ]),
      Promise.race([
        fixture.prepare(fixture.second, second, stop.signal),
        Bun.sleep(500).then(() => "placed"),
      ]),
    ]);
    const placed = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const waiting = outcomes.filter(
      (outcome) => outcome.status === "rejected" && outcome.reason instanceof RunnerCapacityWait,
    );
    expect(placed).toHaveLength(1);
    expect(waiting).toHaveLength(1);
    expect(String((waiting[0] as PromiseRejectedResult).reason)).toContain(
      "Waiting for a free slot",
    );
    expect(await fixture.probes()).toHaveLength(1);
    expect(
      fixture.db.query("SELECT instance_id AS instanceId FROM runner_reservation").all(),
    ).toHaveLength(1);
  } finally {
    stop.abort();
    await Bun.sleep(20);
    fixture.close();
  }
});

test("a crashed instance's reservation expires after two minutes and frees the slot", async () => {
  const fixture = await replicas();
  const stop = new AbortController();
  try {
    const crashed = await fixture.item();
    fixture.db.run(
      "INSERT INTO runner_reservation(run_id,runner_id,instance_id,expires_at) VALUES(?,?,'acme-crashed',?)",
      [crashed.runId, fixture.runnerId, fixture.now() + RUNNER_RESERVATION_MS],
    );
    const waiting = await fixture.item();
    await expect(fixture.prepare(fixture.second, waiting, stop.signal)).rejects.toBeInstanceOf(
      RunnerCapacityWait,
    );
    await Bun.sleep(50);
    expect(await fixture.probes()).toHaveLength(0);

    await fixture.tick(RUNNER_RESERVATION_MS + 1);
    const placed = fixture.prepare(fixture.second, waiting, stop.signal);
    void placed.catch(() => undefined);
    const until = performance.now() + 5_000;
    while (!(await fixture.probes()).length && performance.now() < until) await Bun.sleep(5);
    expect(await fixture.probes()).toHaveLength(1);
    expect(
      fixture.db
        .query("SELECT instance_id AS instanceId FROM runner_reservation")
        .all()
        .map((row) => (row as { instanceId: string }).instanceId),
    ).toEqual(["acme-b"]);
  } finally {
    stop.abort();
    await Bun.sleep(20);
    fixture.close();
  }
});
