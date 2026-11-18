import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  listContextAudit,
  openPawsStore,
  pgSchema,
  type ContextNamespace,
  type Db,
} from "../src/db";
import {
  CONTEXT_RETENTION,
  compactContext,
  correctContext,
  createContextCapacity,
  createFakeContextAccess,
  createFakeContextSummarizer,
  forgetContextRecord,
  ingestContext,
  queryContext,
  recordWorkItemContext,
  selectContext,
  sweepContext,
  type ContextBudgetSettings,
  type ContextRequester,
  type WorkItemContextEntry,
} from "../src/project-context";
import { tempHome } from "./helpers";
import { sqlRun, tempStore } from "./pglite";
import journal from "../src/db/drizzle-pg/meta/_journal.json";

const T0 = Date.parse("2026-11-17T12:00:00Z");
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const SETTINGS: Partial<ContextBudgetSettings> = {
  hardCapTokens: 4_000,
  responseTokens: 1_000,
  memoryTokens: 800,
  recentTokens: 300,
  softThresholdTokens: 500,
  summaryOutputTokens: 200,
  summaryInputTokens: 2_000,
  candidates: 120,
  references: 6,
  summaryTimeoutMs: 1_000,
  compactionRetryMs: 60_000,
};

let db: Db;
let close: () => Promise<void>;
let seq = 0;

beforeAll(async () => {
  ({ db, close } = await tempStore());
});
afterAll(async () => {
  await close();
});

const ENTRIES: WorkItemContextEntry[] = [
  { classification: "reported_fact", body: "CANARY-FORGET exports retry three times." },
  { classification: "reported_fact", body: "SIBLING-FACT exports run nightly." },
  { classification: "decision", body: "SIBLING-DECISION keep CSV as the export format." },
];

function fixture() {
  seq++;
  const workspaceId = `ws-forget-${seq}`;
  const namespace: ContextNamespace = {
    workspaceId,
    scopeKind: "linear_project",
    scopeId: `project-${seq}`,
  };
  const alice: ContextRequester = { workspaceId, userId: `alice-${seq}` };
  const access = createFakeContextAccess();
  access.grant(alice, { teamIds: ["team-a"], repositories: ["acme/app"], channelIds: [] });
  return { namespace, alice, access };
}

async function remember(
  f: ReturnType<typeof fixture>,
  entries: readonly WorkItemContextEntry[],
  at: number,
  namespace = f.namespace,
  workItemId = "item-1",
) {
  return recordWorkItemContext(db, f.access, {
    namespace,
    requester: f.alice,
    workItemId,
    revision: `remember-${at}`,
    revisionAt: at,
    restriction: { teamIds: ["team-a"] },
    entries,
    now: at,
  });
}

async function bodies(f: ReturnType<typeof fixture>, now: number, namespace = f.namespace) {
  const result = await queryContext(db, f.access, {
    namespace,
    requester: f.alice,
    destination: { audience: "project_members" },
    limit: 50,
    maxBytes: 32_000,
    now,
  });
  if (result.status !== "ok") throw new Error("query refused");
  return result.records.map((record) => record.body);
}

async function recordId(f: ReturnType<typeof fixture>, marker: string, now: number) {
  const result = await queryContext(db, f.access, {
    namespace: f.namespace,
    requester: f.alice,
    destination: { audience: "project_members" },
    limit: 50,
    maxBytes: 32_000,
    now,
  });
  if (result.status !== "ok") throw new Error("query refused");
  return result.records.find((record) => record.body.includes(marker))!.id;
}

async function pack(f: ReturnType<typeof fixture>, now: number) {
  const selection = await selectContext(db, f.access, {
    namespace: f.namespace,
    requester: f.alice,
    destination: { audience: "project_members" },
    instructions: "You are working on a Paws task.",
    request: "Fix the export retry behaviour",
    toolsTokens: 300,
    repository: "acme/app",
    recent: [],
    model: { contextTokens: 100_000 },
    settings: SETTINGS,
    now,
  });
  if (selection.status !== "ok") throw new Error(`selection ${selection.status}`);
  return selection.pack;
}

async function summaryText() {
  const rows = await db.orm
    .select({ body: pgSchema.contextSummary.body })
    .from(pgSchema.contextSummary);
  return rows.map((row) => row.body).join("\n");
}

const forget = (f: ReturnType<typeof fixture>, id: string, now: number, requester = f.alice) =>
  forgetContextRecord(db, f.access, { namespace: f.namespace, requester, recordId: id, now });

test("forgetting one entry keeps its siblings and the source, and replays never bring it back", async () => {
  const f = fixture();
  await ingestContext(db, f.access, {
    namespace: f.namespace,
    requester: f.alice,
    source: {
      kind: "linear_project_document",
      id: "doc-filler",
      url: "https://linear.app/doc/filler",
      revision: "rev-1",
      revisionAt: T0,
      actorId: "writer",
      restriction: { teamIds: ["team-a"] },
    },
    claims: Array.from({ length: 12 }, (_, i) => ({
      key: `filler-${i}`,
      layer: "observation" as const,
      classification: "reported_fact" as const,
      importance: 1,
      body: `Filler detail ${i}: the exporter batches rows.`,
    })),
    now: T0,
  });
  expect((await remember(f, ENTRIES, T0 - MINUTE)).status).toBe("stored");
  const target = await recordId(f, "CANARY-FORGET", T0 + MINUTE);
  await pack(f, T0 + MINUTE);
  const summarizer = createFakeContextSummarizer();
  summarizer.mode = "condense";
  await compactContext(db, f.access, summarizer, createContextCapacity(), {
    namespace: f.namespace,
    requester: f.alice,
    destination: { audience: "project_members" },
    settings: SETTINGS,
    now: T0 + 2 * MINUTE,
  });
  expect(JSON.stringify(summarizer.calls)).toContain("CANARY-FORGET");
  expect(await summaryText()).toContain("CANARY-FORGET");

  const outcome = await forget(f, target, T0 + 3 * MINUTE);
  expect(outcome.status).toBe("forgotten");
  if (outcome.status !== "forgotten") throw new Error("not forgotten");
  expect(outcome.invalidation.records.map((record) => [record.id, record.reason])).toEqual([
    [target, "forgotten"],
  ]);
  const audit = await listContextAudit(db, f.namespace, 50);
  expect(audit.filter((row) => row.action === "forget_entry")).toHaveLength(1);
  expect(audit.some((row) => row.action === "forgotten")).toBe(false);

  const after = await bodies(f, T0 + 4 * MINUTE);
  expect(after.join("\n")).not.toContain("CANARY-FORGET");
  expect(after.join("\n")).toContain("SIBLING-FACT");
  expect(after.join("\n")).toContain("SIBLING-DECISION");
  expect(await summaryText()).not.toContain("CANARY-FORGET");
  const next = await pack(f, T0 + 4 * MINUTE);
  expect(next).not.toContain("CANARY-FORGET");
  expect(next).not.toContain(target);

  expect((await forget(f, target, T0 + 5 * MINUTE)).status).toBe("refused");
  expect(
    (await listContextAudit(db, f.namespace, 50)).filter((row) => row.action === "forget_entry"),
  ).toHaveLength(1);

  const unrelated: WorkItemContextEntry = {
    classification: "reported_fact",
    body: "NEW-ENTRY exports log row counts.",
  };
  expect((await remember(f, [...ENTRIES, unrelated], T0 + 6 * MINUTE)).status).toBe("stored");
  expect((await remember(f, ENTRIES, T0 + 2 * MINUTE)).status).toBe("stale");
  const replayed = (await bodies(f, T0 + 7 * MINUTE)).join("\n");
  expect(replayed).not.toContain("CANARY-FORGET");
  expect(replayed).toContain("NEW-ENTRY");
  expect(replayed).toContain("SIBLING-DECISION");

  const later = T0 + CONTEXT_RETENTION.historyMs + DAY;
  await sweepContext(db, later);
  const stored = await db.orm
    .select({ id: pgSchema.contextRecord.id })
    .from(pgSchema.contextRecord)
    .where(eq(pgSchema.contextRecord.id, target));
  expect(stored).toHaveLength(0);
  expect((await remember(f, ENTRIES, later + MINUTE)).status).toBe("stored");
  const swept = (await bodies(f, later + 2 * MINUTE)).join("\n");
  expect(swept).not.toContain("CANARY-FORGET");
  expect(swept).toContain("SIBLING-FACT");
});

test("forget refuses Linear documents, other scopes, revoked access and narrower sources without changing anything", async () => {
  const f = fixture();
  const other: ContextNamespace = { ...f.namespace, scopeId: `${f.namespace.scopeId}-b` };
  const otherWorkspace = fixture();
  await remember(f, ENTRIES, T0);
  await remember(f, ENTRIES, T0, other);
  await remember(otherWorkspace, ENTRIES, T0);
  await ingestContext(db, f.access, {
    namespace: f.namespace,
    requester: f.alice,
    source: {
      kind: "linear_project_document",
      id: "doc-1",
      url: "https://linear.app/doc/1",
      revision: "rev-1",
      revisionAt: T0,
      actorId: "writer",
      restriction: { teamIds: ["team-a"] },
    },
    claims: [
      {
        key: "doc-key",
        layer: "observation",
        classification: "reported_fact",
        importance: 1,
        body: "DOC-ENTRY",
      },
    ],
    now: T0,
  });
  const doc = await recordId(f, "DOC-ENTRY", T0 + MINUTE);
  expect((await forget(f, doc, T0 + MINUTE)).status).toBe("refused");

  const foreignId = await recordId(otherWorkspace, "CANARY-FORGET", T0 + MINUTE);
  expect((await forget(f, foreignId, T0 + MINUTE)).status).toBe("refused");
  expect(
    (
      await forgetContextRecord(db, f.access, {
        namespace: otherWorkspace.namespace,
        requester: f.alice,
        recordId: foreignId,
        now: T0 + MINUTE,
      })
    ).status,
  ).toBe("refused");
  expect((await forget(f, "01UNKNOWNRECORD", T0 + MINUTE)).status).toBe("refused");

  const target = await recordId(f, "CANARY-FORGET", T0 + MINUTE);
  const outsider: ContextRequester = { workspaceId: f.alice.workspaceId, userId: "outsider" };
  f.access.grant(outsider, { teamIds: ["team-b"], repositories: [], channelIds: [] });
  expect((await forget(f, target, T0 + MINUTE, outsider)).status).toBe("refused");
  f.access.grants.delete(`${f.alice.workspaceId}\0${f.alice.userId}`);
  expect((await forget(f, target, T0 + MINUTE)).status).toBe("refused");
  f.access.grant(f.alice, { teamIds: ["team-a"], repositories: ["acme/app"], channelIds: [] });

  expect((await listContextAudit(db, f.namespace, 50)).map((row) => row.action)).not.toContain(
    "forget_entry",
  );
  expect((await bodies(f, T0 + 2 * MINUTE)).join("\n")).toContain("CANARY-FORGET");

  expect((await forget(f, target, T0 + 2 * MINUTE)).status).toBe("forgotten");
  expect((await bodies(f, T0 + 3 * MINUTE, other)).join("\n")).toContain("CANARY-FORGET");
  expect((await bodies(otherWorkspace, T0 + 3 * MINUTE)).join("\n")).toContain("CANARY-FORGET");
});

test("a forget racing ingestion and correction leaves the entry absent and its siblings present", async () => {
  const f = fixture();
  await remember(f, ENTRIES, T0);
  const target = await recordId(f, "CANARY-FORGET", T0 + MINUTE);
  const results = await Promise.all([
    forget(f, target, T0 + 2 * MINUTE),
    remember(f, ENTRIES, T0 + 2 * MINUTE),
    correctContext(db, f.access, {
      namespace: f.namespace,
      requester: f.alice,
      recordId: target,
      body: "CANARY-FORGET corrected text.",
      now: T0 + 2 * MINUTE,
    }),
    forget(f, target, T0 + 2 * MINUTE),
  ]);
  expect(results.filter((result) => result.status === "forgotten")).toHaveLength(1);
  await remember(f, ENTRIES, T0 + 3 * MINUTE);
  const after = (await bodies(f, T0 + 4 * MINUTE)).join("\n");
  expect(after).not.toContain("CANARY-FORGET");
  expect(after).toContain("SIBLING-FACT");
  expect(after).toContain("SIBLING-DECISION");
});

test("a populated database from before entry forgetting migrates, and a forget survives a restart", async () => {
  const dir = join(tempHome(), "pglite");
  const f = fixture();
  const opened = await openPawsStore({ url: null, pgliteDir: dir });
  await recordWorkItemContext(opened.store, f.access, {
    namespace: f.namespace,
    requester: f.alice,
    workItemId: "item-1",
    revision: "remember-1",
    revisionAt: T0,
    restriction: { teamIds: ["team-a"] },
    entries: ENTRIES,
    now: T0,
  });
  const forgetting = journal.entries.find((entry) => entry.tag === "0008_context_forgotten_entry")!;
  await sqlRun(opened.store, "DROP TABLE context_forgotten_entry");
  await sqlRun(opened.store, "ALTER TABLE queue_position DROP COLUMN waiting_for");
  await sqlRun(
    opened.store,
    `DELETE FROM drizzle.__drizzle_migrations WHERE created_at >= ${forgetting.when}`,
  );
  await opened.close();

  const migrated = await openPawsStore({ url: null, pgliteDir: dir });
  const query = (store: Db, now: number) =>
    queryContext(store, f.access, {
      namespace: f.namespace,
      requester: f.alice,
      destination: { audience: "project_members" },
      limit: 50,
      maxBytes: 32_000,
      now,
    });
  const before = await query(migrated.store, T0 + MINUTE);
  if (before.status !== "ok") throw new Error("query refused");
  expect(before.records).toHaveLength(3);
  const target = before.records.find((record) => record.body.includes("CANARY-FORGET"))!.id;
  const outcome = await forgetContextRecord(migrated.store, f.access, {
    namespace: f.namespace,
    requester: f.alice,
    recordId: target,
    now: T0 + 2 * MINUTE,
  });
  expect(outcome.status).toBe("forgotten");
  await migrated.close();

  const restarted = await openPawsStore({ url: null, pgliteDir: dir });
  try {
    await recordWorkItemContext(restarted.store, f.access, {
      namespace: f.namespace,
      requester: f.alice,
      workItemId: "item-1",
      revision: "remember-2",
      revisionAt: T0 + 3 * MINUTE,
      restriction: { teamIds: ["team-a"] },
      entries: ENTRIES,
      now: T0 + 3 * MINUTE,
    });
    const after = await query(restarted.store, T0 + 4 * MINUTE);
    if (after.status !== "ok") throw new Error("query refused");
    expect(after.records.map((record) => record.body).sort()).toEqual(
      [ENTRIES[2]!.body, ENTRIES[1]!.body].sort(),
    );
  } finally {
    await restarted.close();
  }
}, 30_000);
