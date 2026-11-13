import { afterEach, describe, expect, test } from "bun:test";
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
  openPawsStore,
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
  type Db,
} from "./index";
import { seed } from "../../test/dialects";
import { copyMigratedPglite, tempStore } from "../../test/pglite";

const REPO = "pmdroid/paws-app";
const DAY = 86_400_000;
const roots: string[] = [];
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temp(): string {
  const root = mkdtempSync(join(tmpdir(), "paws-retro-"));
  roots.push(root);
  return root;
}

async function harness(open: () => Promise<{ db: Db; close(): Promise<void> }> = tempStore) {
  const { db, close } = await open();
  closes.push(close);
  await seed(db, (q) =>
    q.orm
      .insert(q.t.workspace)
      .values({ id: "ws", linearOrganizationId: "org", name: "Kyku", createdAt: 0 })
      .onConflictDoNothing(),
  );
  return { db, root: join(temp(), "artifacts") };
}

async function reopenable(pgliteDir: string) {
  const { store, close } = await openPawsStore({ url: null, pgliteDir });
  return { db: store, close };
}

async function settings(db: Db, repositories = [REPO], prompt = "Review {{digest}}") {
  return await saveRetroSettingsRevision(db, {
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

async function frozen(
  db: Db,
  root: string,
  input: { id: string; start: number; end: number; cursor: number; revision?: number },
) {
  const revision = input.revision ?? (await settings(db)).revision;
  await createRetro(db, {
    id: input.id,
    workspaceId: "ws",
    windowStart: input.start,
    windowEnd: input.end,
    origin: "scheduled",
    settingsRevision: revision,
    now: input.start,
  });
  expect((await beginRetroCollection(db, { retroId: input.id, now: input.end })).ok).toBe(true);
  await recordRetroEvidence(db, input.id, [
    {
      evidenceId: "e1",
      repository: REPO,
      sourceKind: "linear_question",
      sourceRef: "question:01ABC",
      occurredAt: input.start + 1,
      excerpt: "Fetch the branch and rebase onto its current tip.",
    },
  ]);
  await writeRetroArtifact(db, root, {
    retroId: input.id,
    kind: "digest",
    bytes: new TextEncoder().encode(`digest ${input.id}`),
    now: input.end,
  });
  await writeRetroArtifact(db, root, {
    retroId: input.id,
    kind: "manifest",
    bytes: new TextEncoder().encode(`["e1"]`),
    now: input.end,
  });
  return await freezeRetroInput(db, {
    retroId: input.id,
    endCursors: { [REPO]: input.cursor },
    now: input.end,
  });
}

describe("retro windows", () => {
  test("a workspace window has one retro whether scheduled or manual", async () => {
    const { db } = await harness();
    const { revision } = await settings(db);
    const first = await createRetro(db, {
      id: "r1",
      workspaceId: "ws",
      windowStart: 0,
      windowEnd: 7 * DAY,
      origin: "scheduled",
      scheduledFor: 7 * DAY,
      settingsRevision: revision,
      now: 7 * DAY,
    });
    const second = await createRetro(db, {
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
    expect(await getRetro(db, "r2")).toBeNull();
  });

  test("a retro freezes a resolved profile and a narrower repository scope", async () => {
    const { db } = await harness();
    const revision = (await settings(db, [REPO, "pmdroid/landing"])).revision;
    const { retro } = await createRetro(db, {
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
    await expect(
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
    ).rejects.toThrow("must come from settings revision");
  });

  test("a retro with an empty window is refused", async () => {
    const { db } = await harness();
    const { revision } = await settings(db);
    await createRetro(db, {
      id: "r1",
      workspaceId: "ws",
      windowStart: 0,
      windowEnd: DAY,
      origin: "manual",
      settingsRevision: revision,
      now: DAY,
    });
    await expect(
      createRetro(db, {
        id: "r2",
        workspaceId: "ws",
        windowStart: DAY,
        windowEnd: DAY,
        origin: "manual",
        settingsRevision: revision,
        now: DAY,
      }),
    ).rejects.toThrow();
  });
});

describe("retro generation", () => {
  test("a failed attempt retries the same retro with its frozen input", async () => {
    const { db, root } = await harness();
    await frozen(db, root, { id: "r1", start: 0, end: 7 * DAY, cursor: 40 });
    const later = await settings(db, [REPO], "A different prompt {{digest}}");
    expect(later.revision).toBe(2);

    const first = await startRetroAttempt(db, {
      retroId: "r1",
      owner: "a",
      now: 10,
      leaseMs: 100,
    });
    expect(first).toEqual({ attempt: 1 });
    expect(
      await failRetroAttempt(db, {
        retroId: "r1",
        attempt: 1,
        owner: "a",
        error: "lost",
        now: 20,
      }),
    ).toBe(true);
    expect(await retroWatermarks(db, "ws")).toEqual([]);
    expect((await getRetro(db, "r1"))!.result).toBeNull();

    expect(
      await startRetroAttempt(db, { retroId: "r1", owner: "b", now: 30, leaseMs: 100 }),
    ).toEqual({
      attempt: 2,
    });
    const retro = (await getRetro(db, "r1"))!;
    expect(retro.prompt).toBe("Review {{digest}}");
    expect(retro.settingsRevision).toBe(1);
    expect((await listRetroAttempts(db, "r1")).map((attempt) => attempt.outcome)).toEqual([
      "failed",
      "running",
    ]);
    expect(
      await startRetroAttempt(db, {
        retroId: "r1",
        owner: "c",
        now: 40,
        leaseMs: 100,
        maxAttempts: 2,
      }),
    ).toBeNull();
  });

  test("publication stores the result and advances the watermark together", async () => {
    const { db, root } = await harness();
    await frozen(db, root, { id: "r1", start: 0, end: 7 * DAY, cursor: 40 });
    await startRetroAttempt(db, { retroId: "r1", owner: "a", now: 10, leaseMs: 100 });
    const published = await publishRetro(db, {
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
    expect((await getImprovement(db, published.items[0]!.improvementId))!.reviewState).toBe(
      "needs_review",
    );
    expect(await retroWatermarks(db, "ws")).toEqual([
      { repository: REPO, cursor: 40, retroId: "r1", updatedAt: 50 },
    ]);
  });

  test("a result citing unknown evidence publishes nothing", async () => {
    const { db, root } = await harness();
    await frozen(db, root, { id: "r1", start: 0, end: DAY, cursor: 9 });
    await startRetroAttempt(db, { retroId: "r1", owner: "a", now: 10, leaseMs: 100 });
    expect(
      await publishRetro(db, {
        retroId: "r1",
        attempt: 1,
        owner: "a",
        result: {},
        items: [{ ...item, evidenceIds: ["missing"] }],
        now: 20,
      }),
    ).toEqual({ ok: false, reason: "unknown_evidence" });
    expect(await retroWatermarks(db, "ws")).toEqual([]);
    expect(await listRetroItems(db, "r1")).toEqual([]);
  });

  test("a recorded coverage gap blocks publication and the watermark", async () => {
    const { db, root } = await harness();
    await frozen(db, root, { id: "r1", start: 0, end: DAY, cursor: 9 });
    await startRetroAttempt(db, { retroId: "r1", owner: "a", now: 10, leaseMs: 100 });
    await recordRetroCoverageGap(db, {
      retroId: "r1",
      repository: REPO,
      kind: "missing_artifact",
      detail: "Transcript for run 01ABC is missing.",
      now: 11,
    });
    expect(
      await publishRetro(db, {
        retroId: "r1",
        attempt: 1,
        owner: "a",
        result: {},
        items: [],
        now: 20,
      }),
    ).toEqual({ ok: false, reason: "coverage_gap" });
    expect((await getRetro(db, "r1"))!.state).toBe("generating");
    expect(await retroWatermarks(db, "ws")).toEqual([]);
  });

  test("an expired owner cannot publish after another attempt takes over", async () => {
    const { db, root } = await harness();
    await frozen(db, root, { id: "r1", start: 0, end: DAY, cursor: 9 });
    await startRetroAttempt(db, { retroId: "r1", owner: "a", now: 10, leaseMs: 100 });
    expect(
      await startRetroAttempt(db, { retroId: "r1", owner: "b", now: 50, leaseMs: 100 }),
    ).toBeNull();
    expect(
      await startRetroAttempt(db, { retroId: "r1", owner: "b", now: 110, leaseMs: 100 }),
    ).toEqual({
      attempt: 2,
    });
    const late = { retroId: "r1", attempt: 1, owner: "a", result: {}, items: [], now: 120 };
    expect(await publishRetro(db, late)).toEqual({ ok: false, reason: "not_owner" });
    expect((await listRetroAttempts(db, "r1"))[0]!.outcome).toBe("expired");
    expect((await publishRetro(db, { ...late, attempt: 2, owner: "b" })).ok).toBe(true);
  });
});

describe("retro collection", () => {
  test("overlapping retros for one repository are serialized and continue the watermark", async () => {
    const { db, root } = await harness();
    const { revision } = await settings(db);
    await frozen(db, root, { id: "r1", start: 0, end: 7 * DAY, cursor: 40, revision });
    await createRetro(db, {
      id: "r2",
      workspaceId: "ws",
      windowStart: 7 * DAY,
      windowEnd: 8 * DAY,
      origin: "manual",
      settingsRevision: revision,
      now: 8 * DAY,
    });
    expect(await beginRetroCollection(db, { retroId: "r2", now: 8 * DAY })).toEqual({
      ok: false,
      reason: "busy",
      busy: [{ repository: REPO, retroId: "r1" }],
    });
    await startRetroAttempt(db, {
      retroId: "r1",
      owner: "a",
      now: 8 * DAY,
      leaseMs: 100,
    });
    await publishRetro(db, {
      retroId: "r1",
      attempt: 1,
      owner: "a",
      result: {},
      items: [],
      now: 8 * DAY,
    });
    const second = await beginRetroCollection(db, { retroId: "r2", now: 8 * DAY + 1 });
    expect(second).toEqual({
      ok: true,
      repositories: [{ repository: REPO, startCursor: 40, endCursor: null }],
    });
  });

  test("a watermark that moved underneath a retro blocks its publication", async () => {
    const { db, root } = await harness();
    await frozen(db, root, { id: "r1", start: 0, end: DAY, cursor: 9 });
    await seed(db, (q) =>
      q.orm
        .insert(q.t.retroWatermark)
        .values({ workspaceId: "ws", repository: REPO, cursor: 3, retroId: "r1", updatedAt: 1 }),
    );
    await startRetroAttempt(db, { retroId: "r1", owner: "a", now: 10, leaseMs: 100 });
    expect(
      await publishRetro(db, {
        retroId: "r1",
        attempt: 1,
        owner: "a",
        result: {},
        items: [],
        now: 20,
      }),
    ).toEqual({ ok: false, reason: "watermark_moved" });
    expect((await getRetro(db, "r1"))!.state).toBe("generating");
    expect((await retroWatermarks(db, "ws"))[0]!.cursor).toBe(3);
  });

  test("a newly selected repository starts from its own history", async () => {
    const { db, root } = await harness();
    await frozen(db, root, { id: "r1", start: 0, end: DAY, cursor: 40 });
    await startRetroAttempt(db, { retroId: "r1", owner: "a", now: DAY, leaseMs: 100 });
    await publishRetro(db, {
      retroId: "r1",
      attempt: 1,
      owner: "a",
      result: {},
      items: [],
      now: DAY,
    });
    const { revision } = await settings(db, [REPO, "pmdroid/other"]);
    await createRetro(db, {
      id: "r2",
      workspaceId: "ws",
      windowStart: DAY,
      windowEnd: 2 * DAY,
      origin: "scheduled",
      settingsRevision: revision,
      now: 2 * DAY,
    });
    const begun = await beginRetroCollection(db, {
      retroId: "r2",
      initialCursors: { "pmdroid/other": 0 },
      now: 2 * DAY,
    });
    expect(begun.ok && begun.repositories).toEqual([
      { repository: "pmdroid/other", startCursor: 0, endCursor: null },
      { repository: REPO, startCursor: 40, endCursor: null },
    ]);
  });

  test("closing a retro releases its repositories without moving the watermark", async () => {
    const { db, root } = await harness();
    await frozen(db, root, { id: "r1", start: 0, end: DAY, cursor: 9 });
    await recordRetroCoverageGap(db, {
      retroId: "r1",
      repository: REPO,
      kind: "retention_gap",
      detail: "Runner receipts before day 1 expired.",
      now: 5,
    });
    expect(
      await closeRetro(db, {
        retroId: "r1",
        state: "coverage_failed",
        error: "gap",
        now: 6,
      }),
    ).toBe(true);
    expect(await listRetroCoverageGaps(db, "r1")).toEqual([
      {
        repository: REPO,
        kind: "retention_gap",
        detail: "Runner receipts before day 1 expired.",
        recordedAt: 5,
      },
    ]);
    expect(await retroWatermarks(db, "ws")).toEqual([]);
    expect(await db.run((q) => q.all(q.orm.select().from(q.t.retroCollectionLock)))).toEqual([]);
    expect((await retroRepositories(db, "r1"))[0]!.endCursor).toBe(9);
  });
});

describe("retro artifacts", () => {
  test("artifacts are private and checked against their hash", async () => {
    const { db, root } = await harness();
    await frozen(db, root, { id: "r1", start: 0, end: DAY, cursor: 9 });
    const read = await readRetroArtifact(db, root, "r1", "digest");
    expect(read.ok && new TextDecoder().decode(read.bytes)).toBe("digest r1");
    if (!read.ok) return;
    const path = join(root, read.artifact.fileName);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    await expect(
      writeRetroArtifact(db, root, {
        retroId: "r1",
        kind: "digest",
        bytes: new TextEncoder().encode("other"),
        now: 2,
      }),
    ).rejects.toThrow(/different digest/);

    writeFileSync(path, "tampered");
    expect(await readRetroArtifact(db, root, "r1", "digest")).toEqual({
      ok: false,
      reason: "hash_mismatch",
    });
    unlinkSync(path);
    expect(await readRetroArtifact(db, root, "r1", "digest")).toEqual({
      ok: false,
      reason: "missing_artifact",
    });
    expect(await readRetroArtifact(db, root, "r1", "report")).toEqual({
      ok: false,
      reason: "unrecorded",
    });
  });
});

describe("restart persistence", () => {
  test("retros, items, watermarks and schedule metadata survive a reopen", async () => {
    const pgliteDir = join(temp(), "pglite");
    await copyMigratedPglite(pgliteDir);
    const first = await harness(() => reopenable(pgliteDir));
    await frozen(first.db, first.root, { id: "r1", start: 0, end: DAY, cursor: 9 });
    await startRetroAttempt(first.db, {
      retroId: "r1",
      owner: "a",
      now: 10,
      leaseMs: 100,
    });
    await publishRetro(first.db, {
      retroId: "r1",
      attempt: 1,
      owner: "a",
      result: { ok: 1 },
      items: [item],
      now: 20,
    });
    await recordRetroScheduleRun(first.db, {
      workspaceId: "ws",
      occurrenceAt: DAY,
      retroId: "r1",
      nextDueAt: 8 * DAY,
      now: 20,
    });
    await recordRetroScheduleRun(first.db, {
      workspaceId: "ws",
      occurrenceAt: 0,
      retroId: "r1",
      nextDueAt: 0,
      now: 21,
    });
    await closes.pop()!();

    const { db } = await harness(() => reopenable(pgliteDir));
    expect((await getRetro(db, "r1"))!.result).toEqual({ ok: 1 });
    expect((await listRetroItems(db, "r1")).map((row) => row.itemId)).toEqual(["git-recovery"]);
    expect((await retroWatermarks(db, "ws"))[0]!.cursor).toBe(9);
    expect(await retroScheduleRuntime(db, "ws")).toEqual({
      workspaceId: "ws",
      lastOccurrenceAt: DAY,
      lastRetroId: "r1",
      nextDueAt: 8 * DAY,
      blockedReason: null,
      blockedSince: null,
      updatedAt: 20,
    });
  });
});
