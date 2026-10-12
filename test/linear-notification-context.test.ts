import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  advanceLinearSessionGeneration,
  bindLinearSessionTask,
  getLinearSessionContext,
  migrate,
  openDatabase,
  recordLinearInstallation,
} from "../src/db";
import { createFakeTracker } from "../src/linear";
import { refreshLinearNotificationContext } from "../src/loop";
import { intakeDelegatedIssue } from "../src/intake";
import { tempHome } from "./helpers";

const scope = { organizationId: "org", oauthClientId: "client", appUserId: "app" };

test("child notifications refresh only their installation sessions and retain context after restart", async () => {
  const path = join(tempHome(), "paws.db");
  const db = openDatabase(path);
  migrate(db);
  const tracker = createFakeTracker([
    {
      linearIssueId: "parent",
      identifier: "ENG-1",
      title: "Parent",
      description: null,
      subIssues: [{ linearIssueId: "child", identifier: "ENG-2", title: "Child" }],
    },
  ]);
  const task = await intakeDelegatedIssue(db, tracker, { linearIssueId: "parent" });
  if (!task.ok) throw new Error("Unexpected intake cycle");
  recordLinearInstallation(db, { ...scope, sessionId: "session", teamId: "team", observedAtMs: 1 });
  bindLinearSessionTask(db, "session", task.epic.id);
  tracker.issueContexts.set("child", {
    id: "child",
    teamId: "team",
    issue: { state: { type: "started" }, reactions: [{ emoji: "thumbsup" }] },
    comments: [{ id: "comment", body: "Child clarification" }],
  });
  const notification = {
    ...scope,
    kind: "notification" as const,
    issueId: "child",
    teamId: "team",
    action: "issueNewComment",
    actorId: "human",
    notificationId: "notice",
    createdAtMs: 10,
  };
  await refreshLinearNotificationContext(db, tracker, { ...notification, organizationId: "other" });
  expect(getLinearSessionContext(db, "session")).toBe("");
  await refreshLinearNotificationContext(db, tracker, notification);
  expect(getLinearSessionContext(db, "session")).toContain("Child clarification");
  expect(getLinearSessionContext(db, "session")).toContain("thumbsup");
  tracker.issueContexts.set("child", {
    id: "child",
    teamId: "team",
    issue: {},
    comments: [{ body: "Stale event" }],
  });
  await refreshLinearNotificationContext(db, tracker, { ...notification, createdAtMs: 9 });
  expect(getLinearSessionContext(db, "session")).not.toContain("Stale event");
  const original = getLinearSessionContext(db, "session");
  const pending = Promise.withResolvers<ReturnType<typeof tracker.issueContexts.get>>();
  tracker.getIssueContext = async () => (await pending.promise)!;
  const refresh = refreshLinearNotificationContext(db, tracker, {
    ...notification,
    createdAtMs: 11,
  });
  advanceLinearSessionGeneration(db, "session");
  pending.resolve({
    id: "child",
    teamId: "team",
    issue: {},
    comments: [{ body: "Obsolete generation" }],
  });
  await refresh;
  expect(getLinearSessionContext(db, "session")).toBe(original);
  db.close();
  const reopened = openDatabase(path);
  expect(getLinearSessionContext(reopened, "session")).toBe(original);
  reopened.close();
});

test.each(["context", "github-auth"])(
  "signed %s notification ingress retries failed context reads before deduplicating",
  async (mode) => {
    const proc = Bun.spawn(
      [process.execPath, "test/fixtures/linear-notification-ingress.ts", tempHome(), mode],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [output, errors, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code).toBe(0);
    expect(errors).not.toContain("Unexpected offline request");
    const result = JSON.parse(output.trim().split("\n").at(-1)!);
    if (mode === "github-auth") expect(result.githubReads).toBe(0);
    expect(result.pending).toBe(0);
    expect(result.contextReads).toBe(3);
    expect(result.workflowMutations).toBe(0);
    expect(result.state).toBe("awaiting_input");
    expect(result.context).toContain("Original comment");
    expect(result.context).toContain("Latest user detail");
    expect(result.context).toContain("thumbsup");
    expect(result.context).toContain("eyes");
    expect(result.restoredContext).toBe(result.context);
  },
  10_000,
);
