import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  advanceLinearSessionGeneration,
  bindLinearSessionTask,
  getLinearSessionContext,
  openPawsStore,
  recordLinearInstallation,
} from "../src/db";
import { createFakeTracker } from "../src/linear";
import { refreshLinearNotificationContext } from "../src/loop";
import { intakeDelegatedIssue } from "../src/intake";
import { tempHome, migratedHome } from "./helpers";
import { copyMigratedPglite } from "./pglite";

const scope = { organizationId: "org", oauthClientId: "client", appUserId: "app" };

test("child notifications refresh only their installation sessions and retain context after restart", async () => {
  const pgliteDir = join(tempHome(), "pglite");
  await copyMigratedPglite(pgliteDir);
  const open = await openPawsStore({ url: null, pgliteDir });
  const db = open.store;
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
  await recordLinearInstallation(db, {
    ...scope,
    sessionId: "session",
    teamId: "team",
    observedAtMs: 1,
  });
  await bindLinearSessionTask(db, "session", task.delegation.id);
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
  await refreshLinearNotificationContext(db, tracker, {
    ...notification,
    organizationId: "other",
  });
  expect(await getLinearSessionContext(db, "session")).toBe("");
  await refreshLinearNotificationContext(db, tracker, notification);
  expect(await getLinearSessionContext(db, "session")).toContain("Child clarification");
  expect(await getLinearSessionContext(db, "session")).toContain("thumbsup");
  tracker.issueContexts.set("child", {
    id: "child",
    teamId: "team",
    issue: {},
    comments: [{ body: "Stale event" }],
  });
  await refreshLinearNotificationContext(db, tracker, {
    ...notification,
    createdAtMs: 9,
  });
  expect(await getLinearSessionContext(db, "session")).not.toContain("Stale event");
  const original = await getLinearSessionContext(db, "session");
  const pending = Promise.withResolvers<ReturnType<typeof tracker.issueContexts.get>>();
  const reading = Promise.withResolvers<void>();
  tracker.getIssueContext = async () => {
    reading.resolve();
    return (await pending.promise)!;
  };
  const refresh = refreshLinearNotificationContext(db, tracker, {
    ...notification,
    createdAtMs: 11,
  });
  await reading.promise;
  await advanceLinearSessionGeneration(db, "session");
  pending.resolve({
    id: "child",
    teamId: "team",
    issue: {},
    comments: [{ body: "Obsolete generation" }],
  });
  await refresh;
  expect(await getLinearSessionContext(db, "session")).toBe(original);
  await open.close();
  const reopened = await openPawsStore({ url: null, pgliteDir });
  expect(await getLinearSessionContext(reopened.store, "session")).toBe(original);
  await reopened.close();
});

test.each(["context", "github-auth"])(
  "signed %s notification ingress retries failed context reads before deduplicating",
  async (mode) => {
    const proc = Bun.spawn(
      [
        process.execPath,
        "test/fixtures/linear-notification-ingress.ts",
        await migratedHome(),
        mode,
      ],
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
