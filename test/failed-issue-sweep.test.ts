import { afterEach, expect, test } from "bun:test";
import {
  applyWorkItemEvent,
  bindLinearSessionTask,
  getWorkItem,
  listOutbox,
  recordLinearInstallation,
  setJournalSink,
} from "../src/db";
import { intakeDelegatedIssue } from "../src/intake";
import { createFakeTracker } from "../src/linear";
import { ISSUE_CLOSED_RESPONSE, sweepFailedIssues } from "../src/loop";
import { tempStore } from "./pglite";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const { db, close } = await tempStore();
  cleanup.push(close);
  const tracker = createFakeTracker([
    {
      linearIssueId: "issue",
      identifier: "ENG-1",
      title: "Task",
      description: null,
      subIssues: [],
    },
  ]);
  const task = await intakeDelegatedIssue(db, tracker, { linearIssueId: "issue" });
  if (!task.ok) throw new Error("Unexpected issue cycle");
  await recordLinearInstallation(db, {
    organizationId: "org",
    oauthClientId: "client",
    appUserId: "app",
    sessionId: "session",
    teamId: "team",
    observedAtMs: 1,
  });
  await bindLinearSessionTask(db, "session", task.delegation.id, { actorId: "human" });
  const item = task.items[0]!;
  await applyWorkItemEvent(db, item.id, "start_timed_out");
  expect((await getWorkItem(db, item.id))?.state).toBe("failed");
  const journal: string[] = [];
  cleanup.push(setJournalSink((line) => journal.push(line)));
  const notified: string[] = [];
  const sweep = () =>
    sweepFailedIssues(db, {
      readIssueClosures: tracker.readIssueClosures,
      notify: (command) => notified.push(command.itemId),
    });
  const responses = async () =>
    (await listOutbox(db))
      .filter((row) => (row.payload as { kind?: string }).kind === "response")
      .map((row) => (row.payload as { body: string }).body);
  return { db, tracker, item, journal, notified, sweep, responses };
}

const closure = (stateType: "completed" | "canceled") => ({
  issueId: "issue",
  organizationId: null,
  identifier: "ENG-1",
  stateType,
  closedAtMs: Date.now() + 1_000,
});

test("a failed item whose issue is Done is cancelled once, and a second round does nothing", async () => {
  const f = await fixture();
  f.tracker.issueClosures.set("issue", closure("completed"));
  expect(await f.sweep()).toEqual([{ itemId: f.item.id, outcome: "cancelled" }]);
  expect((await getWorkItem(f.db, f.item.id))?.state).toBe("cancelled");
  expect(f.notified).toEqual([f.item.id]);
  expect(await f.responses()).toEqual([ISSUE_CLOSED_RESPONSE.completed]);

  expect(await f.sweep()).toEqual([]);
  expect(f.tracker.issueClosureReads).toEqual([["issue"]]);
  expect(await f.responses()).toEqual([ISSUE_CLOSED_RESPONSE.completed]);
});

test("a failed item whose open issue is archived is cancelled", async () => {
  const f = await fixture();
  f.tracker.issueClosures.set("issue", closure("canceled"));
  expect(await f.sweep()).toEqual([{ itemId: f.item.id, outcome: "cancelled" }]);
  expect((await getWorkItem(f.db, f.item.id))?.state).toBe("cancelled");
});

test("a failed item whose issue is still open stays failed", async () => {
  const f = await fixture();
  expect(await f.sweep()).toEqual([]);
  expect(f.tracker.issueClosureReads).toEqual([["issue"]]);
  expect((await getWorkItem(f.db, f.item.id))?.state).toBe("failed");
});

test("a failed Linear read cancels nothing and logs once", async () => {
  const f = await fixture();
  f.tracker.issueClosures.set("issue", closure("completed"));
  f.tracker.issueClosureFailures.push(new Error("Linear is down"));
  expect(await f.sweep()).toEqual([]);
  expect((await getWorkItem(f.db, f.item.id))?.state).toBe("failed");
  expect(f.notified).toEqual([]);
  expect(f.journal.filter((line) => line.includes("Linear is down"))).toHaveLength(1);
});
