import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { RunnerCapacityWait } from "../src/core";
import {
  RUNNER_RESERVATION_MS,
  beginImplementRun,
  bindLinearSessionTask,
  bindWorkItemRepository,
  consumeWorkspaceBootstrap,
  insertQueuedItem,
  putWorkspaceUser,
  recordLinearInstallation,
  type Db,
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
import { seed } from "./dialects";
import { tempStore } from "./pglite";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function holders(db: Db): Promise<string[]> {
  const rows = await db.run((q) =>
    q.all(
      q.orm.select({ instanceId: q.t.runnerReservation.instanceId }).from(q.t.runnerReservation),
    ),
  );
  return rows.map((row) => row.instanceId);
}

async function replicas() {
  const root = mkdtempSync(join(tmpdir(), "paws-reservation-replicas-"));
  roots.push(root);
  const { db, close } = await tempStore();
  let clock = Date.now();
  const userId = await putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "acme-owner",
    name: "Acme Owner",
    email: "owner@acme.invalid",
  });
  const workspace = await consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "acme",
    name: "Acme",
    userId,
    tokenHash: workspaceTokenHash(await issueWorkspaceBootstrap(db, "acme", clock)),
    now: clock,
  });
  await seed(db, (q) =>
    q.orm
      .insert(q.t.workspaceRepository)
      .values({ workspaceId: workspace.id, repository: "acme/fixture", teamId: "acme-team" }),
  );
  const issuer = join(root, "issuer");
  const control = createRunnerControl({
    store: db,
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
  await seed(
    db,
    (q) => q.orm.update(q.t.runner).set({ status: "active" }).where(eq(q.t.runner.id, runnerId)),
    (q) => q.orm.insert(q.t.runnerPolicy).values({ runnerId }),
    (q) => q.orm.insert(q.t.runnerAgentPolicy).values({ runnerId, agent: "claude", ready: 1 }),
    (q) => q.orm.insert(q.t.runnerCapacity).values({ runnerId, capacity: 1 }),
  );

  const privateKey = generateKeyPairSync("ed25519").privateKey;
  const instance = (instanceId: string) => {
    const work = createRunnerWork({
      store: db,
      keyId: "acme",
      privateKey,
      eventKey: Buffer.alloc(32, 7),
      now: () => clock,
    });
    const backend = createRemoteAgentRunner({
      store: db,
      work,
      results: createRunnerResults({ store: db, work }),
      health: createRunnerHealth({ store: db, work }),
      now: () => clock,
      pollIntervalMs: 5,
      instanceId,
      placement: createRunnerPlacement({ store: db, now: () => clock }),
      async fetchCandidate() {
        throw new Error("This fixture does not return a candidate");
      },
    });
    return { work, backend };
  };
  const first = instance("acme-a");
  const second = instance("acme-b");
  await first.work.heartbeat(runnerId, 1);

  let sequence = 0;
  const item = async () => {
    const id = `acme-${++sequence}`;
    const sessionId = `acme-session-${sequence}`;
    const record = await insertQueuedItem(db, { id, now: clock, sessionKey: sessionId });
    const { run } = await beginImplementRun(db, id, clock);
    await recordLinearInstallation(db, {
      organizationId: "acme",
      oauthClientId: "acme-app",
      appUserId: "acme-app-user",
      sessionId,
      teamId: "acme-team",
      observedAtMs: clock,
    });
    await bindLinearSessionTask(db, sessionId, record.delegationId, {
      actorId: "acme-owner",
    });
    await seed(db, (q) =>
      q.orm.update(q.t.workItem).set({ ownerUserId: userId }).where(eq(q.t.workItem.id, id)),
    );
    await bindWorkItemRepository(db, id, {
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
    close,
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
    expect(await holders(fixture.db)).toHaveLength(1);
  } finally {
    stop.abort();
    await Bun.sleep(20);
    await fixture.close();
  }
});

test("a crashed instance's reservation expires after two minutes and frees the slot", async () => {
  const fixture = await replicas();
  const stop = new AbortController();
  try {
    const crashed = await fixture.item();
    await seed(fixture.db, (q) =>
      q.orm.insert(q.t.runnerReservation).values({
        runId: crashed.runId,
        runnerId: fixture.runnerId,
        instanceId: "acme-crashed",
        expiresAt: fixture.now() + RUNNER_RESERVATION_MS,
      }),
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
    expect(await holders(fixture.db)).toEqual(["acme-b"]);
  } finally {
    stop.abort();
    await Bun.sleep(20);
    await fixture.close();
  }
});
