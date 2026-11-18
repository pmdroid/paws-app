import { afterAll, beforeAll, expect, test } from "bun:test";
import { currentSourceContextRecords, type ContextNamespace, type Db } from "../src/db";
import {
  PROJECT_MEMORY_UNAVAILABLE,
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
  const put = async (id: string, bodies: readonly string[], teamIds = ["team-a"]) => {
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
        importance: 1,
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
  return { put, recall };
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
