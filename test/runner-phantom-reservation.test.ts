import { afterEach, expect, spyOn, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { eq } from "drizzle-orm";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunnerCapacityWait } from "../src/core";
import {
  beginImplementRun,
  bindLinearSessionTask,
  bindWorkItemRepository,
  consumeWorkspaceBootstrap,
  insertQueuedItem,
  putWorkspaceUser,
  recordLinearInstallation,
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
const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "paws-phantom-"));
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
  const enroll = async (name: string, ready: number) => {
    const enrollment = { name, csr: (await createRunnerKey(join(root, name))).csr };
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
      (q) => q.orm.insert(q.t.runnerPolicy).values({ runnerId: runnerId }),
      (q) =>
        q.orm
          .insert(q.t.runnerAgentPolicy)
          .values({ runnerId: runnerId, agent: "codex", ready: ready }),
    );
    await seed(store, (q) => q.orm.insert(q.t.runnerCapacity).values({ runnerId, capacity: 1 }));
    return runnerId;
  };
  const agentbox = await enroll("agentbox", 1);
  const goldbox = await enroll("goldbox", 0);
  const work = createRunnerWork({
    store,
    keyId: "acme",
    privateKey: generateKeyPairSync("ed25519").privateKey,
    eventKey: Buffer.alloc(32, 7),
    now: () => clock,
  });
  const health = createRunnerHealth({ store, work, now: () => clock });
  const backend = createRemoteAgentRunner({
    store,
    work,
    results: createRunnerResults({ store, work }),
    health,
    now: () => clock,
    pollIntervalMs: 5,
    placement: createRunnerPlacement({ store, now: () => clock }),
    async fetchCandidate() {
      throw new Error("This fixture does not return a candidate");
    },
  });
  for (const id of [agentbox, goldbox]) await work.heartbeat(id, 1);
  let sequence = 0;
  const item = async (held = false) => {
    const id = `acme-${++sequence}`;
    const sessionId = `acme-session-${sequence}`;
    const record = await insertQueuedItem(store, { id, now: clock, sessionKey: sessionId });
    const { run } = await beginImplementRun(store, id, clock);
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
      q.orm.update(q.t.workItem).set({ ownerUserId: userId }).where(eq(q.t.workItem.id, id)),
    );
    await bindWorkItemRepository(store, id, {
      owner: "acme",
      repo: "fixture",
      remoteUrl: "https://github.com/acme/fixture.git",
    });
    mkdirSync(join(root, id), { recursive: true });
    if (held)
      await seed(store, (q) =>
        q.orm.insert(q.t.runnerWork).values({
          runId: run.id,
          runnerId: goldbox,
          workspaceId: workspace.id,
          generation: 1,
          runnerFence: 0,
          commandId: `ended-${id}`,
          leaseUntil: 0,
          endedAt: clock,
          teardownConfirmedAt: clock,
        }),
      );
    return backend.forItem(id)({
      profile: { agent: "codex", model: "model" },
      role: "implementer",
      itemId: id,
      runId: run.id,
      prompt: "Prepare acme",
      worktreePath: join(root, id),
      pawsRoot: root,
      prepareOnly: true,
      async networkGit() {
        throw new Error("Preparation does not reach Git");
      },
    });
  };
  const probe = async (runnerId: string) => {
    for (const until = performance.now() + 5_000; performance.now() < until; await Bun.sleep(5))
      for (const envelope of await work.commands(runnerId)) {
        const command = JSON.parse(Buffer.from(envelope.payload, "base64url").toString());
        if (command.type === "probe") return command as RunnerCommand;
      }
    throw new Error(`no probe on ${runnerId}`);
  };
  return {
    db: store,
    agentbox,
    goldbox,
    health,
    item,
    probe,
    tick: (ms: number) => (clock += ms),
    heartbeat: (id: string) => work.heartbeat(id, 1),
  };
}

async function failOnAgentbox(f: Awaited<ReturnType<typeof fixture>>, fail = true) {
  const failed = f.item(true);
  void failed.catch(() => undefined);
  const command = await f.probe(f.agentbox);
  if (fail) {
    await f.health.submit(f.agentbox, {
      executionId: workspaceId(),
      commandId: command.id,
      role: "implementer",
      stopReason: "end_turn",
      timedOut: false,
      cancelled: false,
      authRequired: false,
      agentExited: true,
      errorMessage: "agent exited with code 1",
    });
    expect((await failed).errorMessage).toBe("agent exited with code 1");
  }
  await seed(f.db, (q) =>
    q.orm
      .update(q.t.runnerAgentPolicy)
      .set({ ready: 1 })
      .where(eq(q.t.runnerAgentPolicy.runnerId, f.goldbox)),
  );
  f.tick(90_000);
  await f.heartbeat(f.goldbox);
}

test("a run held on B whose preflight failed on A, with A then offline, does not count against B", async () => {
  const f = await fixture();
  await failOnAgentbox(f);
  const next = f.item();
  void next.catch(() => undefined);
  expect((await f.probe(f.goldbox)).type).toBe("probe");
});

test("a run held between commands keeps its slot, and the rejection names what fills it", async () => {
  const f = await fixture();
  await failOnAgentbox(f, false);
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    await expect(f.item()).rejects.toBeInstanceOf(RunnerCapacityWait);
    expect(warn).toHaveBeenCalledWith("Runner placement failed", {
      itemId: "acme-2",
      role: "implementer",
      purpose: "prepare",
      rejected: [
        "agentbox: offline",
        "goldbox: no free capacity (work 0, unassigned 0, between commands 1, pinned 0 of 1)",
      ],
    });
  } finally {
    warn.mockRestore();
  }
});
