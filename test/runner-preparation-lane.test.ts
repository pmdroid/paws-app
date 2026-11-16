import {
  boundPlacementAccounts,
  boundHeartbeat,
  boundResultSubmissions,
} from "./bound-runner-account";
import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginImplementRun,
  bindLinearSessionTask,
  bindWorkItemRepository,
  consumeWorkspaceBootstrap,
  insertQueuedItem,
  putWorkspaceUser,
  recordLinearInstallation,
} from "../src/db";
import { createRemoteAgentRunner, RemotePreparationTimeout } from "../src/runner-backend";
import { createRunnerControl } from "../src/runner-control";
import { createRunnerHealth } from "../src/runner-health";
import { createRunnerKey, initializeRunnerAuthority } from "../src/runner-identity";
import { createRunnerPlacement } from "../src/runner-placement";
import { createRunnerResults } from "../src/runner-results";
import { createRunnerWork } from "../src/runner-work";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../src/workspace";
import { jsonValue, seed } from "./pglite-fixtures";
import { tempStore } from "./pglite";

const roots: string[] = [];
const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "paws-prepare-lane-"));
  roots.push(root);
  const { db: store, close } = await tempStore();
  open.push(close);
  let clock = Date.now();
  const userId = await putWorkspaceUser(store, {
    id: workspaceId(),
    linearUserId: "acme-owner",
    name: "Acme Owner",
    email: "owner@acme.invalid",
  });
  const workspace = await consumeWorkspaceBootstrap(store, {
    id: workspaceId(),
    organizationId: "acme",
    name: "Acme",
    userId,
    tokenHash: workspaceTokenHash(await issueWorkspaceBootstrap(store, "acme", clock)),
    now: clock,
  });
  await seed(store, (q) =>
    q.orm
      .insert(q.t.workspaceRepository)
      .values({ workspaceId: workspace.id, repository: "acme/fixture", teamId: "acme-team" }),
  );
  const issuer = join(root, "issuer");
  const control = createRunnerControl({
    store,
    authority: await initializeRunnerAuthority(issuer),
    certificateRoot: issuer,
    disconnect() {},
  });
  const enrollment = { name: "agentbox", csr: (await createRunnerKey(join(root, "agentbox"))).csr };
  const { runnerId } = await control.enroll({
    ...enrollment,
    token: (
      await control.createEnrollment(
        { workspaceId: workspace.id, userId, role: "admin", authenticatedAt: clock, teamIds: [] },
        enrollment,
      )
    ).token,
  });
  await seed(
    store,
    (q) => q.orm.update(q.t.runner).set({ status: "active" }).where(eq(q.t.runner.id, runnerId)),
    (q) => q.orm.insert(q.t.runnerPolicy).values({ runnerId }),
    (q) => q.orm.insert(q.t.runnerAgentPolicy).values({ runnerId, agent: "codex", ready: 1 }),
    (q) => q.orm.insert(q.t.runnerCapacity).values({ runnerId, capacity: 2 }),
  );
  await boundPlacementAccounts(store);
  const work = createRunnerWork({
    store,
    keyId: "acme",
    privateKey: generateKeyPairSync("ed25519").privateKey,
    eventKey: Buffer.alloc(32, 7),
    now: () => clock,
  });
  boundHeartbeat(store, work);
  const health = createRunnerHealth({ store, work, now: () => clock });
  const results = createRunnerResults({ store, work });
  boundResultSubmissions(store, results, health);
  const backend = createRemoteAgentRunner({
    store,
    work,
    results,
    health,
    now: () => clock,
    pollIntervalMs: 5,
    placement: createRunnerPlacement({ store, now: () => clock }),
    async fetchCandidate() {
      throw new Error("This fixture does not return a candidate");
    },
  });
  await work.heartbeat(runnerId, 1);
  const sessionId = "acme-session";
  const record = await insertQueuedItem(store, { id: "acme-1", now: clock, sessionKey: sessionId });
  const { run } = await beginImplementRun(store, record.id, clock);
  await recordLinearInstallation(store, {
    organizationId: "acme",
    oauthClientId: "acme-app",
    appUserId: "acme-app-user",
    sessionId,
    teamId: "acme-team",
    observedAtMs: clock,
  });
  await bindLinearSessionTask(store, sessionId, record.delegationId, { actorId: "acme-owner" });
  await seed(store, (q) =>
    q.orm.update(q.t.workItem).set({ ownerUserId: userId }).where(eq(q.t.workItem.id, record.id)),
  );
  await bindWorkItemRepository(store, record.id, {
    owner: "acme",
    repo: "fixture",
    remoteUrl: "https://github.com/acme/fixture.git",
  });
  mkdirSync(join(root, record.id), { recursive: true });
  const prepare = () =>
    backend.forItem(record.id)({
      profile: { agent: "codex", model: "model" },
      role: "implementer",
      itemId: record.id,
      runId: run.id,
      prompt: "Prepare acme",
      worktreePath: join(root, record.id),
      pawsRoot: root,
      prepareOnly: true,
      async networkGit() {
        throw new Error("Preparation does not reach Git");
      },
    });
  const probeId = async () => {
    for (const until = performance.now() + 5_000; performance.now() < until; await Bun.sleep(5)) {
      const [row] = await store.run((q) =>
        q.all(
          q.orm
            .select({ id: q.t.runnerCommand.id })
            .from(q.t.runnerCommand)
            .where(
              and(eq(q.t.runnerCommand.runnerId, runnerId), eq(q.t.runnerCommand.kind, "probe")),
            ),
        ),
      );
      if (row) return row.id;
    }
    throw new Error("no probe");
  };
  const busyLane = () =>
    seed(store, (q) =>
      q.orm.insert(q.t.runnerHelper).values({
        id: "busy",
        runnerId,
        workspaceId: workspace.id,
        sessionId,
        sessionGeneration: 0,
        runnerFence: 0,
        envelope: jsonValue(q, {}),
        expiresAt: clock + 3_600_000,
      }),
    );
  const freeLane = () =>
    seed(store, (q) =>
      q.orm.update(q.t.runnerHelper).set({ endedAt: clock }).where(eq(q.t.runnerHelper.id, "busy")),
    );
  const pass = async (ms: number) => {
    for (let spent = 0; spent < ms; spent += 10_000) {
      clock += 10_000;
      await Bun.sleep(20);
    }
  };
  const finish = async (commandId: string) => {
    await work.heartbeat(runnerId, 1);
    await work.acknowledge(runnerId, commandId);
    await health.submit(runnerId, {
      executionId: workspaceId(),
      commandId,
      role: "implementer",
      stopReason: "end_turn",
      timedOut: false,
      cancelled: false,
      authRequired: false,
      agentExited: true,
      identity: { provider: "openai", model: "model", session: "s" },
    });
  };
  return { prepare, probeId, busyLane, freeLane, pass, finish };
}

test("waiting behind a busy helper lane does not count toward the preparation timeout", async () => {
  const f = await fixture();
  const preparing = f.prepare();
  void preparing.catch(() => undefined);
  const id = await f.probeId();
  await f.busyLane();
  await f.pass(200_000);
  await f.freeLane();
  await Bun.sleep(50);
  await f.finish(id);
  const result = await preparing;
  expect(result.errorMessage).toBeUndefined();
  expect(result.identity?.model).toBe("model");
});

test("preparation that runs past the timeout with the helper lane free still times out", async () => {
  const f = await fixture();
  const preparing = f.prepare();
  void preparing.catch(() => undefined);
  await f.probeId();
  await f.pass(130_000);
  await expect(preparing).rejects.toBeInstanceOf(RemotePreparationTimeout);
});
