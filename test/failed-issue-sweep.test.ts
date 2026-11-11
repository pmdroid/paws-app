import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import {
  applyWorkItemEvent,
  bindLinearSessionTask,
  getWorkItem,
  listOutbox,
  migrate,
  openDatabase,
  recordLinearInstallation,
  setJournalSink,
  sqliteDb,
} from "../src/db";
import { intakeDelegatedIssue } from "../src/intake";
import { createFakeTracker } from "../src/linear";
import { ISSUE_CLOSED_RESPONSE, sweepFailedIssues } from "../src/loop";
import { tempHome } from "./helpers";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});

async function fixture() {
  const db = openDatabase(join(tempHome(), "paws.db"));
  migrate(db);
  cleanup.push(() => db.close());
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
  await recordLinearInstallation(sqliteDb(db), {
    organizationId: "org",
    oauthClientId: "client",
    appUserId: "app",
    sessionId: "session",
    teamId: "team",
    observedAtMs: 1,
  });
  await bindLinearSessionTask(sqliteDb(db), "session", task.delegation.id, { actorId: "human" });
  const item = task.items[0]!;
  applyWorkItemEvent(db, item.id, "start_timed_out");
  expect(getWorkItem(db, item.id)?.state).toBe("failed");
  const journal: string[] = [];
  cleanup.push(setJournalSink((line) => journal.push(line)));
  const notified: string[] = [];
  const sweep = () =>
    sweepFailedIssues(db, {
      readIssueClosures: tracker.readIssueClosures,
      notify: (command) => notified.push(command.itemId),
    });
  const responses = () =>
    listOutbox(db)
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
  expect(getWorkItem(f.db, f.item.id)?.state).toBe("cancelled");
  expect(f.notified).toEqual([f.item.id]);
  expect(f.responses()).toEqual([ISSUE_CLOSED_RESPONSE.completed]);

  expect(await f.sweep()).toEqual([]);
  expect(f.tracker.issueClosureReads).toEqual([["issue"]]);
  expect(f.responses()).toEqual([ISSUE_CLOSED_RESPONSE.completed]);
});

test("a failed item whose open issue is archived is cancelled", async () => {
  const f = await fixture();
  f.tracker.issueClosures.set("issue", closure("canceled"));
  expect(await f.sweep()).toEqual([{ itemId: f.item.id, outcome: "cancelled" }]);
  expect(getWorkItem(f.db, f.item.id)?.state).toBe("cancelled");
});

test("a failed item whose issue is still open stays failed", async () => {
  const f = await fixture();
  expect(await f.sweep()).toEqual([]);
  expect(f.tracker.issueClosureReads).toEqual([["issue"]]);
  expect(getWorkItem(f.db, f.item.id)?.state).toBe("failed");
});

test("a failed Linear read cancels nothing and logs once", async () => {
  const f = await fixture();
  f.tracker.issueClosures.set("issue", closure("completed"));
  f.tracker.issueClosureFailures.push(new Error("Linear is down"));
  expect(await f.sweep()).toEqual([]);
  expect(getWorkItem(f.db, f.item.id)?.state).toBe("failed");
  expect(f.notified).toEqual([]);
  expect(f.journal.filter((line) => line.includes("Linear is down"))).toHaveLength(1);
});
