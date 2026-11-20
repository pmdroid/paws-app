import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  ensureLinearSessionSteps,
  getWorkItemSteps,
  insertRunSteps,
  putWorkspaceUserSteps,
  requireLinearTaskDelegationSteps,
  syncWorkspaceMemberSteps,
  type Db,
} from "../db";
import { createFakeTracker, type AgentIssue } from "../linear";
import { linearToolsFor, NOT_YOURS } from "./linear-tools";
import { insertWorkItemSteps, withoutForeignKeys } from "../../test/pglite-fixtures";
import { tempStore } from "../../test/pglite";

const stores: { close(): Promise<void> }[] = [];
afterAll(() => Promise.all(stores.map((store) => store.close())));

const issue = (id: string, identifier: string, team: string) => ({
  ...{
    id,
    identifier,
    title: identifier,
    url: null,
    state: null,
    teamKey: identifier.split("-")[0]!,
  },
  ...{ assignee: null, delegate: null, updatedAt: "2026-11-20T00:00:00.000Z", project: null },
  ...{ parent: null, description: "", labels: [], relations: [], comments: [], teamIds: [team] },
});

async function setup(options: { mode?: string | null; creator?: string | null } = {}) {
  const handle = await tempStore();
  stores.push(handle);
  const db: Db = handle.db;
  await withoutForeignKeys(db);
  await db.run(function* (q) {
    yield* q.exec(
      q.orm
        .insert(q.t.workspace)
        .values({ id: "ws", linearOrganizationId: "org", name: "ws", createdAt: 0 }),
    );
    yield* insertWorkItemSteps(q, "item");
    yield* q.exec(
      q.orm.update(q.t.workItem).set({ sessionKey: "session" }).where(eq(q.t.workItem.id, "item")),
    );
    const mode = options.mode === undefined ? "code" : options.mode;
    if (mode) yield* q.exec(q.orm.insert(q.t.workItemTask).values({ itemId: "item", mode }));
    yield* ensureLinearSessionSteps(q, {
      ...{ sessionId: "session", organizationId: "org", appUserId: "app" },
      ...{ issueId: "issue-item", now: 0 },
    });
    const creatorId = options.creator === undefined ? "linear-ann" : options.creator;
    yield* q.exec(
      q.orm
        .update(q.t.linearSession)
        .set({ creatorId })
        .where(eq(q.t.linearSession.sessionId, "session")),
    );
    yield* putWorkspaceUserSteps(q, {
      id: "ann",
      linearUserId: "linear-ann",
      name: "Ann",
      email: "a@x",
    });
    yield* syncWorkspaceMemberSteps(q, {
      ...{ workspaceId: "ws", userId: "ann", role: "member", active: true },
      ...{ teamIds: ["eng"], now: 1 },
    });
    yield* requireLinearTaskDelegationSteps(q, {
      ...{ itemId: "item", issueId: "issue-item", teamId: "pas", appUserId: "app" },
    });
  });
  const tracker = createFakeTracker();
  tracker.agentTeams.push({ id: "pas", key: "PAS", name: "Pascal", private: false });
  tracker.agentIssues.push(
    issue("issue-item", "PAS-1", "pas") as AgentIssue & { teamIds: string[] },
    issue("eng-1", "ENG-1", "eng") as AgentIssue & { teamIds: string[] },
    issue("ops-1", "OPS-1", "ops") as AgentIssue & { teamIds: string[] },
    issue("pas-2", "PAS-2", "pas") as AgentIssue & { teamIds: string[] },
  );
  const run = await db.run((q) => insertRunSteps(q, { itemId: "item", now: 0 }));
  const item = (await db.run((q) => getWorkItemSteps(q, "item")))!;
  const tools = (runId = run.id, filed = new Map<string, number>()) =>
    linearToolsFor({ store: db, tracker, item, runId, filed });
  return { tracker, tools };
}

test("a code-mode item gets the tools; answer, plan and an unresolved delegator get none", async () => {
  expect((await (await setup()).tools())?.definitions.map((tool) => tool.name)).toContain(
    "create_issue",
  );
  expect(await (await setup({ mode: null })).tools()).toBeDefined();
  expect(await (await setup({ mode: "answer" })).tools()).toBeUndefined();
  expect(await (await setup({ mode: "plan" })).tools()).toBeUndefined();
  expect(await (await setup({ creator: null })).tools()).toBeUndefined();
  expect(await (await setup({ creator: "linear-stranger" })).tools()).toBeUndefined();
});

test("search_issues returns only issues of the delegating person's teams", async () => {
  const tools = (await (await setup()).tools())!;
  const found = await tools.call("search_issues", { query: "-1" });
  expect(JSON.parse(found.text).map((row: { identifier: string }) => row.identifier)).toEqual([
    "ENG-1",
  ]);
  expect((await tools.call("get_issue", { id: "OPS-1" })).text).toBe(
    "No issue OPS-1 in your teams.",
  );
});

test("create_issue files in the item's team with a relation, three per run, once after a restart", async () => {
  const { tracker, tools } = await setup();
  const first = (await tools())!;
  const created = await first.call("create_issue", { title: "Follow-up", description: "Do it." });
  const filed = tracker.agentIssues.at(-1)!;
  expect(JSON.parse(created.text).identifier).toBe(filed.identifier);
  expect(filed.teamIds).toEqual(["pas"]);
  expect(filed.relations).toEqual([
    { type: "related", identifier: "issue-item", direction: "outgoing" },
  ]);
  expect(filed.description).toBe("Do it.\n\nFiled from item.");
  expect(filed.delegate).toBeNull();
  await first.call("create_issue", { title: "Second", description: "", start: true });
  expect(tracker.agentIssues.at(-1)!.delegate).toBe("Paws");
  await first.call("create_issue", { title: "Third", description: "" });
  const fourth = await first.call("create_issue", { title: "Fourth", description: "" });
  expect(fourth).toEqual({ text: "You can file at most 3 issues in one run.", isError: true });
  const count = tracker.agentIssues.length;
  const restarted = (await tools())!;
  await restarted.call("create_issue", { title: "Follow-up", description: "Do it." });
  expect(tracker.agentIssues.length).toBe(count);
});

test("update_issue applies to the item's own issue and one it filed, not to another", async () => {
  const { tracker, tools } = await setup();
  const set = (await tools())!;
  expect(await set.call("update_issue", { id: "PAS-2", title: "No" })).toEqual({
    text: NOT_YOURS,
    isError: true,
  });
  expect(await set.call("assign_issue", { id: "PAS-2" })).toEqual({
    text: NOT_YOURS,
    isError: true,
  });
  expect((await set.call("update_issue", { id: "PAS-1", title: "Own" })).isError).toBeUndefined();
  const created = JSON.parse(
    (await set.call("create_issue", { title: "New", description: "" })).text,
  );
  const later = (await tools("run-2"))!;
  expect(
    (await later.call("update_issue", { id: created.identifier, title: "Renamed" })).isError,
  ).toBeUndefined();
  expect(tracker.agentIssues.find((entry) => entry.id === "issue-item")!.title).toBe("Own");
  expect(tracker.agentIssues.find((entry) => entry.id === created.id)!.title).toBe("Renamed");
  expect(tracker.agentIssues.find((entry) => entry.id === "pas-2")!.title).toBe("PAS-2");
});
