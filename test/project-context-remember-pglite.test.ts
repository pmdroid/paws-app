import { afterAll, beforeAll, expect, test } from "bun:test";
import { currentSourceContextRecords, type ContextNamespace, type Db } from "../src/db";
import {
  PROJECT_MEMORY_UNAVAILABLE,
  createFakeContextAccess,
  createFakeProjectContextReads,
  ingestLinearProjectContext,
  rememberWorkItemContext,
  type RememberRequest,
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
  const workspaceId = `org-${seq}`;
  const projectId = `project-${seq}`;
  const workItemId = `item-${seq}`;
  const requester = { workspaceId, userId: `alice-${seq}` };
  const access = createFakeContextAccess();
  access.grant(requester, { teamIds: ["team-a"], repositories: [], channelIds: [] });
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
    requester,
    now: T0,
  });
  const namespace: ContextNamespace = {
    workspaceId,
    scopeKind: "linear_project",
    scopeId: projectId,
  };
  let at = T0;
  const remember = (operations: unknown, overrides: Partial<RememberRequest> = {}) =>
    rememberWorkItemContext(db, access, {
      workItemId,
      organizationId: workspaceId,
      projectId,
      requesterId: requester.userId,
      operations,
      now: (at += 1000),
      ...overrides,
    });
  const stored = () =>
    currentSourceContextRecords(db, namespace, { kind: "paws_work_item", id: workItemId }, at);
  return { remember, stored, workItemId, requester };
}

test("an add stores a reported fact with the work item as its source", async () => {
  const { remember, stored, workItemId, requester } = await fixture();
  const answer = await remember([
    { action: "add", kind: "fact", content: "Invoices round half to even." },
    { action: "add", kind: "open_question", content: "Should exports include archived rows?" },
  ]);
  expect(answer).toContain("2 of 10 entries");
  const rows = await stored();
  expect(rows.map((row) => [row.classification, row.body]).sort()).toEqual([
    ["reported_fact", "Invoices round half to even."],
    ["unresolved_question", "Should exports include archived rows?"],
  ]);
  expect(rows.find((row) => row.classification === "reported_fact")).toMatchObject({
    sourceKind: "paws_work_item",
    sourceId: workItemId,
    actorId: requester.userId,
    restriction: { teamIds: ["team-a"] },
  });
  const again = await remember([
    { action: "add", kind: "fact", content: "Invoices round half to even." },
    { action: "add", kind: "fact", content: "invoices  ROUND half to even." },
  ]);
  expect(again).toContain("2 of 10 entries");
  expect((await stored()).map((row) => row.id).sort()).toEqual(rows.map((row) => row.id).sort());
});

test("concurrent calls for one item keep every entry", async () => {
  const { remember, stored } = await fixture();
  await Promise.all(
    ["A.", "B.", "C."].map((content) => remember([{ action: "add", kind: "fact", content }])),
  );
  expect((await stored()).map((row) => row.body).sort()).toEqual(["A.", "B.", "C."]);
});

test("a patch changes only that entry and a remove deletes it", async () => {
  const { remember, stored } = await fixture();
  await remember([
    { action: "add", kind: "fact", content: "Imports run nightly." },
    { action: "add", kind: "fact", content: "Exports use UTF-8." },
  ]);
  const before = await stored();
  const nightly = before.find((row) => row.body === "Imports run nightly.")!;
  const utf8 = before.find((row) => row.body === "Exports use UTF-8.")!;
  await remember([
    {
      action: "patch",
      kind: "fact",
      old_text: "Imports run nightly.",
      content: "Imports run hourly.",
    },
  ]);
  const patched = await stored();
  expect(patched.map((row) => row.body).sort()).toEqual([
    "Exports use UTF-8.",
    "Imports run hourly.",
  ]);
  expect(patched.find((row) => row.body === "Exports use UTF-8.")).toMatchObject({
    id: utf8.id,
    version: utf8.version,
  });
  expect(patched.some((row) => row.id === nightly.id)).toBe(false);

  await remember([{ action: "remove", kind: "fact", old_text: "Exports use UTF-8." }]);
  expect((await stored()).map((row) => row.body)).toEqual(["Imports run hourly."]);

  await expect(
    remember([{ action: "remove", kind: "fact", old_text: "Exports use UTF-8." }]),
  ).rejects.toThrow("old_text must match exactly one entry");
});

test("an eleventh add is rejected and lists the ten current entries", async () => {
  const { remember, stored } = await fixture();
  for (let start = 0; start < 10; start += 5)
    await remember(
      Array.from({ length: 5 }, (_, index) => ({
        action: "add",
        kind: "fact",
        content: `Fact ${start + index}.`,
      })),
    );
  const error = await remember([{ action: "add", kind: "fact", content: "Fact 10." }]).catch(
    (caught: Error) => caught.message,
  );
  expect(error).toContain("already holds 10 entries");
  for (let index = 0; index < 10; index++) expect(error).toContain(`- [fact] Fact ${index}.`);
  expect(error).not.toContain("Fact 10.");
  expect(await stored()).toHaveLength(10);

  await remember([
    { action: "remove", kind: "fact", old_text: "Fact 0." },
    { action: "add", kind: "fact", content: "Fact 10." },
  ]);
  expect((await stored()).map((row) => row.body)).toContain("Fact 10.");
});

test("a 401-character entry and a 6-operation call are rejected and store nothing", async () => {
  const { remember, stored } = await fixture();
  await expect(
    remember([{ action: "add", kind: "fact", content: "x".repeat(401) }]),
  ).rejects.toThrow("operations.0.content");
  await expect(
    remember(
      Array.from({ length: 6 }, (_, index) => ({
        action: "add",
        kind: "fact",
        content: `Fact ${index}.`,
      })),
    ),
  ).rejects.toThrow("Not saved");
  await expect(
    remember([
      { action: "add", kind: "fact", content: "Kept back." },
      { action: "patch", kind: "fact", content: "No target." },
    ]),
  ).rejects.toThrow("old_text is required");
  expect(await stored()).toEqual([]);
});

test("an item outside a project or without access stores nothing", async () => {
  const { remember, stored } = await fixture();
  const add = [{ action: "add", kind: "fact", content: "Exports use UTF-8." }];
  await expect(remember(add, { projectId: null })).rejects.toThrow(PROJECT_MEMORY_UNAVAILABLE);
  await expect(remember(add, { projectId: `project-missing-${seq}` })).rejects.toThrow(
    PROJECT_MEMORY_UNAVAILABLE,
  );
  await expect(remember(add, { requesterId: "mallory" })).rejects.toThrow(
    PROJECT_MEMORY_UNAVAILABLE,
  );
  expect(await stored()).toEqual([]);
});
