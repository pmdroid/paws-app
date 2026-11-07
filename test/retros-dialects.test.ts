import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginRetroCollectionSteps,
  createRetroSteps,
  getRetroSettingsRevisionSteps,
  getRetroSteps,
  latestRetroSettingsRevisionSteps,
  listRetroCoverageGapsSteps,
  listRetroEvidenceSteps,
  listRetrosSteps,
  readRetroArtifactSteps,
  recordRetroCoverageGapSteps,
  recordRetroEvidenceSteps,
  retroArtifactSteps,
  retroRepositoriesSteps,
  retroWatermarksSteps,
  saveRetroSettingsRevisionSteps,
  writeRetroArtifactSteps,
  type Db,
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
});
