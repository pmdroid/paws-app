import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  completeMergedItem,
  ensureLinearSessionSteps,
  getWorkItemSteps,
  insertRunSteps,
  listOutboxSteps,
  putWorkspaceUserSteps,
  recordConfirmedRemoteMerge,
  recordSplitFiledSteps,
  requireLinearTaskDelegationSteps,
  syncWorkspaceMemberSteps,
  unfiledAutoSplitSteps,
  type Db,
} from "../db";
import { createFakeTracker } from "../linear";
import { getQuestionSteps } from "../questions";
import {
  answerSplitSteps,
  fileAutoSplitSteps,
  splitApprove,
  splitLimit,
  splitToolsFor,
} from "./issue-split";
import { insertWorkItemSteps, withoutForeignKeys } from "../../test/pglite-fixtures";
import { tempStore } from "../../test/pglite";

const stores: { close(): Promise<void> }[] = [];
afterAll(() => Promise.all(stores.map((store) => store.close())));

const part = (title: string) => ({
  title,
  problem: "Too big",
  evidence: "900 lines",
  change: "Half of it",
  acceptance: ["Tests pass"],
  leaveAlone: "The rest",
});

async function workspace(splits?: Record<string, unknown>) {
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
    yield* putWorkspaceUserSteps(q, { id: "ann", linearUserId: "ann", name: "Ann", email: "a@x" });
    yield* syncWorkspaceMemberSteps(q, {
      ...{ workspaceId: "ws", userId: "ann", role: "member", active: true },
      ...{ teamIds: ["pas"], now: 1 },
    });
    if (splits)
      yield* q.exec(
        q.orm
          .insert(q.t.setting)
          .values({ key: "settings.splits", value: JSON.stringify(splits), updatedAt: 0 }),
      );
  });
  const tracker = createFakeTracker();
  const item = async (id: string) => {
    await db.run(function* (q) {
      yield* insertWorkItemSteps(q, id);
      yield* ensureLinearSessionSteps(q, {
        ...{ sessionId: `session-${id}`, organizationId: "org", appUserId: "app" },
        ...{ issueId: `issue-${id}`, creatorId: "ann", now: 0 },
      });
      yield* requireLinearTaskDelegationSteps(q, {
        ...{ itemId: id, issueId: `issue-${id}`, teamId: "pas", appUserId: "app" },
        humanActorId: "ann",
      });
    });
    const run = await db.run((q) => insertRunSteps(q, { itemId: id, now: 0 }));
    await db.run((q) =>
      q.exec(
        q.orm
          .update(q.t.workItem)
          .set({ state: "running", currentRunId: run.id, sessionKey: `session-${id}` })
          .where(eq(q.t.workItem.id, id)),
      ),
    );
    tracker.epics.set(`issue-${id}`, {
      ...{ linearIssueId: `issue-${id}`, identifier: id, title: id, description: "" },
      subIssues: [],
    });
    const record = (await db.run((q) => getWorkItemSteps(q, id)))!;
    const asked: string[] = [];
    const tools = await splitToolsFor({
      ...{ store: db, tracker, item: record, runId: run.id, repository: "acme/app" },
      now: () => 10,
      onProposed: (runId) => asked.push(runId),
    });
    const propose = (titles: string[]) =>
      tools!.call("propose_split", { sameFiles: true, subIssues: titles.map(part) });
    return { record, run, tools, asked, propose };
  };
  return { db, tracker, item };
}

const splitOf = (db: Db, itemId: string) =>
  db.run((q) =>
    q.all(q.orm.select().from(q.t.issueSplit).where(eq(q.t.issueSplit.itemId, itemId))),
  );

test("a proposal with more sub-issues than the maximum is refused", async () => {
  const { item } = await workspace();
  const a = await item("a");
  const refused = await a.propose(["One", "Two", "Three"]);
  expect(refused).toEqual({
    text: "A split names at most 2 sub-issues; this one names 3.",
    isError: true,
  });
  expect(a.asked).toEqual([]);
});

test("the first two splits ask, and the third is filed and delegated without asking", async () => {
  const { db, item } = await workspace();
  for (const id of ["a", "b"]) {
    const it = await item(id);
    expect((await it.propose(["One", "Two"])).isError).toBeUndefined();
    expect(it.asked).toEqual([it.run.id]);
    const current = (await db.run((q) => getWorkItemSteps(q, id)))!;
    expect(current.state).toBe("awaiting_input");
    const [split] = await splitOf(db, id);
    expect(split!.status).toBe("asked");
    const question = (await db.run((q) => getQuestionSteps(q, split!.questionId!)))!;
    expect(question.kind).toBe("split");
    expect(question.options).toEqual([splitApprove(2), "Keep as one issue"]);
    await db.transaction((q) =>
      answerSplitSteps(q, { ...question, answer: splitApprove(2), answeredBy: "ann" }, 20),
    );
    expect((await db.run((q) => getWorkItemSteps(q, id)))!.state).toBe("completed");
  }
  const c = await item("c");
  expect((await c.propose(["One", "Two"])).text).toContain("files and delegates");
  const auto = (await db.run((q) => unfiledAutoSplitSteps(q, "c")))!;
  expect(auto.questionId).toBeNull();
  expect(auto.drafts.map((draft) => draft.blockedBy)).toEqual([[], [0]]);
  expect(await db.transaction((q) => fileAutoSplitSteps(q, "c", 30))).toBe(true);
  expect((await db.run((q) => getWorkItemSteps(q, "c")))!.state).toBe("completed");
  const filing = (await db.run((q) => listOutboxSteps(q, "session-c"))).filter(
    (row) => row.op === "linear.split",
  );
  expect(filing.map((row) => row.payload)).toEqual([
    { splitId: auto.id, itemId: "c", sessionId: "session-c" },
  ]);
});

test("a rejected or edited proposal does not count toward the ramp", async () => {
  const { db, item } = await workspace({ approvals_before_auto: 1 });
  for (const [id, answer] of [
    ["a", "Keep as one issue"],
    ["b", "Make the first one smaller"],
  ] as const) {
    const it = await item(id);
    await it.propose(["One"]);
    const [split] = await splitOf(db, id);
    const question = (await db.run((q) => getQuestionSteps(q, split!.questionId!)))!;
    await db.transaction((q) => answerSplitSteps(q, { ...question, answer }, 20));
    expect((await db.run((q) => getWorkItemSteps(q, id)))!.state).toBe("queued");
  }
  const c = await item("c");
  await c.propose(["One"]);
  expect((await splitOf(db, "c"))[0]!.status).toBe("asked");
});

test("a sub-issue cannot split, and its rounds question offers no Split", async () => {
  const { tracker, item, db } = await workspace();
  tracker.epics.set("issue-parent", {
    ...{ linearIssueId: "issue-parent", identifier: "parent", title: "p", description: "" },
    subIssues: [],
  });
  const a = await item("a");
  tracker.briefParents.set("issue-a", "issue-parent");
  expect(await a.propose(["One"])).toEqual({
    text: "This issue is a sub-issue, and a sub-issue cannot be split.",
    isError: true,
  });
  expect(await splitLimit(db, tracker, a.record)).toBe(0);
});

test("disabled means no split is offered", async () => {
  const { db, tracker, item } = await workspace({ enabled: false });
  const a = await item("a");
  expect(a.tools).toBeUndefined();
  expect(await splitLimit(db, tracker, a.record)).toBe(0);
});

test("the parent is Done with links once every sub-issue merged", async () => {
  const { db, item } = await workspace({ approvals_before_auto: 0 });
  const parent = await item("parent");
  await parent.propose(["One", "Two"]);
  const split = (await db.run((q) => unfiledAutoSplitSteps(q, "parent")))!;
  await db.transaction((q) => fileAutoSplitSteps(q, "parent", 30));
  await db.transaction((q) =>
    recordSplitFiledSteps(
      q,
      split.id,
      [
        { id: "issue-one", identifier: "one", url: "https://linear.app/x/one" },
        { id: "issue-two", identifier: "two", url: null },
      ],
      40,
    ),
  );
  for (const [n, id] of ["one", "two"].entries()) {
    await item(id);
    await db.run((q) =>
      q.exec(
        q.orm.update(q.t.workItem).set({ state: "merge_queue" }).where(eq(q.t.workItem.id, id)),
      ),
    );
    await recordConfirmedRemoteMerge(db, {
      ...{ itemId: id, repositoryOwner: "acme", repositoryName: "app", pullNumber: n + 1 },
      ...{ pullUrl: null, mergeSha: "abc", confirmedAt: 50 },
    });
    const statuses = () =>
      db
        .run((q) => listOutboxSteps(q, "session-parent"))
        .then((rows) => rows.filter((row) => row.op === "status").map((row) => row.payload));
    expect(await statuses()).toEqual([]);
    await completeMergedItem(db, { itemId: id, now: 60 });
    if (n === 1)
      expect(await statuses()).toEqual([
        { itemId: "parent", linearIssueId: "issue-parent", stateType: "completed" },
      ]);
  }
  const done = (await db.run((q) => listOutboxSteps(q, "session-parent"))).find((row) =>
    row.idempotencyKey.startsWith("merged:split:"),
  );
  expect((done!.payload as { body: string }).body).toContain(
    "[one](<https://linear.app/x/one>), two",
  );
});
