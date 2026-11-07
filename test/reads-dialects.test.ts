import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  deliveredLinearIssueStateSteps,
  listOpenQuestionsSteps,
  listWorkItemBlocksSteps,
  listWorkItemFactsSteps,
  openQuestionKindSteps,
  type Q,
} from "../src/db";
import { forEachDialect, insertWorkItem, json, seed, type DialectDb } from "./dialects";

const open: DialectDb[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
});

forEachDialect((connect) => {
  test("a block edge reads from the newest live item of the blocked issue", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await insertWorkItem(db, "A", 1);
    await insertWorkItem(db, "B", 2);
    await insertWorkItem(db, "C", 3);
    await seed(
      db,
      (q) => q.orm.update(q.t.workItem).set({ state: "merged" }).where(eq(q.t.workItem.id, "B")),
      (q) =>
        q.orm
          .update(q.t.workItem)
          .set({ linearIssueId: "issue-B", delegationId: "late" })
          .where(eq(q.t.workItem.id, "C")),
      (q) =>
        q.orm.insert(q.t.taskBlock).values([
          { blockerLinearIssueId: "issue-A", blockedLinearIssueId: "issue-B" },
          { blockerLinearIssueId: "issue-B", blockedLinearIssueId: "issue-A" },
        ]),
    );
    expect(await db.run((q) => listWorkItemBlocksSteps(q))).toEqual([
      {
        delegationId: "delegation-A",
        blockerLinearIssueId: "issue-B",
        blockedLinearIssueId: "issue-A",
      },
      { delegationId: "late", blockerLinearIssueId: "issue-A", blockedLinearIssueId: "issue-B" },
    ]);
    // A cancelled or withdrawn item no longer carries its issue's edges.
    await seed(
      db,
      (q) => q.orm.update(q.t.workItem).set({ state: "cancelled" }).where(eq(q.t.workItem.id, "C")),
      (q) =>
        q.orm
          .insert(q.t.workItemSpecification)
          .values({ itemId: "A", hash: "h", revision: 1, present: 0 }),
    );
    expect(await db.run((q) => listWorkItemBlocksSteps(q, "delegation-B"))).toEqual([
      {
        delegationId: "delegation-B",
        blockerLinearIssueId: "issue-A",
        blockedLinearIssueId: "issue-B",
      },
    ]);
    expect(await db.run((q) => listWorkItemBlocksSteps(q, "delegation-A"))).toEqual([]);
  });

  test("facts name the owner and project, newest item first", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await insertWorkItem(db, "A", 1);
    await insertWorkItem(db, "B", 2);
    await seed(
      db,
      (q) =>
        q.orm
          .insert(q.t.workspaceUser)
          .values({ id: "u", linearUserId: "lu", name: "Ada", email: "a@x" }),
      (q) =>
        q.orm
          .update(q.t.workItem)
          .set({ ownerUserId: "u", linearProjectId: "p", linearProjectName: "Paws" })
          .where(eq(q.t.workItem.id, "A")),
    );
    expect(await db.run(listWorkItemFactsSteps)).toEqual([
      { itemId: "B", owner: null, projectId: null, projectName: null, createdAt: 2 },
      { itemId: "A", owner: "Ada", projectId: "p", projectName: "Paws", createdAt: 1 },
    ]);
  });

  test("open questions list their option labels and kind, oldest first", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await insertWorkItem(db, "A");
    const question = (id: string, createdAt: number, extra: object) => (q: Q) =>
      q.orm.insert(q.t.question).values({
        id,
        itemId: "A",
        sessionId: `s-${id}`,
        body: id,
        status: "open",
        createdAt,
        ...extra,
      });
    await seed(
      db,
      question("q2", 2, { options: json(db, ["Yes", { label: "No" }, { value: "Later" }, 3]) }),
      question("q1", 1, { kind: "approval" }),
      question("q3", 3, { cancelledAt: 4 }),
      question("q4", 4, { status: "answered" }),
    );
    expect(await db.run(listOpenQuestionsSteps)).toEqual([
      {
        id: "q1",
        itemId: "A",
        runId: null,
        sessionId: "s-q1",
        body: "q1",
        options: [],
        createdAt: 1,
      },
      {
        id: "q2",
        itemId: "A",
        runId: null,
        sessionId: "s-q2",
        body: "q2",
        options: ["Yes", "No", "Later"],
        createdAt: 2,
      },
    ]);
    expect(await db.run((q) => openQuestionKindSteps(q, "q1"))).toBe("approval");
    expect(await db.run((q) => openQuestionKindSteps(q, "q3"))).toBeNull();
  });

  test("the delivered issue state is the latest Issue event of the organization", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    const event = (key: string, updatedAtMs: number, payload: object) => (q: Q) =>
      q.orm.insert(q.t.inboxEvent).values({
        dedupeKey: key,
        source: "webhook",
        action: "other",
        updatedAtMs,
        receivedAt: updatedAtMs,
        payload: json(db, payload),
      });
    const issue = (state: string, organizationId = "org") => ({
      type: "Issue",
      organizationId,
      data: { id: "i1", identifier: "ENG-1", state: { type: state } },
    });
    await seed(
      db,
      event("a", 1, issue("started")),
      event("b", 2, issue("completed")),
      event("c", 3, issue("canceled", "other")),
      event("d", 4, { type: "Comment", organizationId: "org", data: { id: "i1" } }),
    );
    expect(await db.run((q) => deliveredLinearIssueStateSteps(q, "org", "i1"))).toEqual({
      stateType: "completed",
      identifier: "ENG-1",
    });
    expect(await db.run((q) => deliveredLinearIssueStateSteps(q, "org", "i2"))).toBeNull();
  });
});
