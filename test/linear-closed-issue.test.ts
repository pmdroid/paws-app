import { expect, test } from "bun:test";
import { join } from "node:path";
import { systemClock } from "../src/core";
import { JobLoop, OutboxDispatcher } from "../src/db";
import {
  acknowledgeNewSession,
  createFakeLinearAccessReads,
  createFakeLinearIssueLifecycle,
  createFakeTracker,
} from "../src/linear";
import { attachOrchestrator, LinearTaskAccess } from "../src/loop";
import { tempDb, tempHome } from "./helpers";

test.each([
  ["prompted", "completed"],
  ["created", "canceled"],
] as const)("a %s event on a %s issue is refused once in Linear", async (action, stateType) => {
  const db = tempDb();
  const home = tempHome();
  const scope = { organizationId: "org", oauthClientId: "client", appUserId: "app" };
  const tracker = createFakeTracker([
    {
      linearIssueId: "issue",
      identifier: "PAS-372",
      title: "Set a runner's concurrency from its runner page",
      description: null,
      subIssues: [],
    },
  ]);
  const lifecycle = createFakeLinearIssueLifecycle({
    id: "issue",
    identifier: "PAS-372",
    teamId: "team",
    assigneeId: null,
    delegateId: "app",
    stateType,
  });
  const access = createFakeLinearAccessReads({
    installation: scope,
    sessions: [{ ...scope, sessionId: "session", issueId: "issue", teamId: "team" }],
    teams: ["team"],
  });
  const gate = new LinearTaskAccess(db, {
    access: access.adapter,
    lifecycle,
    oauthClientId: "client",
    appUserId: "app",
    stopSession: () => {},
  });
  let launches = 0;
  const orchestrator = attachOrchestrator({
    db,
    jobs: new JobLoop(db, systemClock),
    outbox: new OutboxDispatcher(db, systemClock),
    pawsRoot: join(home, "paws"),
    home,
    tracker,
    linearTaskModes: true,
    linearAccess: gate,
    launch: () => {
      launches++;
      throw new Error("A closed issue must not launch an agent");
    },
  });
  const event = {
    dedupeKey: `activity:${action}`,
    deliveryId: null,
    source: "poll" as const,
    action,
    sessionId: "session",
    issueId: "issue",
    activityId: action === "prompted" ? "reply" : null,
    body: action === "prompted" ? "hey" : null,
    signal: null,
    updatedAtMs: 1,
    payload: "{}",
  };
  try {
    expect(
      await acknowledgeNewSession(tracker, event, (accepted) =>
        orchestrator.onLinearEvent(accepted),
      ),
    ).toBe(false);
    expect(
      tracker.progress.filter((update) => update.kind === "error").map((update) => update.body),
    ).toEqual(["PAS-372 is closed, so Paws won't start work on it. Reopen the issue to continue."]);
    expect(launches).toBe(0);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM work_item").get()?.n).toBe(0);
  } finally {
    await orchestrator.shutdown();
  }
});
