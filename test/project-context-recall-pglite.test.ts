import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { currentSourceContextRecords, pgSchema, type ContextNamespace, type Db } from "../src/db";
import {
  PROJECT_MEMORY_UNAVAILABLE,
  compactContext,
  correctContext,
  createContextCapacity,
  createFakeContextSummarizer,
  forgetContextSource,
  selectContext,
  type ContextBudgetSettings,
  type ContextRequester,
  RECALL_LIMITS,
  RECALL_NO_ENTRY,
  createFakeContextAccess,
  createFakeProjectContextReads,
  estimateContextTokens,
  ingestContext,
  ingestLinearProjectContext,
  recallProjectContext,
  type RecallEntry,
  type RecallRequest,
} from "../src/project-context";
import { tempStore } from "./pglite";

const T0 = Date.parse("2026-11-17T12:00:00Z");

let db: Db;
let close: () => Promise<void>;
let seq = 0;

beforeAll(async () => {
  ({ db, close } = await tempStore());
});
afterAll(async () => {
  await close();
});

async function fixture() {
  seq++;
  const workspaceId = `org-recall-${seq}`;
  const projectId = `project-${seq}`;
  const alice = { workspaceId, userId: `alice-${seq}` };
  const bob = { workspaceId, userId: `bob-${seq}` };
  const access = createFakeContextAccess();
  access.grant(alice, { teamIds: ["team-a"], repositories: [], channelIds: [] });
  access.grant(bob, { teamIds: ["team-a", "team-b"], repositories: [], channelIds: [] });
  const reads = createFakeProjectContextReads();
  reads.projects.set(projectId, {
    id: projectId,
    name: "Exports",
    url: `https://linear.app/p/${projectId}`,
    revision: "p1",
    revisionAt: T0,
    teamIds: ["team-a"],
    content: "Exports ship as CSV.",
  });
  await ingestLinearProjectContext(db, access, reads, {
    workspaceId,
    projectId,
    requester: alice,
    now: T0,
  });
  const namespace: ContextNamespace = {
    workspaceId,
    scopeKind: "linear_project",
    scopeId: projectId,
  };
  const put = async (
    id: string,
    bodies: readonly string[],
    teamIds = ["team-a"],
    importance = 1,
  ) => {
    await ingestContext(db, access, {
      namespace,
      requester: teamIds.includes("team-b") ? bob : alice,
      source: {
        kind: "linear_project_document",
        id,
        url: `https://linear.app/doc/${id}`,
        revision: "r1",
        revisionAt: T0,
        actorId: "writer",
        restriction: { teamIds },
      },
      claims: bodies.map((body, index) => ({
        key: `${id}-${index}`,
        layer: "observation",
        classification: "reported_fact",
        importance,
        body,
      })),
      now: T0,
    });
    return currentSourceContextRecords(
      db,
      namespace,
      { kind: "linear_project_document", id },
      T0 + 1000,
    );
  };
  const recall = (request: unknown, overrides: Partial<RecallRequest> = {}) =>
    recallProjectContext(db, access, {
      organizationId: workspaceId,
      projectId,
      requesterId: alice.userId,
      request,
      now: T0 + 1000,
      ...overrides,
    });
  return { put, recall, access, namespace, alice, bob };
}

test("an id returns that record", async () => {
  const { put, recall } = await fixture();
  const [row] = await put("doc-rounding", ["Invoices round half to even."]);
  const found = JSON.parse(await recall({ id: row!.id })) as RecallEntry;
  expect(found).toEqual({
    id: row!.id,
    classification: "reported_fact",
    source: {
      kind: "linear_project_document",
      id: "doc-rounding",
      url: "https://linear.app/doc/doc-rounding",
      revision: "r1",
    },
    body: "Invoices round half to even.",
    truncated: false,
  });
});

test("an id outside the requester's access answers exactly like a missing id", async () => {
  const { put, recall } = await fixture();
  const [hidden] = await put("doc-private", ["Team B pricing is secret."], ["team-b"]);
  expect(hidden).toBeDefined();
  expect(await recall({ id: hidden!.id })).toBe(RECALL_NO_ENTRY);
  expect(await recall({ id: "01NOSUCHRECORD0000000000000" })).toBe(RECALL_NO_ENTRY);
});

test("a query returns at most six ranked entries within the token budget", async () => {
  const { put, recall } = await fixture();
  await put(
    "doc-many",
    Array.from({ length: 12 }, (_, index) => `Exports note ${index}: ${"padding ".repeat(60)}`),
  );
  await put("doc-match", ["Invoices round half to even when exporting totals."]);
  const entries = JSON.parse(await recall({ query: "invoices round" })) as RecallEntry[];
  expect(entries.length).toBeGreaterThan(0);
  expect(entries.length).toBeLessThanOrEqual(RECALL_LIMITS.entries);
  expect(entries[0]!.body).toContain("Invoices round half to even");
  const tokens = entries.reduce((sum, entry) => sum + estimateContextTokens(entry.body), 0);
  expect(tokens).toBeLessThanOrEqual(RECALL_LIMITS.tokens);
});

test("an item outside a project or without access gets the unavailable message", async () => {
  const { recall } = await fixture();
  expect(await recall({ query: "exports" }, { projectId: null })).toBe(PROJECT_MEMORY_UNAVAILABLE);
  expect(await recall({ query: "exports" }, { requesterId: null })).toBe(
    PROJECT_MEMORY_UNAVAILABLE,
  );
  expect(await recall({ id: "x" }, { requesterId: "mallory" })).toBe(PROJECT_MEMORY_UNAVAILABLE);
  expect(await recall({ query: "exports" }, { projectId: `project-missing-${seq}` })).toBe(
    PROJECT_MEMORY_UNAVAILABLE,
  );
});

test("both query and id, neither, or an extra field is rejected", async () => {
  const { recall } = await fixture();
  for (const request of [
    {},
    { query: "exports", id: "x" },
    { query: "" },
    { query: "x".repeat(201) },
    { query: "exports", scope: "workspace" },
  ])
    await expect(recall(request)).rejects.toThrow("Not recalled");
});

const SMALL: Partial<ContextBudgetSettings> = {
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

const MATCH = "Invoices round half to even when exporting totals.";

/** Stores the body with filler past the soft threshold, then compacts them into a valid summary. */
async function compacted(
  { put, access, namespace }: Awaited<ReturnType<typeof fixture>>,
  requester: ContextRequester,
  id: string,
  body: string,
  teamIds = ["team-a"],
) {
  // More important than the filler, so the summary's bounded input includes it.
  const [target] = await put(id, [body], teamIds, 2);
  await put(
    `${id}-notes`,
    Array.from(
      { length: 30 },
      (_, index) => `Exports note ${index}: batches retry in region eu-${index}.`,
    ),
    teamIds,
  );
  const prompt = {
    namespace,
    requester,
    destination: { audience: "project_members" } as const,
    instructions: "You are working on a Paws task.",
    request: "Fix the export retry behaviour",
    toolsTokens: 300,
    model: { contextTokens: 100_000 },
    settings: SMALL,
  };
  const before = await selectContext(db, access, { ...prompt, now: T0 + 1000 });
  expect(before.status === "ok" && before.manifest.compaction).toBe("requested");
  const run = await compactContext(
    db,
    access,
    createFakeContextSummarizer(),
    createContextCapacity(),
    {
      namespace,
      requester,
      destination: { audience: "project_members" },
      settings: SMALL,
      now: T0 + 2000,
    },
  );
  expect(run.status).not.toBe("refused");
  const covered = await db.orm
    .select({ recordId: pgSchema.contextSummarySource.recordId })
    .from(pgSchema.contextSummarySource)
    .innerJoin(
      pgSchema.contextSummary,
      eq(pgSchema.contextSummary.id, pgSchema.contextSummarySource.summaryId),
    )
    .where(
      and(
        eq(pgSchema.contextSummary.workspaceId, namespace.workspaceId),
        eq(pgSchema.contextSummarySource.recordId, target!.id),
      ),
    );
  // The summary covers the matching record, so a prompt pack leaves it out.
  expect(covered).toHaveLength(1);
  const after = await selectContext(db, access, {
    ...prompt,
    request: "invoices round half even",
    now: T0 + 3000,
  });
  if (after.status !== "ok") throw new Error(`selection ${after.status}`);
  expect(after.manifest.summary).not.toBeNull();
  expect(after.manifest.sources.map((source) => source.recordId)).not.toContain(target!.id);
  return target!;
}

const later = { now: T0 + 4000 };

test("a query finds a record a valid summary covers, and its id still retrieves it", async () => {
  const f = await fixture();
  const target = await compacted(f, f.alice, "doc-rounding", MATCH);
  const entries = JSON.parse(
    await f.recall({ query: "invoices round half even" }, later),
  ) as RecallEntry[];
  expect(entries.length).toBeLessThanOrEqual(RECALL_LIMITS.entries);
  expect(entries[0]).toEqual({
    id: target.id,
    classification: "reported_fact",
    source: {
      kind: "linear_project_document",
      id: "doc-rounding",
      url: "https://linear.app/doc/doc-rounding",
      revision: "r1",
    },
    body: MATCH,
    truncated: false,
  });
  const tokens = entries.reduce((sum, entry) => sum + estimateContextTokens(entry.body), 0);
  expect(tokens).toBeLessThanOrEqual(RECALL_LIMITS.tokens);
  expect(JSON.parse(await f.recall({ id: target.id }, later))).toEqual(entries[0]);
});

test("a query over a compacted record returns its correction, not the replaced text", async () => {
  const f = await fixture();
  const target = await compacted(f, f.alice, "doc-rounding", MATCH);
  const corrected = await correctContext(db, f.access, {
    namespace: f.namespace,
    requester: f.alice,
    recordId: target.id,
    body: "Correction: invoices round half up when exporting totals.",
    now: T0 + 3500,
  });
  expect(corrected.status).toBe("corrected");
  const text = await f.recall({ query: "invoices round exporting totals" }, later);
  expect(text).toContain("Correction: invoices round half up when exporting totals.");
  expect(text).not.toContain(MATCH);
});

test("a forgotten compacted source is not found by query or id", async () => {
  const f = await fixture();
  const target = await compacted(f, f.alice, "doc-rounding", MATCH);
  const forgotten = await forgetContextSource(db, f.access, {
    namespace: f.namespace,
    requester: f.alice,
    source: { kind: "linear_project_document", id: "doc-rounding" },
    now: T0 + 3500,
  });
  expect(forgotten.status).not.toBe("refused");
  const text = await f.recall({ query: "invoices round half even" }, later);
  expect(text).not.toContain(MATCH);
  expect(text).not.toContain(target.id);
  expect(await f.recall({ id: target.id }, later)).toBe(RECALL_NO_ENTRY);
});

test("a compacted record behind access the requester lacks or lost stays hidden", async () => {
  const f = await fixture();
  const canary = "Canary: team B invoices round to the nearest dime.";
  const target = await compacted(f, f.bob, "doc-team-b", canary, ["team-b"]);
  const bob = { requesterId: f.bob.userId, ...later };
  expect(await f.recall({ query: "canary team invoices dime" }, bob)).toContain(canary);
  // Alice never had team B; Bob loses it.
  expect(await f.recall({ query: "canary team invoices dime" }, later)).not.toContain(canary);
  expect(await f.recall({ id: target.id }, later)).toBe(RECALL_NO_ENTRY);
  f.access.grant(f.bob, { teamIds: ["team-a"], repositories: [], channelIds: [] });
  expect(await f.recall({ query: "canary team invoices dime" }, bob)).not.toContain(canary);
  expect(await f.recall({ id: target.id }, bob)).toBe(RECALL_NO_ENTRY);
});
