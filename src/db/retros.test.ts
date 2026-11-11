import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginRetroCollection,
  closeRetro,
  createRetro,
  failRetroAttempt,
  freezeRetroInput,
  getImprovement,
  getRetro,
  listRetroAttempts,
  listRetroCoverageGaps,
  listRetroItems,
  migrate,
  openDatabase,
  publishRetro,
  readRetroArtifact,
  recordRetroCoverageGap,
  recordRetroEvidence,
  recordRetroScheduleRun,
  retroRepositories,
  retroScheduleRuntime,
  retroWatermarks,
  saveRetroSettingsRevision,
  startRetroAttempt,
  writeRetroArtifact,
  type RetroItemInput,
  sqliteDb,
} from "./index";

const REPO = "pmdroid/paws-app";
const DAY = 86_400_000;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temp(): string {
  const root = mkdtempSync(join(tmpdir(), "paws-retro-"));
  roots.push(root);
  return root;
}

function harness(path = ":memory:") {
  const db = openDatabase(path);
  migrate(db);
  db.run("INSERT OR IGNORE INTO workspace VALUES ('ws', 'org', 'Kyku', 0)");
  return { db, root: join(temp(), "artifacts") };
}

function settings(db: Database, repositories = [REPO], prompt = "Review {{digest}}") {
  return saveRetroSettingsRevision(db, {
    workspaceId: "ws",
    prompt,
    agentProfile: { agent: "codex", model: "gpt-6-astra", effort: "high" },
    repositories,
    outputLimits: { maxItems: 5, workedWell: 3 },
    executionLimits: { timeoutMinutes: 15, retries: 1 },
    schedule: { cadence: "weekly", day: "monday", time: "09:00", timezone: "UTC" },
    createdBy: "user-1",
    now: 1,
  });
}

const item: RetroItemInput = {
  itemId: "git-recovery",
  repository: REPO,
  area: "Git recovery",
  actionStep: "issue",
  title: "Git recovery asks for the same repair",
  problem: "Seven issues needed the same push repair.",
  proposedChange: "Complete branch-tip recovery as a durable operation.",
  verificationCriterion: "No push-recovery questions in the next two retros.",
  evidenceIds: ["e1"],
};

function frozen(
  db: Database,
  root: string,
  input: { id: string; start: number; end: number; cursor: number; revision?: number },
) {
  const revision = input.revision ?? settings(db).revision;
  createRetro(db, {
    id: input.id,
    workspaceId: "ws",
    windowStart: input.start,
    windowEnd: input.end,
    origin: "scheduled",
    settingsRevision: revision,
    now: input.start,
  });
  expect(beginRetroCollection(db, { retroId: input.id, now: input.end }).ok).toBe(true);
  recordRetroEvidence(db, input.id, [
    {
      evidenceId: "e1",
      repository: REPO,
      sourceKind: "linear_question",
      sourceRef: "question:01ABC",
      occurredAt: input.start + 1,
      excerpt: "Fetch the branch and rebase onto its current tip.",
    },
  ]);
  writeRetroArtifact(db, root, {
    retroId: input.id,
    kind: "digest",
    bytes: new TextEncoder().encode(`digest ${input.id}`),
    now: input.end,
  });
  writeRetroArtifact(db, root, {
    retroId: input.id,
    kind: "manifest",
    bytes: new TextEncoder().encode(`["e1"]`),
    now: input.end,
  });
  return freezeRetroInput(db, {
    retroId: input.id,
    endCursors: { [REPO]: input.cursor },
    now: input.end,
  });
}

describe("retro windows", () => {
  test("a workspace window has one retro whether scheduled or manual", async () => {
    const { db } = harness();
    const { revision } = settings(db);
    const first = createRetro(db, {
      id: "r1",
      workspaceId: "ws",
      windowStart: 0,
      windowEnd: 7 * DAY,
      origin: "scheduled",
      scheduledFor: 7 * DAY,
      settingsRevision: revision,
      now: 7 * DAY,
    });
    const second = createRetro(db, {
      id: "r2",
      workspaceId: "ws",
      windowStart: 0,
      windowEnd: 7 * DAY,
      origin: "manual",
      settingsRevision: revision,
      now: 7 * DAY + 5,
    });
    expect(first.created).toBe(true);
    expect(second).toEqual({ retro: first.retro, created: false });
    expect(await getRetro(sqliteDb(db), "r2")).toBeNull();
  });

  test("a retro freezes a resolved profile and a narrower repository scope", () => {
    const { db } = harness();
    const revision = settings(db, [REPO, "pmdroid/landing"]).revision;
    const { retro } = createRetro(db, {
      id: "r-resolved",
      workspaceId: "ws",
      windowStart: 0,
      windowEnd: DAY,
      origin: "manual",
      settingsRevision: revision,
      agentProfile: { agent: "codex", model: "gpt-6-astra", effort: "medium" },
      repositories: [REPO],
      now: 1,
    });
    expect(retro.agentProfile).toEqual({ agent: "codex", model: "gpt-6-astra", effort: "medium" });
    expect(retro.repositories).toEqual([REPO]);
    expect(() =>
      createRetro(db, {
        id: "r-broader",
        workspaceId: "ws",
        windowStart: DAY,
        windowEnd: 2 * DAY,
        origin: "manual",
        settingsRevision: revision,
        repositories: ["pmdroid/other"],
        now: 2,
      }),
    ).toThrow("must come from settings revision");
  });

  test("settings revisions and the frozen input are immutable", () => {
    const { db } = harness();
    const { revision } = settings(db);
    createRetro(db, {
      id: "r1",
      workspaceId: "ws",
      windowStart: 0,
      windowEnd: DAY,
      origin: "manual",
      settingsRevision: revision,
      now: DAY,
    });
    expect(() => db.run("UPDATE retro_settings_revision SET prompt = 'x'")).toThrow(/immutable/);
    expect(() => db.run("UPDATE retro SET prompt = 'x' WHERE id = 'r1'")).toThrow(/immutable/);
    expect(() =>
      createRetro(db, {
        id: "r2",
        workspaceId: "ws",
        windowStart: DAY,
        windowEnd: DAY,
        origin: "manual",
        settingsRevision: revision,
        now: DAY,
      }),
    ).toThrow();
  });
});

describe("retro generation", () => {
  test("a failed attempt retries the same retro with its frozen input", async () => {
    const { db, root } = harness();
    frozen(db, root, { id: "r1", start: 0, end: 7 * DAY, cursor: 40 });
    const later = settings(db, [REPO], "A different prompt {{digest}}");
    expect(later.revision).toBe(2);

    const first = startRetroAttempt(db, { retroId: "r1", owner: "a", now: 10, leaseMs: 100 });
    expect(first).toEqual({ attempt: 1 });
    expect(
      await failRetroAttempt(sqliteDb(db), {
        retroId: "r1",
        attempt: 1,
        owner: "a",
        error: "lost",
        now: 20,
      }),
    ).toBe(true);
    expect(await retroWatermarks(sqliteDb(db), "ws")).toEqual([]);
    expect((await getRetro(sqliteDb(db), "r1"))!.result).toBeNull();

    expect(startRetroAttempt(db, { retroId: "r1", owner: "b", now: 30, leaseMs: 100 })).toEqual({
      attempt: 2,
    });
    const retro = (await getRetro(sqliteDb(db), "r1"))!;
    expect(retro.prompt).toBe("Review {{digest}}");
    expect(retro.settingsRevision).toBe(1);
    expect((await listRetroAttempts(sqliteDb(db), "r1")).map((attempt) => attempt.outcome)).toEqual(
      ["failed", "running"],
    );
    expect(
      startRetroAttempt(db, { retroId: "r1", owner: "c", now: 40, leaseMs: 100, maxAttempts: 2 }),
    ).toBeNull();
  });

  test("publication stores the result and advances the watermark together", async () => {
    const { db, root } = harness();
    frozen(db, root, { id: "r1", start: 0, end: 7 * DAY, cursor: 40 });
    startRetroAttempt(db, { retroId: "r1", owner: "a", now: 10, leaseMs: 100 });
    const published = publishRetro(db, {
      retroId: "r1",
      attempt: 1,
      owner: "a",
      result: { items: 1 },
      items: [item],
      now: 50,
    });
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    expect(published.retro.state).toBe("published");
    expect(published.items).toEqual([
      { ...item, retroId: "r1", position: 0, improvementId: published.items[0]!.improvementId },
    ]);
    expect(getImprovement(db, published.items[0]!.improvementId)!.reviewState).toBe("needs_review");
    expect(await retroWatermarks(sqliteDb(db), "ws")).toEqual([
      { repository: REPO, cursor: 40, retroId: "r1", updatedAt: 50 },
    ]);
    expect(() => db.run("UPDATE retro SET result = '{}' WHERE id = 'r1'")).toThrow(/immutable/);
    expect(() => db.run("UPDATE retro_item SET title = 'x'")).toThrow(/immutable/);
  });

  test("a result citing unknown evidence publishes nothing", async () => {
    const { db, root } = harness();
    frozen(db, root, { id: "r1", start: 0, end: DAY, cursor: 9 });
    startRetroAttempt(db, { retroId: "r1", owner: "a", now: 10, leaseMs: 100 });
    expect(
      publishRetro(db, {
        retroId: "r1",
        attempt: 1,
        owner: "a",
        result: {},
        items: [{ ...item, evidenceIds: ["missing"] }],
        now: 20,
      }),
    ).toEqual({ ok: false, reason: "unknown_evidence" });
    expect(await retroWatermarks(sqliteDb(db), "ws")).toEqual([]);
    expect(await listRetroItems(sqliteDb(db), "r1")).toEqual([]);
  });

  test("a recorded coverage gap blocks publication and the watermark", async () => {
    const { db, root } = harness();
    frozen(db, root, { id: "r1", start: 0, end: DAY, cursor: 9 });
    startRetroAttempt(db, { retroId: "r1", owner: "a", now: 10, leaseMs: 100 });
    await recordRetroCoverageGap(sqliteDb(db), {
      retroId: "r1",
      repository: REPO,
      kind: "missing_artifact",
      detail: "Transcript for run 01ABC is missing.",
      now: 11,
    });
    expect(
      publishRetro(db, { retroId: "r1", attempt: 1, owner: "a", result: {}, items: [], now: 20 }),
    ).toEqual({ ok: false, reason: "coverage_gap" });
    expect((await getRetro(sqliteDb(db), "r1"))!.state).toBe("generating");
    expect(await retroWatermarks(sqliteDb(db), "ws")).toEqual([]);
  });

  test("an expired owner cannot publish after another attempt takes over", async () => {
    const { db, root } = harness();
    frozen(db, root, { id: "r1", start: 0, end: DAY, cursor: 9 });
    startRetroAttempt(db, { retroId: "r1", owner: "a", now: 10, leaseMs: 100 });
    expect(startRetroAttempt(db, { retroId: "r1", owner: "b", now: 50, leaseMs: 100 })).toBeNull();
    expect(startRetroAttempt(db, { retroId: "r1", owner: "b", now: 110, leaseMs: 100 })).toEqual({
      attempt: 2,
    });
    const late = { retroId: "r1", attempt: 1, owner: "a", result: {}, items: [], now: 120 };
    expect(publishRetro(db, late)).toEqual({ ok: false, reason: "not_owner" });
    expect((await listRetroAttempts(sqliteDb(db), "r1"))[0]!.outcome).toBe("expired");
    expect(publishRetro(db, { ...late, attempt: 2, owner: "b" }).ok).toBe(true);
  });
});

describe("retro collection", () => {
  test("overlapping retros for one repository are serialized and continue the watermark", () => {
    const { db, root } = harness();
    const { revision } = settings(db);
    frozen(db, root, { id: "r1", start: 0, end: 7 * DAY, cursor: 40, revision });
    createRetro(db, {
      id: "r2",
      workspaceId: "ws",
      windowStart: 7 * DAY,
      windowEnd: 8 * DAY,
      origin: "manual",
      settingsRevision: revision,
      now: 8 * DAY,
    });
    expect(beginRetroCollection(db, { retroId: "r2", now: 8 * DAY })).toEqual({
      ok: false,
      reason: "busy",
      busy: [{ repository: REPO, retroId: "r1" }],
    });
    startRetroAttempt(db, { retroId: "r1", owner: "a", now: 8 * DAY, leaseMs: 100 });
    publishRetro(db, {
      retroId: "r1",
      attempt: 1,
      owner: "a",
      result: {},
      items: [],
      now: 8 * DAY,
    });
    const second = beginRetroCollection(db, { retroId: "r2", now: 8 * DAY + 1 });
    expect(second).toEqual({
      ok: true,
      repositories: [{ repository: REPO, startCursor: 40, endCursor: null }],
    });
  });

  test("a watermark that moved underneath a retro blocks its publication", async () => {
    const { db, root } = harness();
    frozen(db, root, { id: "r1", start: 0, end: DAY, cursor: 9 });
    db.run(
      "INSERT INTO retro_watermark (workspace_id, repository, cursor, retro_id, updated_at) VALUES ('ws', ?, 3, 'r1', 1)",
      [REPO],
    );
    startRetroAttempt(db, { retroId: "r1", owner: "a", now: 10, leaseMs: 100 });
    expect(
      publishRetro(db, { retroId: "r1", attempt: 1, owner: "a", result: {}, items: [], now: 20 }),
    ).toEqual({ ok: false, reason: "watermark_moved" });
    expect((await getRetro(sqliteDb(db), "r1"))!.state).toBe("generating");
    expect((await retroWatermarks(sqliteDb(db), "ws"))[0]!.cursor).toBe(3);
  });

  test("a newly selected repository starts from its own history", () => {
    const { db, root } = harness();
    frozen(db, root, { id: "r1", start: 0, end: DAY, cursor: 40 });
    startRetroAttempt(db, { retroId: "r1", owner: "a", now: DAY, leaseMs: 100 });
    publishRetro(db, { retroId: "r1", attempt: 1, owner: "a", result: {}, items: [], now: DAY });
    const { revision } = settings(db, [REPO, "pmdroid/other"]);
    createRetro(db, {
      id: "r2",
      workspaceId: "ws",
      windowStart: DAY,
      windowEnd: 2 * DAY,
      origin: "scheduled",
      settingsRevision: revision,
      now: 2 * DAY,
    });
    const begun = beginRetroCollection(db, {
      retroId: "r2",
      initialCursors: { "pmdroid/other": 0 },
      now: 2 * DAY,
    });
    expect(begun.ok && begun.repositories).toEqual([
      { repository: "pmdroid/other", startCursor: 0, endCursor: null },
      { repository: REPO, startCursor: 40, endCursor: null },
    ]);
    expect(() =>
      db.run("UPDATE retro_repository SET start_cursor = 99 WHERE retro_id = 'r2'"),
    ).toThrow(/frozen/);
  });

  test("closing a retro releases its repositories without moving the watermark", async () => {
    const { db, root } = harness();
    frozen(db, root, { id: "r1", start: 0, end: DAY, cursor: 9 });
    await recordRetroCoverageGap(sqliteDb(db), {
      retroId: "r1",
      repository: REPO,
      kind: "retention_gap",
      detail: "Runner receipts before day 1 expired.",
      now: 5,
    });
    expect(
      await closeRetro(sqliteDb(db), {
        retroId: "r1",
        state: "coverage_failed",
        error: "gap",
        now: 6,
      }),
    ).toBe(true);
    expect(await listRetroCoverageGaps(sqliteDb(db), "r1")).toEqual([
      {
        repository: REPO,
        kind: "retention_gap",
        detail: "Runner receipts before day 1 expired.",
        recordedAt: 5,
      },
    ]);
    expect(await retroWatermarks(sqliteDb(db), "ws")).toEqual([]);
    expect(db.query("SELECT count(*) AS n FROM retro_collection_lock").get()).toEqual({ n: 0 });
    expect((await retroRepositories(sqliteDb(db), "r1"))[0]!.endCursor).toBe(9);
  });
});

describe("retro artifacts", () => {
  test("artifacts are private and checked against their hash", () => {
    const { db, root } = harness();
    frozen(db, root, { id: "r1", start: 0, end: DAY, cursor: 9 });
    const read = readRetroArtifact(db, root, "r1", "digest");
    expect(read.ok && new TextDecoder().decode(read.bytes)).toBe("digest r1");
    if (!read.ok) return;
    const path = join(root, read.artifact.fileName);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() =>
      writeRetroArtifact(db, root, {
        retroId: "r1",
        kind: "digest",
        bytes: new TextEncoder().encode("other"),
        now: 2,
      }),
    ).toThrow(/different digest/);

    writeFileSync(path, "tampered");
    expect(readRetroArtifact(db, root, "r1", "digest")).toEqual({
      ok: false,
      reason: "hash_mismatch",
    });
    unlinkSync(path);
    expect(readRetroArtifact(db, root, "r1", "digest")).toEqual({
      ok: false,
      reason: "missing_artifact",
    });
    expect(readRetroArtifact(db, root, "r1", "report")).toEqual({
      ok: false,
      reason: "unrecorded",
    });
  });
});

describe("restart persistence", () => {
  test("retros, items, watermarks and schedule metadata survive a reopen", async () => {
    const path = join(temp(), "paws.db");
    const first = harness(path);
    frozen(first.db, first.root, { id: "r1", start: 0, end: DAY, cursor: 9 });
    startRetroAttempt(first.db, { retroId: "r1", owner: "a", now: 10, leaseMs: 100 });
    publishRetro(first.db, {
      retroId: "r1",
      attempt: 1,
      owner: "a",
      result: { ok: 1 },
      items: [item],
      now: 20,
    });
    await recordRetroScheduleRun(sqliteDb(first.db), {
      workspaceId: "ws",
      occurrenceAt: DAY,
      retroId: "r1",
      nextDueAt: 8 * DAY,
      now: 20,
    });
    await recordRetroScheduleRun(sqliteDb(first.db), {
      workspaceId: "ws",
      occurrenceAt: 0,
      retroId: "r1",
      nextDueAt: 0,
      now: 21,
    });
    first.db.close();

    const db = openDatabase(path);
    migrate(db);
    expect((await getRetro(sqliteDb(db), "r1"))!.result).toEqual({ ok: 1 });
    expect((await listRetroItems(sqliteDb(db), "r1")).map((row) => row.itemId)).toEqual([
      "git-recovery",
    ]);
    expect((await retroWatermarks(sqliteDb(db), "ws"))[0]!.cursor).toBe(9);
    expect(await retroScheduleRuntime(sqliteDb(db), "ws")).toEqual({
      workspaceId: "ws",
      lastOccurrenceAt: DAY,
      lastRetroId: "r1",
      nextDueAt: 8 * DAY,
      blockedReason: null,
      blockedSince: null,
      updatedAt: 20,
    });
    db.close();
  });
});
