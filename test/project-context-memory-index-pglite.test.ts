import { afterAll, beforeAll, expect, test } from "bun:test";
import { getContextSession, type ContextNamespace, type Db } from "../src/db";
import {
  CONTEXT_SESSION_NOTICE,
  MEMORY_INDEX_HEADER,
  MEMORY_INDEX_LIMITS,
  checkContextDelivery,
  createFakeContextAccess,
  createProjectSessionContext,
  estimateContextTokens,
  recordWorkItemContext,
  type ContextManifest,
  type ContextRequester,
  type WorkItemContextEntry,
} from "../src/project-context";
import { tempStore } from "./pglite";

const T0 = Date.parse("2026-11-18T12:00:00Z");
const NOTE =
  "Project memory: the context above is what earlier Paws sessions left for this project. Save what a future agent should know with `remember`.";
const SHORT_DECISION = "Exports stay CSV-only for the first release because finance imports CSV.";
const LONG_DECISION = `Invoices are rounded per line ${"and the rounding rule applies to every currency ".repeat(8)}end.`;

let db: Db;
let close: () => Promise<void>;
let seq = 0;

beforeAll(async () => {
  ({ db, close } = await tempStore());
});
afterAll(async () => {
  await close();
});

const REQUEST = "Add an export of invoices";
const RESPONSE_TOKENS = 8_000;

async function prepareIndex(facts: number, room?: number) {
  seq++;
  const workspaceId = `org-index-${seq}`;
  const projectId = `project-index-${seq}`;
  const namespace: ContextNamespace = {
    workspaceId,
    scopeKind: "linear_project",
    scopeId: projectId,
  };
  const alice: ContextRequester = { workspaceId, userId: `alice-${seq}` };
  const access = createFakeContextAccess();
  access.grant(alice, { teamIds: ["team-a"], repositories: [], channelIds: [] });
  const batches: WorkItemContextEntry[][] = [
    [
      { classification: "decision", body: SHORT_DECISION },
      { classification: "decision", body: LONG_DECISION },
    ],
  ];
  for (let start = 0; start < facts; start += 8)
    batches.push(
      Array.from({ length: Math.min(8, facts - start) }, (_, offset) => ({
        classification: "reported_fact" as const,
        body: `Fact ${start + offset}: the invoice exporter writes ${"one column per tax rate ".repeat(4)}`,
      })),
    );
  for (const [index, entries] of batches.entries()) {
    const outcome = await recordWorkItemContext(db, access, {
      namespace,
      requester: alice,
      workItemId: `item-${seq}-${index}`,
      revision: `rev-${index}`,
      revisionAt: T0,
      restriction: { teamIds: ["team-a"] },
      entries,
      now: T0,
    });
    expect(outcome.status).toBe("stored");
  }
  const service = createProjectSessionContext({
    db,
    access,
    memoryIndex: true,
    ...(room === undefined
      ? {}
      : { model: { contextTokens: RESPONSE_TOKENS + estimateContextTokens(REQUEST) + room } }),
    now: () => T0 + 1,
  });
  const prepared = await service.prepare({
    consumerKey: `work_item:index-${seq}`,
    organizationId: workspaceId,
    projectId,
    requesterId: alice.userId,
    instructions: "",
    request: REQUEST,
    appendix: NOTE,
  });
  return { prepared, access, alice };
}

async function seeded(facts: number, room?: number) {
  const { prepared, access, alice } = await prepareIndex(facts, room);
  if (prepared.status !== "injected" || !prepared.manifest)
    throw new Error(`not injected: ${JSON.stringify(prepared)}`);
  return { prepared: { ...prepared, manifest: prepared.manifest }, access, alice };
}

function lines(text: string) {
  return text.split("\n").filter((line) => line.startsWith("- ["));
}

test("the brief carries a short index with ids, source labels and short decisions in full", async () => {
  const { prepared, access, alice } = await seeded(3);
  const { text, manifest } = prepared;
  expect(text.startsWith(`${MEMORY_INDEX_HEADER}\n`)).toBe(true);
  expect(text).not.toContain("more entries");
  expect(text.endsWith(CONTEXT_SESSION_NOTICE)).toBe(true);
  const listed = lines(text);
  expect(listed).toHaveLength(5);
  expect(listed[0]!.startsWith("- [decision] ")).toBe(true);
  expect(listed[1]!.startsWith("- [decision] ")).toBe(true);
  expect(text).toContain(`- [decision] ${SHORT_DECISION} (paws_work_item item-${seq}-0@rev-0, id `);
  expect(text).not.toContain(LONG_DECISION);
  expect(text).toContain(`${LONG_DECISION.slice(0, MEMORY_INDEX_LIMITS.lineChars - 1)}…`);
  for (const source of manifest.sources) expect(text).toContain(`, id ${source.recordId})`);
  expect(manifest.sources).toHaveLength(5);
  expect(manifest.references).toEqual([]);
  const stored = await getContextSession(db, `work_item:index-${seq}`);
  if (!stored) throw new Error("no stored session");
  expect((stored.manifest as ContextManifest).sources.map((source) => source.recordId)).toEqual(
    manifest.sources.map((source) => source.recordId),
  );
  expect(
    await checkContextDelivery(db, access, {
      consumerKey: `work_item:index-${seq}`,
      requester: alice,
      destination: { audience: "project_members" },
      version: prepared.version,
      now: T0 + 1,
    }),
  ).toEqual({ status: "current" });
});

test("an index over the cap drops lines from the end and says how many more entries exist", async () => {
  const { prepared } = await seeded(40);
  const { text, manifest } = prepared;
  const overview = `${text}\n\n${NOTE}`;
  expect(estimateContextTokens(overview)).toBeLessThanOrEqual(MEMORY_INDEX_LIMITS.tokens);
  const listed = lines(text);
  const more = 42 - listed.length;
  expect(more).toBeGreaterThan(0);
  expect(text.split("\n")[0]).toBe(
    `${MEMORY_INDEX_HEADER} ${more} more entries: use recall({query}).`,
  );
  expect(listed.slice(0, 2).every((line) => line.startsWith("- [decision] "))).toBe(true);
  expect(manifest.sources.map((source) => source.recordId)).toEqual(
    listed.map((line) => line.match(/, id (\S+)\)$/)![1]!),
  );
});

test("a tight prompt budget clamps the index to the room actually left, counting the note", async () => {
  const room = 400;
  const { prepared } = await seeded(40, room);
  const { text, manifest } = prepared;
  const contextTokens = RESPONSE_TOKENS + estimateContextTokens(REQUEST) + room;
  const note = estimateContextTokens(`\n\n${NOTE}`);
  const prompt =
    estimateContextTokens(REQUEST) + RESPONSE_TOKENS + estimateContextTokens(text) + note;
  expect(prompt).toBeLessThanOrEqual(contextTokens);
  expect(manifest.tokens.hardCap).toBe(contextTokens);
  expect(manifest.tokens.memoryBudget).toBeLessThanOrEqual(room);
  expect(manifest.tokens.memoryUsed).toBe(estimateContextTokens(text) + note);
  expect(manifest.tokens.total).toBe(prompt);
  const listed = lines(text);
  expect(listed.length).toBeGreaterThan(0);
  expect(listed.length).toBeLessThan(42);
  expect(text.split("\n")[0]).toContain(`${42 - listed.length} more entries`);
  expect(manifest.sources.map((source) => source.recordId)).toEqual(
    listed.map((line) => line.match(/, id (\S+)\)$/)![1]!),
  );
  const stored = await getContextSession(db, `work_item:index-${seq}`);
  expect(stored?.status).toBe("injected");
  expect((stored!.manifest as ContextManifest).sources).toEqual(manifest.sources);
});

test("an index whose header, notice and note can't fit with one entry is withheld", async () => {
  const { prepared } = await prepareIndex(3, 200);
  expect(prepared.status).toBe("withheld");
  expect(prepared.reason).toBe("over_budget");
  expect(prepared.manifest).toBeNull();
  expect(prepared.text).not.toContain(MEMORY_INDEX_HEADER);
  const stored = await getContextSession(db, `work_item:index-${seq}`);
  expect(stored?.status).toBe("withheld");
  expect(stored?.manifest).toEqual({});
});
