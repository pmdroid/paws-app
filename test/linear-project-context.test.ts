import { expect, test } from "bun:test";
import {
  createLinearProjectContextReads,
  PROJECT_CONTEXT_LIMITS,
  type LinearClient,
} from "../src/linear";
import { projectContextClaims } from "../src/project-context";

function stubClient(data: unknown) {
  const calls: { query: string; variables: Record<string, unknown> | undefined }[] = [];
  const client: LinearClient = {
    async query(query, variables) {
      calls.push({ query, variables });
      return structuredClone(data);
    },
  };
  return { client, calls };
}

test("the project context read makes one bounded request and clips every source by bytes", async () => {
  const documents = Array.from({ length: 14 }, (_, index) => ({
    id: `doc-${index}`,
    title: `Doc ${index}`,
    url: `https://linear.app/d/doc-${index}`,
    updatedAt: "2026-11-17T10:00:00.000Z",
    content: "ü".repeat(15_000),
    creator: { id: "user-1" },
  }));
  const { client, calls } = stubClient({
    project: {
      id: "p1",
      name: "Shared project context",
      url: "https://linear.app/p/p1",
      updatedAt: "2026-11-17T09:00:00.000Z",
      content: "Project description",
      teams: { nodes: [{ id: "t1" }, { id: "t2" }] },
      documents: { nodes: [...documents, { id: "empty", title: "Empty", content: " " }] },
    },
  });
  const read = await createLinearProjectContextReads(client).projectContextSources("p1");
  expect(calls).toHaveLength(1);
  expect(calls[0]!.variables).toEqual({ id: "p1" });
  expect(calls[0]!.query).toContain("documents(first: 10");
  expect(read?.teamIds).toEqual(["t1", "t2"]);
  expect(read?.revisionAt).toBe(Date.parse("2026-11-17T09:00:00.000Z"));
  expect(read?.documents).toHaveLength(PROJECT_CONTEXT_LIMITS.documents);
  for (const document of read!.documents)
    expect(Buffer.byteLength(document.content, "utf8")).toBeLessThanOrEqual(
      PROJECT_CONTEXT_LIMITS.bytesPerSource,
    );
  expect(read?.documents[0]).toMatchObject({
    id: "doc-0",
    revision: "2026-11-17T10:00:00.000Z",
    creatorId: "user-1",
  });
});

test("a project read without an id, url or revision yields nothing", async () => {
  const { client } = stubClient({ project: { id: "p1", name: "n", content: "c" } });
  expect(await createLinearProjectContextReads(client).projectContextSources("p1")).toBeNull();
});

test("only decisions, constraints and open questions become observations", () => {
  const claims = projectContextClaims(
    [
      "Intro paragraph that stays in the source text only.",
      "## Product and architecture decisions",
      "- Use the existing Postgres store.",
      "## Scope",
      "- Not an observation.",
      "## Open questions",
      "1. Who owns retention?",
      "```",
      "Decision: inside a code block",
      "```",
      "Constraint: no Linear writeback.",
    ].join("\n"),
  );
  expect(claims.map((claim) => [claim.classification, claim.body])).toEqual([
    ["decision", "Use the existing Postgres store."],
    ["unresolved_question", "Who owns retention?"],
    ["reported_fact", "no Linear writeback."],
  ]);
  expect(new Set(claims.map((claim) => claim.key)).size).toBe(3);
});

test("a document check reads known ids in one bounded request and tells removed, missing and moved apart", async () => {
  const node = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    title: `Doc ${id}`,
    url: `https://linear.app/d/${id}`,
    updatedAt: "2026-11-17T10:00:00.000Z",
    content: "Decision: kept",
    creator: { id: "user-1" },
    project: { id: "p1" },
    archivedAt: null,
    trashed: false,
    ...extra,
  });
  const { client, calls } = stubClient({
    documents: {
      nodes: [
        node("found"),
        node("moved", { project: { id: "p2" } }),
        node("trashed", { trashed: true }),
        node("archived", { archivedAt: "2026-11-17T11:00:00.000Z" }),
        { id: "broken" },
      ],
    },
  });
  const reads = createLinearProjectContextReads(client);
  const checks = await reads.projectContextDocuments([
    "found",
    "moved",
    "trashed",
    "archived",
    "broken",
    "gone",
  ]);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.variables).toEqual({
    ids: ["found", "moved", "trashed", "archived", "broken", "gone"],
  });
  expect(checks.map((check) => [check.id, check.status])).toEqual([
    ["found", "found"],
    ["moved", "found"],
    ["trashed", "removed"],
    ["archived", "removed"],
    ["broken", "uncertain"],
    ["gone", "missing"],
  ]);
  expect(checks[1]).toMatchObject({ projectId: "p2" });
  await expect(
    reads.projectContextDocuments(
      Array.from({ length: PROJECT_CONTEXT_LIMITS.documentsPerCheck + 1 }, (_, i) => `d${i}`),
    ),
  ).rejects.toThrow("Too many");
  expect(calls).toHaveLength(1);
  const { client: empty } = stubClient({ documents: null });
  expect(await createLinearProjectContextReads(empty).projectContextDocuments(["a"])).toEqual([
    { id: "a", status: "uncertain" },
  ]);
});
