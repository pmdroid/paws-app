import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Db } from "../src/db";
import { PROJECT_CONTEXT_LIMITS } from "../src/linear";
import {
  CONTEXT_RETENTION,
  correctContext,
  createFakeContextAccess,
  createFakeProjectContextReads,
  ingestLinearProjectContext,
  inspectContext,
  queryContext,
  type ContextNamespace,
  type ContextRecordView,
  type ContextRequester,
  type FakeProjectContextReads,
  type FakeProjectDocument,
} from "../src/project-context";
import { tempStore } from "./pglite";

const T0 = Date.parse("2026-11-17T12:00:00Z");
const MINUTE = 60_000;
const destination = { audience: "project_members" } as const;

let db: Db;
let close: () => Promise<void>;
let seq = 0;

beforeAll(async () => {
  ({ db, close } = await tempStore());
});
afterAll(async () => {
  await close();
});

function setup(description = "## Decisions\n- Linear stays the canonical project identity.") {
  seq++;
  const workspaceId = `ws-linear-${seq}`;
  const projectId = `project-linear-${seq}`;
  const namespace: ContextNamespace = {
    workspaceId,
    scopeKind: "linear_project",
    scopeId: projectId,
  };
  const alice: ContextRequester = { workspaceId, userId: `alice-${seq}` };
  const access = createFakeContextAccess();
  access.grant(alice, { teamIds: ["team-pas"], repositories: [], channelIds: [] });
  const reads = createFakeProjectContextReads();
  const describedAt = T0 - 60 * MINUTE;
  reads.projects.set(projectId, {
    id: projectId,
    name: "Shared project context",
    url: `https://linear.app/p/${projectId}`,
    revision: new Date(describedAt).toISOString(),
    revisionAt: describedAt,
    teamIds: ["team-pas"],
    content: description,
  });
  const put = (id: string, at: number, content: string, extra: Partial<FakeProjectDocument> = {}) =>
    reads.documents.set(id, {
      id,
      title: `Doc ${id}`,
      url: `https://linear.app/d/${id}`,
      revision: new Date(at).toISOString(),
      revisionAt: at,
      creatorId: "creator-1",
      content,
      projectId,
      ...extra,
    });
  const ingest = (now: number, requester = alice) =>
    ingestLinearProjectContext(db, access, reads, { workspaceId, projectId, requester, now });
  const records = async (now: number, requester = alice): Promise<ContextRecordView[]> => {
    const result = await queryContext(db, access, {
      namespace,
      requester,
      destination,
      limit: 50,
      maxBytes: 32_000,
      now,
    });
    if (result.status !== "ok") throw new Error("query refused");
    return result.records;
  };
  const decisions = async (now: number) =>
    (await records(now))
      .filter((record) => record.classification === "decision")
      .map((record) => record.body)
      .join("\n");
  const text = async (now: number, requester = alice) =>
    (await records(now, requester)).map((record) => record.body).join("\n");
  return {
    workspaceId,
    projectId,
    namespace,
    alice,
    access,
    reads,
    put,
    ingest,
    records,
    text,
    decisions,
  };
}

function pushOutOfWindow(
  reads: FakeProjectContextReads,
  put: (id: string, at: number, c: string) => void,
  at: number,
) {
  for (let index = 0; index < PROJECT_CONTEXT_LIMITS.documents; index++)
    put(`newer-${index}`, at + index, `Unrelated note ${index}`);
  return reads;
}

test("authorized project documents become records with traceable revisions and no duplicates on replay", async () => {
  const { reads, put, ingest, records, projectId } = setup();
  put(
    "doc-1",
    Date.parse("2026-11-17T11:00:00Z"),
    "## Product decisions\n- Use existing Postgres for context.\n## Open questions\n- How long should summaries live?\n```ts\nconst token = 1;\n```",
  );
  const first = await ingest(T0);
  expect(first.sources.map((entry) => entry.outcome)).toEqual(["stored", "stored"]);
  expect(reads.calls).toEqual([{ kind: "project", ids: [projectId] }]);
  const second = await ingest(T0 + 1);
  expect(second.sources.map((entry) => entry.outcome)).toEqual(["stored", "stored"]);

  const result = await records(T0 + 2);
  expect(
    result.find((record) => record.body === "Use existing Postgres for context."),
  ).toMatchObject({
    classification: "decision",
    layer: "observation",
    version: 1,
    source: {
      kind: "linear_project_document",
      id: "doc-1",
      url: "https://linear.app/d/doc-1",
      revision: "2026-11-17T11:00:00.000Z",
    },
    actorId: "creator-1",
  });
  expect(result.filter((record) => record.classification === "unresolved_question")).toHaveLength(
    1,
  );
  expect(result.filter((record) => record.layer === "source_text")).toHaveLength(2);
  const texts = result.map((record) => record.body);
  expect(new Set(texts).size).toBe(texts.length);
  expect(texts.join("\n")).not.toContain("const token");
});

test("a decision and its correction survive ten newer documents through a bounded check by id", async () => {
  const { reads, put, ingest, records, text, namespace, alice } = setup();
  const aAt = T0 - 30 * MINUTE;
  put("doc-a", aAt, "## Decisions\n- Keep project context in the existing Postgres store.");
  await ingest(T0);
  const decision = (await records(T0)).find(
    (record) => record.source.id === "doc-a" && record.classification === "decision",
  )!;
  const corrected = await correctContext(db, createAccessFor(alice), {
    namespace,
    requester: alice,
    recordId: decision.id,
    body: "Keep project context in Postgres; no vector store.",
    now: T0 + 1,
  });
  expect(corrected.status).toBe("corrected");

  pushOutOfWindow(reads, put, T0);
  reads.calls.length = 0;
  const reread = await ingest(T0 + 2);
  expect(reads.calls).toEqual([
    { kind: "project", ids: [namespace.scopeId] },
    { kind: "documents", ids: ["doc-a"] },
  ]);
  expect(reread.sources.filter((entry) => entry.id === "doc-a")).toEqual([
    { kind: "linear_project_document", id: "doc-a", outcome: "stored" },
  ]);
  const kept = (await records(T0 + 2)).find(
    (record) => record.body === "Keep project context in Postgres; no vector store.",
  );
  expect(kept).toMatchObject({
    classification: "decision",
    version: 2,
    correctedBy: alice.userId,
    source: { kind: "linear_project_document", id: "doc-a", revision: new Date(aAt).toISOString() },
  });
  expect(await text(T0 + 2)).toContain("Unrelated note 9");
});

function createAccessFor(requester: ContextRequester) {
  const access = createFakeContextAccess();
  access.grant(requester, { teamIds: ["team-pas"], repositories: [], channelIds: [] });
  return access;
}

test("documents outside the window that were deleted, emptied, moved or are no longer visible are cleared", async () => {
  const { reads, put, ingest, text, namespace, alice, access } = setup();
  const old = T0 - 30 * MINUTE;
  put("doc-trashed", old, "Decision: CANARY-TRASHED");
  put("doc-emptied", old, "Decision: CANARY-EMPTIED");
  put("doc-moved", old, "Decision: CANARY-MOVED");
  put("doc-missing", old, "Decision: CANARY-MISSING");
  await ingest(T0);
  expect(await text(T0)).toContain("CANARY-MOVED");
  const before = (await queryContext(db, access, {
    namespace,
    requester: alice,
    destination,
    limit: 50,
    maxBytes: 32_000,
    now: T0,
  })) as { records: ContextRecordView[] };

  pushOutOfWindow(reads, put, T0);
  reads.documents.get("doc-trashed")!.trashed = true;
  put("doc-emptied", old + 1, " ");
  reads.documents.get("doc-moved")!.projectId = "another-project";
  reads.documents.get("doc-missing")!.hidden = true;
  const reread = await ingest(T0 + 1);
  const reasons = reread.invalidations.flatMap((invalidation) =>
    invalidation.records
      .filter((record) => record.reason !== "unverified")
      .map((record) => `${record.sourceId}:${record.reason}`),
  );
  expect(new Set(reasons)).toEqual(
    new Set([
      "doc-trashed:deleted",
      "doc-emptied:edited",
      "doc-moved:revoked",
      "doc-missing:deleted",
    ]),
  );
  const after = await text(T0 + 1);
  for (const canary of ["TRASHED", "EMPTIED", "MOVED", "MISSING"])
    expect(after).not.toContain(`CANARY-${canary}`);
  for (const record of before.records.filter((r) => r.body.includes("CANARY")))
    expect(
      await inspectContext(db, access, {
        namespace,
        requester: alice,
        destination,
        recordId: record.id,
        now: T0 + 1,
      }),
    ).toBeNull();

  put("doc-moved", old, "Decision: CANARY-MOVED");
  reads.documents.get("doc-missing")!.hidden = false;
  await ingest(T0 + 2);
  expect(await text(T0 + 2)).not.toContain("CANARY-MOVED");
  expect(await text(T0 + 2)).not.toContain("CANARY-MISSING");
});

test("failed or partial reads withhold retained documents without erasing them", async () => {
  const { reads, put, ingest, text } = setup("Decision: CANARY-DESCRIPTION");
  put("doc-a", T0 - 30 * MINUTE, "Decision: CANARY-A");
  await ingest(T0);
  expect(await text(T0)).toContain("CANARY-A");

  pushOutOfWindow(reads, put, T0);
  reads.failures.documents = new Error("Linear timed out");
  await ingest(T0 + 1);
  expect(await text(T0 + 1)).not.toContain("CANARY-A");

  reads.failures.documents = undefined;
  reads.failures.project = new Error("Linear is down");
  const failed = await ingest(T0 + 2);
  expect(failed.status).toBe("unavailable");
  const withheld = await text(T0 + 2);
  expect(withheld).not.toContain("CANARY-DESCRIPTION");
  expect(withheld).not.toContain("Unrelated note");

  reads.failures.project = undefined;
  await ingest(T0 + 3);
  const restored = await text(T0 + 3);
  expect(restored).toContain("CANARY-A");
  expect(restored).toContain("CANARY-DESCRIPTION");
  expect(restored).toContain("Unrelated note 9");
});

test("a requester without access neither reads nor clears, and revoked or unknown access sees nothing", async () => {
  const { workspaceId, reads, put, ingest, text, access, alice } = setup(
    "Decision: CANARY-DESCRIPTION",
  );
  put("doc-a", T0 - 30 * MINUTE, "Decision: CANARY-A");
  await ingest(T0);
  pushOutOfWindow(reads, put, T0);
  const bob = { workspaceId, userId: `bob-${seq}` };
  reads.calls.length = 0;
  const refused = await ingest(T0 + 1, bob);
  expect(refused.sources.every((entry) => entry.outcome === "refused")).toBe(true);
  expect(reads.calls.filter((call) => call.kind === "documents")).toEqual([]);
  expect(await text(T0 + 1, bob)).toBe("");
  expect(await text(T0 + 1)).toContain("CANARY-A");

  access.grant(alice, { teamIds: ["team-other"], repositories: [], channelIds: [] });
  expect(await text(T0 + 1)).toBe("");
  access.grants.set(`${workspaceId}\0${alice.userId}`, new Error("access unknown"));
  expect(await text(T0 + 1)).toBe("");
});

test("an emptied description clears its records", async () => {
  const { reads, ingest, text, projectId } = setup();
  await ingest(T0);
  expect(await text(T0)).toContain("canonical project identity");
  const projectRow = reads.projects.get(projectId)!;
  reads.projects.set(projectId, {
    ...projectRow,
    content: " ",
    revision: new Date(T0).toISOString(),
    revisionAt: T0,
  });
  const reread = await ingest(T0 + 1);
  const reasons = reread.invalidations.flatMap((invalidation) =>
    invalidation.records.map((record) => [record.sourceId, record.reason]),
  );
  expect(reasons).toContainEqual([projectId, "edited"]);
  expect(await text(T0 + 1)).not.toContain("canonical project identity");
});

test("retained documents beyond one read's check budget are withheld once stale until a later read checks them", async () => {
  const { reads, put, ingest, decisions } = setup();
  const limits = PROJECT_CONTEXT_LIMITS;
  const budget = limits.documentsPerCheck * limits.checksPerRead;
  const retained = budget + 5;
  for (let batch = 0; batch * limits.documents < retained; batch++) {
    for (
      let index = batch * limits.documents;
      index < Math.min(retained, (batch + 1) * limits.documents);
      index++
    )
      put(
        `kept-${index}`,
        T0 - 1_000 + batch * 10 + (index % limits.documents),
        `Decision: KEPT-${index}.`,
      );
    await ingest(T0 + batch);
  }
  for (let index = 0; index < retained; index++)
    expect(await decisions(T0 + 10)).toContain(`KEPT-${index}.`);

  pushOutOfWindow(reads, put, T0);
  reads.calls.length = 0;
  const later = T0 + 2 * CONTEXT_RETENTION.sourceCheckMs;
  await ingest(later);
  const checks = reads.calls.filter((call) => call.kind === "documents");
  expect(checks).toHaveLength(limits.checksPerRead);
  expect(checks.every((call) => call.ids.length <= limits.documentsPerCheck)).toBe(true);
  const partial = await decisions(later);
  const visible = Array.from({ length: retained }, (_, index) => `KEPT-${index}.`).filter((name) =>
    partial.includes(name),
  );
  expect(visible).toHaveLength(budget);

  await ingest(later + 1);
  const full = await decisions(later + 1);
  for (let index = 0; index < retained; index++) expect(full).toContain(`KEPT-${index}.`);
});
