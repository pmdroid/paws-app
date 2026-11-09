import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginRetroCollectionSteps,
  closeRetroSteps,
  createRetroSteps,
  failRetroAttemptSteps,
  freezeRetroInputSteps,
  getRetroSettingsRevisionSteps,
  getRetroSteps,
  latestRetroSettingsRevisionSteps,
  listRetroAttemptsSteps,
  listRetroCoverageGapsSteps,
  listRetroEvidenceSteps,
  listRetroItemsSteps,
  listRetrosSteps,
  publishRetroSteps,
  readRetroArtifactSteps,
  recordRetroCoverageGapSteps,
  recordRetroEvidenceSteps,
  recordRetroScheduleRunSteps,
  recordRetroScheduleStateSteps,
  retroArtifactSteps,
  retroRepositoriesSteps,
  retroScheduleRuntimeSteps,
  retroWatermarksSteps,
  saveRetroSettingsRevisionSteps,
  startRetroAttemptSteps,
  writeRetroArtifactSteps,
  type Db,
  type RetroItemInput,
} from "../src/db";
import { forEachDialect, withoutForeignKeys, type DialectDb } from "./dialects";

const REPO = "pmdroid/paws-app";
const OTHER = "pmdroid/other";

const open: DialectDb[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function connected(connect: () => Promise<DialectDb>) {
  const handle = await connect();
  open.push(handle);
  await withoutForeignKeys(handle.db);
  return handle.db;
}

function artifactRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "paws-retro-dialects-"));
  roots.push(root);
  return join(root, "artifacts");
}

function settings(db: Db, repositories = [REPO, OTHER], now = 1) {
  return db.transaction((q) =>
    saveRetroSettingsRevisionSteps(q, {
      workspaceId: "ws",
      prompt: "Review {{digest}}",
      agentProfile: { agent: "codex", effort: "high" },
      repositories,
      outputLimits: { maxItems: 5 },
      executionLimits: { retries: 1 },
      schedule: { cadence: "weekly" },
      createdBy: "pascal",
      now,
    }),
  );
}

function retro(db: Db, id: string, windowStart: number, repositories?: string[]) {
  return db.transaction((q) =>
    createRetroSteps(q, {
      id,
      workspaceId: "ws",
      windowStart,
      windowEnd: windowStart + 10,
      origin: "manual",
      settingsRevision: 1,
      repositories,
      now: windowStart,
    }),
  );
}

async function collected(db: Db, root: string, id = "r1", windowStart = 0) {
  await retro(db, id, windowStart, [REPO]);
  await db.transaction((q) => beginRetroCollectionSteps(q, { retroId: id, now: 1 }));
  await db.transaction((q) =>
    recordRetroEvidenceSteps(q, id, [
      {
        evidenceId: "e1",
        repository: REPO,
        sourceKind: "pull_request",
        sourceRef: "#1",
        occurredAt: 3,
        excerpt: "slow review",
      },
    ]),
  );
  for (const kind of ["digest", "manifest"] as const)
    await db.run((q) =>
      writeRetroArtifactSteps(q, root, {
        retroId: id,
        kind,
        bytes: new TextEncoder().encode(kind),
        now: 2,
      }),
    );
}

function freeze(db: Db, retroId: string, end: number) {
  return db.transaction((q) =>
    freezeRetroInputSteps(q, { retroId, endCursors: { [REPO.toUpperCase()]: end }, now: 5 }),
  );
}

function start(db: Db, retroId: string, now: number, maxAttempts?: number) {
  return db.transaction((q) =>
    startRetroAttemptSteps(q, { retroId, owner: "runner", now, leaseMs: 10, maxAttempts }),
  );
}

const item: RetroItemInput = {
  itemId: "i1",
  repository: REPO,
  area: "review",
  actionStep: "rule",
  title: "Review sooner",
  problem: "Reviews wait",
  proposedChange: "Ask earlier",
  verificationCriterion: "Reviews start within a day",
  evidenceIds: ["e1"],
};

function publish(db: Db, retroId: string, attempt: number, items = [item], owner = "runner") {
  return db.transaction((q) =>
    publishRetroSteps(q, { retroId, attempt, owner, result: { items: 1 }, items, now: 30 }),
  );
}

forEachDialect((connect) => {
  test("settings revisions number per workspace and keep their JSON", async () => {
    const db = await connected(connect);
    expect((await settings(db)).revision).toBe(1);
    const second = await settings(db, [REPO], 2);
    expect(second).toEqual({
      workspaceId: "ws",
      revision: 2,
      prompt: "Review {{digest}}",
      agentProfile: { agent: "codex", effort: "high" },
      repositories: [REPO],
      outputLimits: { maxItems: 5 },
      executionLimits: { retries: 1 },
      schedule: { cadence: "weekly" },
      createdBy: "pascal",
      createdAt: 2,
    });
    expect(await db.run((q) => latestRetroSettingsRevisionSteps(q, "ws"))).toEqual(second);
    expect((await db.run((q) => getRetroSettingsRevisionSteps(q, "ws", 1)))?.repositories).toEqual([
      REPO,
      OTHER,
    ]);
    expect(await db.run((q) => getRetroSettingsRevisionSteps(q, "ws", 3))).toBeNull();
    expect(await db.run((q) => latestRetroSettingsRevisionSteps(q, "none"))).toBeNull();
  });

  test("a window has one retro, frozen from its settings, listed newest first", async () => {
    const db = await connected(connect);
    await settings(db);
    const first = await retro(db, "r1", 0, [REPO]);
    expect(first.created).toBe(true);
    expect(first.retro).toMatchObject({
      id: "r1",
      origin: "manual",
      scheduledFor: null,
      settingsRevision: 1,
      agentProfile: { agent: "codex", effort: "high" },
      repositories: [REPO],
      outputLimits: { maxItems: 5 },
      state: "collecting",
      attempt: 0,
      owner: null,
      result: null,
      publishedAt: null,
    });
    expect((await retro(db, "r1-again", 0)).created).toBe(false);
    await retro(db, "r2", 20);
    expect((await db.run((q) => listRetrosSteps(q, "ws"))).map((row) => row.id)).toEqual([
      "r2",
      "r1",
    ]);
    expect(await db.run((q) => getRetroSteps(q, "missing"))).toBeNull();
    await expect(retro(db, "r3", 40, ["someone/else"])).rejects.toThrow(
      "must come from settings revision 1",
    );
  });

  test("collection locks repositories and starts from the watermark", async () => {
    const db = await connected(connect);
    await settings(db);
    await retro(db, "r1", 0, [REPO, OTHER]);
    const begun = await db.transaction((q) =>
      beginRetroCollectionSteps(q, { retroId: "r1", initialCursors: { [OTHER]: 7 }, now: 1 }),
    );
    expect(begun).toEqual({
      ok: true,
      repositories: [
        { repository: OTHER, startCursor: 7, endCursor: null },
        { repository: REPO, startCursor: 0, endCursor: null },
      ],
    });
    await retro(db, "r2", 20, [REPO.toUpperCase()]);
    expect(
      await db.transaction((q) => beginRetroCollectionSteps(q, { retroId: "r2", now: 2 })),
    ).toEqual({
      ok: false,
      reason: "busy",
      busy: [{ repository: REPO.toUpperCase(), retroId: "r1" }],
    });
    expect(
      await db.transaction((q) => beginRetroCollectionSteps(q, { retroId: "missing", now: 2 })),
    ).toEqual({ ok: false, reason: "not_collecting" });
    expect(await db.run((q) => retroRepositoriesSteps(q, "r1"))).toHaveLength(2);
  });

  test("evidence is stored once and a conflicting copy is refused", async () => {
    const db = await connected(connect);
    await settings(db);
    await retro(db, "r1", 0, [REPO]);
    const entry = {
      evidenceId: "e1",
      repository: REPO,
      sourceKind: "pull_request",
      sourceRef: "#1",
      occurredAt: 3,
      excerpt: "slow review",
    };
    await db.transaction((q) => recordRetroEvidenceSteps(q, "r1", [entry]));
    await db.transaction((q) =>
      recordRetroEvidenceSteps(q, "r1", [{ ...entry, repository: REPO.toUpperCase() }]),
    );
    expect(await db.run((q) => listRetroEvidenceSteps(q, "r1"))).toEqual([entry]);
    await expect(
      db.transaction((q) => recordRetroEvidenceSteps(q, "r1", [{ ...entry, excerpt: "other" }])),
    ).rejects.toThrow("already stored with other content");
    await expect(
      db.transaction((q) => recordRetroEvidenceSteps(q, "missing", [entry])),
    ).rejects.toThrow("is not collecting evidence");
  });

  test("coverage gaps list in the order they were recorded", async () => {
    const db = await connected(connect);
    await db.run((q) =>
      recordRetroCoverageGapSteps(q, {
        retroId: "r1",
        repository: REPO,
        kind: "retention_gap",
        detail: "first",
        now: 2,
      }),
    );
    await db.run((q) =>
      recordRetroCoverageGapSteps(q, {
        retroId: "r1",
        kind: "source_unavailable",
        detail: "second",
        now: 1,
      }),
    );
    expect(await db.run((q) => listRetroCoverageGapsSteps(q, "r1"))).toEqual([
      { repository: REPO, kind: "retention_gap", detail: "first", recordedAt: 2 },
      { repository: null, kind: "source_unavailable", detail: "second", recordedAt: 1 },
    ]);
  });

  test("artifacts are recorded once and read back against their hash", async () => {
    const db = await connected(connect);
    const root = artifactRoot();
    const bytes = new TextEncoder().encode("digest");
    const written = await db.run((q) =>
      writeRetroArtifactSteps(q, root, { retroId: "r1", kind: "digest", bytes, now: 4 }),
    );
    expect(written).toMatchObject({ kind: "digest", sizeBytes: 6, createdAt: 4 });
    expect(await db.run((q) => retroArtifactSteps(q, "r1", "digest"))).toEqual(written);
    expect(await db.run((q) => retroArtifactSteps(q, "r1", "report"))).toBeNull();
    expect(await db.run((q) => readRetroArtifactSteps(q, root, "r1", "digest"))).toEqual({
      ok: true,
      bytes,
      artifact: written,
    });
    await expect(
      db.run((q) =>
        writeRetroArtifactSteps(q, root, {
          retroId: "r1",
          kind: "digest",
          bytes: new TextEncoder().encode("other"),
          now: 5,
        }),
      ),
    ).rejects.toThrow("already has a different digest");
    writeFileSync(join(root, written.fileName), "tampered");
    expect(await db.run((q) => readRetroArtifactSteps(q, root, "r1", "digest"))).toEqual({
      ok: false,
      reason: "hash_mismatch",
    });
    expect(await db.run((q) => readRetroArtifactSteps(q, root, "r1", "report"))).toEqual({
      ok: false,
      reason: "unrecorded",
    });
  });

  test("watermarks list per workspace and collection starts from them", async () => {
    const db = await connected(connect);
    await settings(db);
    await db.run((q) =>
      q.exec(
        q.orm.insert(q.t.retroWatermark).values([
          { workspaceId: "ws", repository: REPO, cursor: 9, retroId: "r0", updatedAt: 3 },
          { workspaceId: "other", repository: REPO, cursor: 4, retroId: "rx", updatedAt: 2 },
        ]),
      ),
    );
    expect(await db.run((q) => retroWatermarksSteps(q, "ws"))).toEqual([
      { repository: REPO, cursor: 9, retroId: "r0", updatedAt: 3 },
    ]);
    await retro(db, "r1", 0, [REPO]);
    await db.transaction((q) => beginRetroCollectionSteps(q, { retroId: "r1", now: 1 }));
    expect(await db.run((q) => retroRepositoriesSteps(q, "r1"))).toEqual([
      { repository: REPO, startCursor: 9, endCursor: null },
    ]);
  });

  test("freezing needs the digest, manifest and an end cursor per repository", async () => {
    const db = await connected(connect);
    const root = artifactRoot();
    await settings(db);
    await retro(db, "r1", 0, [REPO]);
    await expect(freeze(db, "r1", 4)).rejects.toThrow("needs its digest and manifest");
    await collected(db, root, "r2", 20);
    await expect(
      db.transaction((q) => freezeRetroInputSteps(q, { retroId: "r2", endCursors: {}, now: 5 })),
    ).rejects.toThrow(`needs an end cursor for ${REPO}`);
    const frozen = await freeze(db, "r2", 4);
    expect(frozen).toMatchObject({ state: "queued", updatedAt: 5 });
    expect(frozen.digestSha256).toHaveLength(64);
    expect(frozen.manifestSha256).toHaveLength(64);
    expect(await db.run((q) => retroRepositoriesSteps(q, "r2"))).toEqual([
      { repository: REPO, startCursor: 0, endCursor: 4 },
    ]);
    await expect(freeze(db, "r2", 4)).rejects.toThrow("is not collecting evidence");
  });

  test("attempts start once per lease, fail only for their owner and expire", async () => {
    const db = await connected(connect);
    const root = artifactRoot();
    await settings(db);
    await collected(db, root);
    expect(await start(db, "r1", 6)).toBeNull();
    await freeze(db, "r1", 4);
    expect(await start(db, "r1", 6)).toEqual({ attempt: 1 });
    expect(await start(db, "r1", 7)).toBeNull();
    const failure = { retroId: "r1", attempt: 1, error: "boom", now: 8 };
    expect(
      await db.transaction((q) => failRetroAttemptSteps(q, { ...failure, owner: "other" })),
    ).toBe(false);
    expect(
      await db.transaction((q) => failRetroAttemptSteps(q, { ...failure, owner: "runner" })),
    ).toBe(true);
    expect(await db.run((q) => getRetroSteps(q, "r1"))).toMatchObject({
      state: "failed",
      owner: null,
      ownerExpiresAt: null,
      error: "boom",
    });
    expect(await start(db, "r1", 9)).toEqual({ attempt: 2 });
    expect(await start(db, "r1", 19)).toEqual({ attempt: 3 });
    expect(await start(db, "r1", 40, 3)).toBeNull();
    expect(await db.run((q) => listRetroAttemptsSteps(q, "r1"))).toEqual([
      {
        attempt: 1,
        owner: "runner",
        startedAt: 6,
        leaseExpiresAt: 16,
        finishedAt: 8,
        outcome: "failed",
        error: "boom",
      },
      {
        attempt: 2,
        owner: "runner",
        startedAt: 9,
        leaseExpiresAt: 19,
        finishedAt: 19,
        outcome: "expired",
        error: null,
      },
      {
        attempt: 3,
        owner: "runner",
        startedAt: 19,
        leaseExpiresAt: 29,
        finishedAt: null,
        outcome: "running",
        error: null,
      },
    ]);
  });

  test("publishing checks the attempt and its items, then records them", async () => {
    const db = await connected(connect);
    const root = artifactRoot();
    await settings(db);
    await collected(db, root);
    await freeze(db, "r1", 4);
    await start(db, "r1", 6);
    expect(await publish(db, "r1", 1, [item], "other")).toEqual({
      ok: false,
      reason: "not_owner",
    });
    expect(await publish(db, "r1", 1, [{ ...item, evidenceIds: ["e9"] }])).toEqual({
      ok: false,
      reason: "unknown_evidence",
    });
    expect(await publish(db, "r1", 1, [item, { ...item, title: "again" }])).toEqual({
      ok: false,
      reason: "duplicate_item",
    });
    const published = await publish(db, "r1", 1);
    if (!published.ok) throw new Error(published.reason);
    expect(published.retro).toMatchObject({
      state: "published",
      result: { items: 1 },
      owner: null,
      publishedAt: 30,
    });
    expect(published.retro.resultSha256).toHaveLength(64);
    expect(published.items).toEqual([
      { ...item, retroId: "r1", position: 0, improvementId: expect.any(String) },
    ]);
    expect(await db.run((q) => listRetroItemsSteps(q, "r1"))).toEqual(published.items);
    expect((await db.run((q) => listRetroAttemptsSteps(q, "r1")))[0]?.outcome).toBe("succeeded");
    expect(await db.run((q) => retroWatermarksSteps(q, "ws"))).toEqual([
      { repository: REPO, cursor: 4, retroId: "r1", updatedAt: 30 },
    ]);
    expect(await db.run((q) => q.all(q.orm.select().from(q.t.retroCollectionLock)))).toEqual([]);
  });

  test("a coverage gap or a moved watermark stops publication without writes", async () => {
    const db = await connected(connect);
    const root = artifactRoot();
    await settings(db);
    await collected(db, root);
    await freeze(db, "r1", 4);
    await start(db, "r1", 6);
    await db.run((q) =>
      q.exec(
        q.orm.insert(q.t.retroWatermark).values({
          workspaceId: "ws",
          repository: REPO,
          cursor: 2,
          retroId: "r0",
          updatedAt: 3,
        }),
      ),
    );
    expect(await publish(db, "r1", 1)).toEqual({ ok: false, reason: "watermark_moved" });
    expect(await db.run((q) => retroWatermarksSteps(q, "ws"))).toEqual([
      { repository: REPO, cursor: 2, retroId: "r0", updatedAt: 3 },
    ]);
    expect(await db.run((q) => listRetroItemsSteps(q, "r1"))).toEqual([]);
    expect((await db.run((q) => getRetroSteps(q, "r1")))?.state).toBe("generating");
    await db.run((q) =>
      recordRetroCoverageGapSteps(q, {
        retroId: "r1",
        kind: "retention_gap",
        detail: "gap",
        now: 7,
      }),
    );
    expect(await publish(db, "r1", 1)).toEqual({ ok: false, reason: "coverage_gap" });
  });

  test("closing ends an open retro once and releases its locks", async () => {
    const db = await connected(connect);
    const root = artifactRoot();
    await settings(db);
    await collected(db, root);
    await freeze(db, "r1", 4);
    await start(db, "r1", 6);
    const close = (state: "abandoned" | "coverage_failed") =>
      db.transaction((q) => closeRetroSteps(q, { retroId: "r1", state, error: "gone", now: 9 }));
    expect(await close("abandoned")).toBe(true);
    expect(await close("coverage_failed")).toBe(false);
    expect(await db.run((q) => getRetroSteps(q, "r1"))).toMatchObject({
      state: "abandoned",
      error: "gone",
      owner: null,
      updatedAt: 9,
    });
    expect(await db.run((q) => listRetroAttemptsSteps(q, "r1"))).toMatchObject([
      { outcome: "failed", error: "gone", finishedAt: 9 },
    ]);
    expect(await db.run((q) => q.all(q.orm.select().from(q.t.retroCollectionLock)))).toEqual([]);
  });

  test("the schedule runtime keeps the latest run and when it became blocked", async () => {
    const db = await connected(connect);
    expect(await db.run((q) => retroScheduleRuntimeSteps(q, "ws"))).toBeNull();
    const run = (occurrenceAt: number, retroId: string, now: number) =>
      db.run((q) =>
        recordRetroScheduleRunSteps(q, {
          workspaceId: "ws",
          occurrenceAt,
          retroId,
          nextDueAt: occurrenceAt + 100,
          now,
        }),
      );
    await run(10, "r1", 1);
    await run(5, "r0", 2);
    expect(await db.run((q) => retroScheduleRuntimeSteps(q, "ws"))).toEqual({
      workspaceId: "ws",
      lastOccurrenceAt: 10,
      lastRetroId: "r1",
      nextDueAt: 110,
      blockedReason: null,
      blockedSince: null,
      updatedAt: 1,
    });
    const state = (nextDueAt: number | null, blockedReason: string | null, now: number) =>
      db.run((q) =>
        recordRetroScheduleStateSteps(q, { workspaceId: "ws", nextDueAt, blockedReason, now }),
      );
    await state(110, null, 3);
    expect((await db.run((q) => retroScheduleRuntimeSteps(q, "ws")))?.updatedAt).toBe(1);
    await state(110, "no_runner", 4);
    await state(120, "no_runner", 5);
    expect(await db.run((q) => retroScheduleRuntimeSteps(q, "ws"))).toMatchObject({
      nextDueAt: 120,
      blockedReason: "no_runner",
      blockedSince: 4,
      updatedAt: 5,
    });
    await state(null, null, 6);
    expect(await db.run((q) => retroScheduleRuntimeSteps(q, "ws"))).toMatchObject({
      lastOccurrenceAt: 10,
      nextDueAt: null,
      blockedReason: null,
      blockedSince: null,
      updatedAt: 6,
    });
    await db.run((q) =>
      recordRetroScheduleStateSteps(q, {
        workspaceId: "fresh",
        nextDueAt: 50,
        blockedReason: "paused",
        now: 7,
      }),
    );
    expect(await db.run((q) => retroScheduleRuntimeSteps(q, "fresh"))).toMatchObject({
      lastOccurrenceAt: null,
      nextDueAt: 50,
      blockedReason: "paused",
      blockedSince: 7,
    });
  });
});
