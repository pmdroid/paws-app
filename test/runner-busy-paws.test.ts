import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { count, eq } from "drizzle-orm";
import {
  beginImplementRun,
  bindLinearSessionTask,
  bindWorkItemRepository,
  consumeWorkspaceBootstrap,
  insertQueuedItem,
  putWorkspaceUser,
  recordLinearInstallation,
} from "../src/db";
import { createRunnerControl } from "../src/runner-control";
import { createRunnerKey, initializeRunnerAuthority } from "../src/runner-identity";
import type { RunnerCommand } from "../src/runner-protocol";
import { createRunnerResults } from "../src/runner-results";
import { createRunnerWork, createRunnerWorkHttp, type RunnerWork } from "../src/runner-work";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../src/workspace";
import { jsonValue, seed } from "./dialects";
import { tempStore } from "./pglite";

const repository = {
  owner: "fixture",
  repo: "repository",
  remoteUrl: "https://github.com/fixture/repository.git",
  baseSha: "a".repeat(40),
};

/** One run leased to a runner whose only slot is full, at a clock the test moves. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "paws-busy-"));
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
  await seed(db, (q) =>
    q.orm.update(q.t.runner).set({ status: "active" }).where(eq(q.t.runner.id, runnerId)),
  );
  const item = await insertQueuedItem(db, { id: "item", now: now(), sessionKey: "session" });
  const { run } = await beginImplementRun(db, item.id, now());
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
  const work = createRunnerWork({
    store: db,
    keyId: "fixture",
    privateKey: keys.privateKey,
    eventKey: Buffer.alloc(32, 7),
    now,
  });
  const command: Extract<RunnerCommand, { type: "run" }> = {
    type: "run",
    id: workspaceId(),
    runnerId,
    workspaceId: workspace.id,
    issuedAt: now(),
    expiresAt: now() + 3_600_000,
    runId: run.id,
    itemId: item.id,
    generation: 1,
    repository,
    profile: { agent: "codex", model: "scripted" },
    prompt: "Fixture",
  };
  await work.assign(command);
  await work.acknowledge(runnerId, command.id);
  const grant = await work.issueGrant({
    runnerId,
    runId: run.id,
    commandId: command.id,
    generation: 1,
  });
  // A helper holds the runner's only slot, so the runner has no capacity left.
  await seed(db, (q) =>
    q.orm.insert(q.t.runnerHelper).values({
      id: "busy",
      runnerId,
      workspaceId: workspace.id,
      sessionId: "session",
      sessionGeneration: 0,
      runnerFence: 0,
      envelope: jsonValue(q, {}),
      expiresAt: now() + 3_600_000,
    }),
  );
  const grants = async () => {
    const [row] = await db.run((q) =>
      q.all(
        q.orm
          .select({ n: count() })
          .from(q.t.runnerWorkGrant)
          .where(eq(q.t.runnerWorkGrant.runId, run.id)),
      ),
    );
    return Number(row!.n);
  };
  return {
    db,
    clock,
    runnerId,
    run,
    command,
    work,
    grant,
    grants,
    results: () => createRunnerResults({ store: db, work, now }),
    async close() {
      await close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const running = (runId: string) => [{ runId, generation: 1 }];

test("a heartbeat 70 s late for a run the runner reports, on a full runner, renews the lease and keeps the grant", async () => {
  const f = await fixture();
  try {
    expect(
      (
        await f.work.heartbeat(
          f.runnerId,
          1,
          {},
          undefined,
          undefined,
          undefined,
          undefined,
          running(f.run.id),
        )
      ).fenced,
    ).toEqual([]);
    f.clock.at += 60_000 + 70_000;
    // Before the late heartbeat lands, the run's own requests still see it as reported.
    const renewed = await f.work.issueGrant({
      runnerId: f.runnerId,
      runId: f.run.id,
      commandId: f.command.id,
      generation: 1,
    });
    expect(renewed.expiresAt).toBeGreaterThan(f.clock.at);
    f.clock.at += 5_000;
    const reply = await f.work.heartbeat(
      f.runnerId,
      1,
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      running(f.run.id),
    );
    expect(reply.fenced).toEqual([]);
    expect(reply.leases).toEqual([
      { runId: f.run.id, generation: 1, expiresAt: f.clock.at + 60_000 },
    ]);
    expect(await f.grants()).toBe(1);
    expect(
      await f.results().answers({
        runnerId: f.runnerId,
        runId: f.run.id,
        generation: 1,
        after: 0,
        token: renewed.token,
      }),
    ).toEqual([]);
  } finally {
    await f.close();
  }
}, 30_000);

test("the same late run on a full runner is fenced when the runner does not report it", async () => {
  const f = await fixture();
  try {
    f.clock.at += 60_000 + 70_000;
    const reply = await f.work.heartbeat(
      f.runnerId,
      1,
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      [],
    );
    expect(reply.fenced).toEqual(running(f.run.id));
    expect(reply.leases).toEqual([]);
    expect(await f.grants()).toBe(0);
  } finally {
    await f.close();
  }
}, 30_000);

test("a runner that does not report its work keeps today's rule: a full runner is fenced", async () => {
  const f = await fixture();
  try {
    f.clock.at += 60_000 + 70_000;
    const reply = await f.work.heartbeat(f.runnerId);
    expect(reply.fenced).toEqual(running(f.run.id));
    expect(await f.grants()).toBe(0);
  } finally {
    await f.close();
  }
}, 30_000);

test("a run reported earlier but left out of the latest report gets no grace on a full runner", async () => {
  const f = await fixture();
  try {
    await f.work.heartbeat(
      f.runnerId,
      1,
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      running(f.run.id),
    );
    await seed(f.db, (q) =>
      q.orm
        .update(q.t.runner)
        .set({ liveReportedAt: f.clock.at + 1 })
        .where(eq(q.t.runner.id, f.runnerId)),
    );
    f.clock.at += 60_000 + 70_000;
    await expect(
      f.work.issueGrant({
        runnerId: f.runnerId,
        runId: f.run.id,
        commandId: f.command.id,
        generation: 1,
      }),
    ).rejects.toThrow("Runner work is fenced or its lease expired.");
  } finally {
    await f.close();
  }
}, 30_000);

const post = (path: string, body: unknown, authorization?: string) =>
  new Request(`https://paws-runner.invalid${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify(body),
  });

test("a timed-out runner work handler answers 503, and a bad token still answers 403", async () => {
  const f = await fixture();
  try {
    const http = createRunnerWorkHttp(f.work);
    const wrong = (await http(
      post(
        "/v1/events",
        { runId: f.run.id, generation: 1, sequence: 1, event: { type: "output", text: "hi" } },
        `Bearer ${"x".repeat(43)}`,
      ),
      f.runnerId,
    ))!;
    expect(wrong.status).toBe(403);
    const malformed = (await http(post("/v1/events", {}, "Bearer bad"), f.runnerId))!;
    expect(malformed.status).toBe(403);
    const answers = (await f
      .results()
      .fetch(
        post(
          `/v1/runs/${f.run.id}/answers`,
          { generation: 1, after: 0 },
          `Bearer ${"x".repeat(43)}`,
        ),
        f.runnerId,
      ))!;
    expect(answers.status).toBe(403);
    const fake = {
      heartbeat() {
        throw new DOMException("The operation timed out.", "TimeoutError");
      },
    } as unknown as RunnerWork;
    expect((await createRunnerWorkHttp(fake)(post("/v1/heartbeat", {}), f.runnerId))!.status).toBe(
      503,
    );
  } finally {
    await f.close();
  }
}, 30_000);
