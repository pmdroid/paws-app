import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  attachableRunnerWorkSteps,
  consumeRunnerWorkSequenceSteps,
  enqueueJobSteps,
  insertRunnerTranscriptSteps,
  itemRunResultsSteps,
  itemStartedRunnerWorkSteps,
  jobStatusByKeySteps,
  loseRunnerWorkSteps,
  plaintextTranscriptChunksSteps,
  runnerTranscriptSteps,
  runnerWorkCommandSteps,
  runnerWorkGenerationSteps,
  runnerWorkLivenessSteps,
  runnerWorkRunnersSteps,
  runnerWorkUnreachableSteps,
  runWaitsOnQuestionSteps,
  sealRunnerTranscriptSteps,
  setRunnerTranscriptUriSteps,
  usableRecentRunnersSteps,
  usageLimitResetSteps,
  type Db,
  type Q,
} from "../src/db";
import { forEachDialect, jsonValue, seed, withoutForeignKeys, type DialectDb } from "./dialects";

const opened: DialectDb[] = [];
afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.close();
});

async function connect(open: () => Promise<DialectDb>): Promise<Db> {
  const handle = await open();
  opened.push(handle);
  await withoutForeignKeys(handle.db);
  return handle.db;
}

const runner =
  (id: string, fields: Record<string, unknown> = {}) =>
  (q: Q) =>
    q.orm.insert(q.t.runner).values({
      id,
      workspaceId: "acme",
      ownerUserId: "owner",
      name: id,
      status: "active",
      createdAt: 0,
      ...fields,
    });

const run = (id: string, itemId: string) => (q: Q) =>
  q.orm.insert(q.t.run).values({
    id,
    itemId,
    kind: "implement",
    agent: "codex",
    status: "active",
    createdAt: 0,
    updatedAt: 0,
  });

const command =
  (id: string, kind: string, envelope: unknown, fields: Record<string, unknown> = {}) =>
  (q: Q) =>
    q.orm.insert(q.t.runnerCommand).values({
      id,
      runnerId: "box",
      kind,
      envelope: jsonValue(q, envelope),
      expiresAt: 0,
      ...fields,
    });

const work =
  (runId: string, fields: Record<string, unknown> = {}) =>
  (q: Q) =>
    q.orm.insert(q.t.runnerWork).values({
      runId,
      runnerId: "box",
      workspaceId: "acme",
      generation: 1,
      runnerFence: 0,
      commandId: `command-${runId}`,
      leaseUntil: 1_000,
      ...fields,
    });

const result =
  (runId: string, generation: number, commandId: string, payload: unknown, receivedAt: number) =>
  (q: Q) =>
    q.orm.insert(q.t.runnerResult).values({
      runId,
      generation,
      commandId,
      payload: jsonValue(q, payload),
      receivedAt,
    });

forEachDialect((open) => {
  test("an item's run results come newest first, run commands only", async () => {
    const db = await connect(open);
    await seed(
      db,
      run("r1", "item"),
      run("r2", "item"),
      run("other", "elsewhere"),
      command("c1", "run", { payload: "one" }),
      command("c2", "run", { payload: "two" }, { runnerId: "next" }),
      command("c3", "review", { payload: "review" }),
      command("c4", "run", { payload: "other" }),
      result("r1", 1, "c1", { sessionId: "s1" }, 10),
      result("r2", 1, "c2", { sessionId: "s2" }, 20),
      result("r2", 2, "c3", { sessionId: "s3" }, 30),
      result("other", 1, "c4", { sessionId: "s4" }, 40),
    );
    const rows = await db.run((q) => itemRunResultsSteps(q, "item"));
    expect(
      rows.map((row) => [row.runnerId, JSON.parse(row.envelope), JSON.parse(row.payload)]),
    ).toEqual([
      ["next", { payload: "two" }, { sessionId: "s2" }],
      ["box", { payload: "one" }, { sessionId: "s1" }],
    ]);
    expect(rows.map((row) => row.receivedAt)).toEqual([20, 10]);
    expect((await db.run((q) => itemRunResultsSteps(q, "item", 1))).map((r) => r.runnerId)).toEqual(
      ["next"],
    );
  });

  test("a run's work names its runner and command, or no command once it is gone", async () => {
    const db = await connect(open);
    await seed(
      db,
      command("command-r1", "review", { payload: "p" }),
      work("r1"),
      work("r2", { runnerId: "other", commandId: "missing" }),
    );
    const withCommand = await db.run((q) => runnerWorkCommandSteps(q, "r1"));
    expect(withCommand?.runnerId).toBe("box");
    expect(withCommand?.kind).toBe("review");
    expect(JSON.parse(withCommand!.envelope!)).toEqual({ payload: "p" });
    expect(await db.run((q) => runnerWorkCommandSteps(q, "r2"))).toEqual({
      runnerId: "other",
      kind: null,
      envelope: null,
    });
    expect(await db.run((q) => runnerWorkCommandSteps(q, "none"))).toBeNull();
  });

  test("runner work maps the given runs to their runners", async () => {
    const db = await connect(open);
    await seed(db, work("r1"), work("r2", { runnerId: "other" }), work("r3"));
    expect(await db.run((q) => runnerWorkRunnersSteps(q, ["r1", "r2", "none"]))).toEqual(
      new Map([
        ["r1", "box"],
        ["r2", "other"],
      ]),
    );
    expect((await db.run((q) => runnerWorkRunnersSteps(q, []))).size).toBe(0);
  });

  test("open work attaches while its lease holds or its result is stored", async () => {
    const db = await connect(open);
    await seed(
      db,
      command("command-live", "run", { payload: "live" }),
      command("command-stored", "run", { payload: "stored" }),
      command("command-expired", "run", { payload: "expired" }),
      command("command-ended", "run", { payload: "ended" }),
      work("live", { leaseUntil: 200, consumedSequence: 4, generation: 2 }),
      work("stored", { leaseUntil: 50 }),
      result("stored", 1, "command-stored", {}, 0),
      work("expired", { leaseUntil: 50 }),
      work("ended", { leaseUntil: 200, endedAt: 1 }),
    );
    const live = await db.run((q) => attachableRunnerWorkSteps(q, "live", 100));
    expect({ ...live, envelope: JSON.parse(live!.envelope) }).toEqual({
      runnerId: "box",
      workspaceId: "acme",
      envelope: { payload: "live" },
      cursor: 4,
      generation: 2,
    });
    expect((await db.run((q) => attachableRunnerWorkSteps(q, "stored", 100)))?.runnerId).toBe(
      "box",
    );
    expect(await db.run((q) => attachableRunnerWorkSteps(q, "expired", 100))).toBeNull();
    expect(await db.run((q) => attachableRunnerWorkSteps(q, "ended", 100))).toBeNull();
  });

  test("runner work reports its generation, liveness and consumed sequence", async () => {
    const db = await connect(open);
    await seed(
      db,
      command("command-r1", "run", { payload: "p" }),
      work("r1", { generation: 3, confirmedAt: 7 }),
    );
    expect(await db.run((q) => runnerWorkGenerationSteps(q, "r1"))).toBe(3);
    expect(await db.run((q) => runnerWorkGenerationSteps(q, "none"))).toBeNull();
    expect(await db.run((q) => runnerWorkLivenessSteps(q, "r1", 3))).toEqual({
      confirmedAt: 7,
      lostAt: null,
    });
    expect(await db.run((q) => runnerWorkLivenessSteps(q, "r1", 2))).toBeNull();
    await db.run((q) => consumeRunnerWorkSequenceSteps(q, "r1", 2, 9));
    await db.run((q) => consumeRunnerWorkSequenceSteps(q, "r1", 3, 5));
    const row = await db.run((q) => attachableRunnerWorkSteps(q, "r1", 0));
    expect(row?.cursor).toBe(5);
  });

  test("a lost run ends its open work once and drops its grants", async () => {
    const db = await connect(open);
    await seed(db, work("r1", { generation: 2 }), (q) =>
      q.orm
        .insert(q.t.runnerWorkGrant)
        .values({ tokenHash: "t", runId: "r1", generation: 2, expiresAt: 0 }),
    );
    await db.run((q) => loseRunnerWorkSteps(q, "r1", 2, 40));
    await db.run((q) => loseRunnerWorkSteps(q, "r1", 2, 80));
    expect(await db.run((q) => runnerWorkLivenessSteps(q, "r1", 2))).toEqual({
      confirmedAt: null,
      lostAt: 40,
    });
    expect(await db.run((q) => attachableRunnerWorkSteps(q, "r1", 0))).toBeNull();
    const grants = await db.run((q) => q.all(q.orm.select().from(q.t.runnerWorkGrant)));
    expect(grants).toEqual([]);
  });

  test("open work is unreachable when its leased runner has gone quiet", async () => {
    const db = await connect(open);
    await seed(
      db,
      runner("box", { lastSeenAt: 50 }),
      runner("silent"),
      work("r1", { leaseUntil: 200 }),
      work("r2", { runnerId: "silent", leaseUntil: 200 }),
    );
    const unreachable = (runId: string, seenBefore: number, leaseCutoff = 100) =>
      db.run((q) =>
        runnerWorkUnreachableSteps(q, { runId, generation: 1, leaseCutoff, seenBefore }),
      );
    expect(await unreachable("r1", 60)).toBe(true);
    expect(await unreachable("r1", 40)).toBe(false);
    expect(await unreachable("r1", 60, 300)).toBe(false);
    expect(await unreachable("r2", 0)).toBe(true);
  });

  test("a usage limit resets at the earliest cooldown or recheck in the session's workspace", async () => {
    const db = await connect(open);
    await seed(
      db,
      (q) =>
        q.orm.insert(q.t.workspace).values([
          { id: "acme", linearOrganizationId: "org", name: "Acme", createdAt: 0 },
          { id: "other", linearOrganizationId: "org-2", name: "Other", createdAt: 0 },
        ]),
      (q) =>
        q.orm
          .insert(q.t.linearSession)
          .values({ sessionId: "s", organizationId: "org", createdAt: 0 }),
      runner("box"),
      runner("revoked", { revokedAt: 1 }),
      runner("away", { workspaceId: "other" }),
      (q) =>
        q.orm.insert(q.t.runnerAgentPolicy).values([
          { runnerId: "box", agent: "codex", cooldownUntil: 500 },
          { runnerId: "revoked", agent: "codex", cooldownUntil: 150 },
          { runnerId: "away", agent: "codex", cooldownUntil: 150 },
          { runnerId: "box", agent: "claude", cooldownUntil: 150 },
        ]),
    );
    const health = (scopeId: string, fields: Record<string, unknown>) => (q: Q) =>
      q.orm.insert(q.t.agentAccountHealth).values({
        kind: "quota",
        scope: "account",
        scopeId,
        workspaceId: "acme",
        agent: "codex",
        state: "exhausted",
        source: "result",
        sourceId: scopeId,
        bindingId: "binding",
        runnerId: "box",
        observedAt: 0,
        updatedAt: 0,
        ...fields,
      });
    const reset = (sessionId: string | null, now = 100) =>
      db.run((q) => usageLimitResetSteps(q, "codex", sessionId, now));
    expect(await reset("s")).toBe(500);
    await seed(
      db,
      health("a", { nextCheckAt: 300 }),
      health("b", { nextCheckAt: 120, scope: "binding" }),
      health("c", { nextCheckAt: 130, state: "ok" }),
      health("d", { nextCheckAt: 140, runnerId: "away" }),
    );
    expect(await reset("s")).toBe(300);
    expect(await reset("s", 400)).toBe(500);
    expect(await reset("s", 600)).toBeNull();
    expect(await reset("unknown")).toBeNull();
    expect(await reset(null)).toBeNull();
  });

  test("fallback candidates are recent active runners whose owner is a usable member", async () => {
    const db = await connect(open);
    const member =
      (userId: string, fields: Record<string, unknown> = {}) =>
      (q: Q) =>
        q.orm.insert(q.t.workspaceMember).values({
          workspaceId: "acme",
          userId,
          role: "member",
          source: "linear",
          active: 1,
          checkedAt: 0,
          ...fields,
        });
    await seed(
      db,
      member("owner"),
      member("inactive", { active: 0 }),
      member("revoked", { revokedAt: 1 }),
      runner("older", { lastSeenAt: 200 }),
      runner("newer", { lastSeenAt: 300 }),
      runner("b-tie", { lastSeenAt: 200 }),
      runner("stale", { lastSeenAt: 50 }),
      runner("paused", { status: "paused", lastSeenAt: 300 }),
      runner("gone", { revokedAt: 1, lastSeenAt: 300 }),
      runner("inactive", { ownerUserId: "inactive", lastSeenAt: 300 }),
      runner("revoked", { ownerUserId: "revoked", lastSeenAt: 300 }),
    );
    expect(await db.run((q) => usableRecentRunnersSteps(q, 100))).toEqual([
      { id: "newer", workspaceId: "acme" },
      { id: "b-tie", workspaceId: "acme" },
      { id: "older", workspaceId: "acme" },
    ]);
  });

  test("an item has started work once any runner ran a work command for it", async () => {
    const db = await connect(open);
    const usage = (commandId: string, itemId: string, purpose: string) => (q: Q) =>
      q.orm.insert(q.t.runnerExecutionUsage).values({
        commandId,
        runnerId: "box",
        ownerUserId: "owner",
        itemId,
        role: "implementer",
        purpose,
        startedAt: 0,
      });
    await seed(db, usage("c1", "prepared", "prepare"), usage("c2", "worked", "work"));
    expect(await db.run((q) => itemStartedRunnerWorkSteps(q, "worked"))).toBe(true);
    expect(await db.run((q) => itemStartedRunnerWorkSteps(q, "prepared"))).toBe(false);
  });

  test("a run waits on a question until its stored questions are answered or cancelled", async () => {
    const db = await connect(open);
    const question =
      (id: string, runId: string, status: string, cancelledAt: number | null = null) =>
      (q: Q) =>
        q.orm.insert(q.t.question).values({
          id,
          itemId: "item",
          runId,
          sessionId: `session-${id}`,
          body: "?",
          status,
          createdAt: 0,
          cancelledAt,
        });
    await seed(
      db,
      question("q1", "answered", "answered"),
      question("q2", "cancelled", "open", 5),
      question("q3", "open", "answered"),
      question("q4", "open", "queued"),
    );
    const waits = (runId: string) => db.run((q) => runWaitsOnQuestionSteps(q, runId));
    expect(await waits("unstored")).toBe(true);
    expect(await waits("answered")).toBe(false);
    expect(await waits("cancelled")).toBe(false);
    expect(await waits("open")).toBe(true);
  });

  test("a job's status reads by its key", async () => {
    const db = await connect(open);
    expect(await db.run((q) => jobStatusByKeySteps(q, "once"))).toBeNull();
    await db.run(function* (q) {
      const id = yield* enqueueJobSteps(q, { queue: "tick", jobKey: "once", now: 0 });
      expect(yield* jobStatusByKeySteps(q, "once")).toBe("pending");
      yield* q.exec(q.orm.update(q.t.job).set({ status: "done" }).where(eq(q.t.job.id, id)));
    });
    expect(await db.run((q) => jobStatusByKeySteps(q, "once"))).toBe("done");
  });

  test("a transcript row is stored, sealed and given its URI", async () => {
    const db = await connect(open);
    await db.run((q) =>
      insertRunnerTranscriptSteps(q, {
        runId: "r1",
        generation: 1,
        commandId: "c1",
        workspaceId: "acme",
        executionId: "e1",
      }),
    );
    expect(await db.run((q) => runnerTranscriptSteps(q, "r1", 1))).toEqual({
      commandId: "c1",
      workspaceId: "acme",
      executionId: "e1",
      sizeBytes: 0,
      sealedSize: null,
      sha256: null,
      uri: null,
    });
    expect(await db.run((q) => runnerTranscriptSteps(q, "r1", 2))).toBeNull();
    await db.run((q) =>
      sealRunnerTranscriptSteps(q, {
        runId: "r1",
        generation: 1,
        sizeBytes: 0,
        sha256: "a".repeat(64),
      }),
    );
    await db.run((q) => setRunnerTranscriptUriSteps(q, "r1", 1, "paws-run-file:transcript/x"));
    expect(await db.run((q) => runnerTranscriptSteps(q, "r1", 1))).toMatchObject({
      sealedSize: 0,
      sha256: "a".repeat(64),
      uri: "paws-run-file:transcript/x",
    });
  });

  test("plaintext transcript chunks page in key order after the last one", async () => {
    const db = await connect(open);
    const transcript = (runId: string, generation: number) => (q: Q) =>
      q.orm.insert(q.t.runnerTranscript).values({
        runId,
        generation,
        commandId: `c-${runId}-${generation}`,
        workspaceId: "acme",
        executionId: `e-${runId}`,
      });
    const chunk =
      (runId: string, generation: number, offset: number, keyId: string | null = null) =>
      (q: Q) =>
        q.orm.insert(q.t.runnerTranscriptChunk).values({
          runId,
          generation,
          offset,
          sizeBytes: 1,
          sha256: "b".repeat(64),
          keyId,
        });
    await seed(
      db,
      transcript("a", 1),
      transcript("a", 2),
      transcript("b", 1),
      chunk("a", 1, 0),
      chunk("a", 1, 1, "k".repeat(64)),
      chunk("a", 1, 2),
      chunk("a", 2, 0),
      chunk("b", 1, 0),
    );
    const page = async (after: readonly [string, number, number], limit: number) =>
      (await db.run((q) => plaintextTranscriptChunksSteps(q, after, limit))).map(
        (row) => `${row.runId}/${row.generation}/${row.offset}`,
      );
    expect(await page(["", 0, -1], 2)).toEqual(["a/1/0", "a/1/2"]);
    expect(await page(["a", 1, 2], 2)).toEqual(["a/2/0", "b/1/0"]);
    expect(await page(["b", 1, 0], 2)).toEqual([]);
    const [first] = await db.run((q) => plaintextTranscriptChunksSteps(q, ["", 0, -1], 1));
    expect(first).toEqual({
      runId: "a",
      generation: 1,
      offset: 0,
      sizeBytes: 1,
      sha256: "b".repeat(64),
      workspaceId: "acme",
      commandId: "c-a-1",
      executionId: "e-a",
    });
  });
});
