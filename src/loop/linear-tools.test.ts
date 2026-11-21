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
import { validHostToolDefinitions } from "../../test/host-tool-definitions";
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

const described = (
  definitions: readonly { name: string; description: string; inputSchema: unknown }[],
) =>
  Object.fromEntries(
    definitions.map((tool) => {
      const { properties } = tool.inputSchema as {
        properties: Record<string, { description?: string }>;
      };
      const params = Object.entries(properties).map(([key, value]) => [key, value.description]);
      return [tool.name, [tool.description, Object.fromEntries(params)]];
    }),
  );

test("each tool and every parameter is described, within the host tool limits", async () => {
  const definitions = (await (await setup()).tools())!.definitions;
  expect(validHostToolDefinitions(definitions)).toBe(true);
  const id = "The issue's identifier, such as ENG-123, or its Linear id.";
  const filed =
    "The current issue or one you filed for this item: its identifier, such as ENG-123, or its Linear id.";
  expect(described(definitions)).toEqual({
    search_issues: [
      "Search Linear issues by text or issue identifier within the delegating person's teams.",
      {
        query: "Search text or a Linear issue identifier, such as ENG-123.",
        limit: "Maximum number of results: 10 by default, at most 25.",
      },
    ],
    get_issue: ["Read a Linear issue, including its relations and recent comments.", { id }],
    list_teams: ["List the Linear teams the delegating person belongs to.", {}],
    list_projects: ["List the projects of the delegating person's Linear teams.", {}],
    list_labels: ["List the labels of the delegating person's Linear teams.", {}],
    list_states: ["List the workflow states of the delegating person's Linear teams.", {}],
    create_issue: [
      "Immediately create a follow-up Linear issue in the current issue's team and relate it to the current issue. At most 3 per run. Set start to true to delegate the new issue to Paws.",
      {
        title: "A concise title naming the problem or requested outcome, at most 256 characters.",
        description:
          "A self-contained Markdown brief: problem and evidence, decided change, relevant files and constraints, and acceptance checks.",
        labels: "Existing label names to apply, not label IDs; at most 10.",
        start: "Set true to delegate the new issue to Paws; false creates it without delegation.",
      },
    ],
    update_issue: [
      "Immediately update the current Linear issue or an issue you filed for this item. Supply only the fields you intend to change.",
      {
        id: filed,
        title: "The new issue title.",
        description: "The new issue description in Markdown.",
        state: "The target workflow state name, not its ID.",
        labels: "Label names, not IDs. They replace the issue's whole label set.",
      },
    ],
    assign_issue: [
      "Immediately delegate the current Linear issue or an issue you filed for this item to Paws.",
      { id: filed },
    ],
  });
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
