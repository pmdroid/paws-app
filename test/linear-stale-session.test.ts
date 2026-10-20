import { expect, test } from "bun:test";
import { join } from "node:path";
import { systemClock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  advanceLinearSessionGeneration,
  applyWorkItemEvent,
  beginImplementRun,
  getLinearSession,
  getWorkItem,
  migrate,
  openDatabase,
  recordLinearInstallation,
  saveConversation,
} from "../src/db";
import {
  createFakeTracker,
  createInboxStore,
  openLinear,
  type AcceptedLinearEvent,
  type LinearSessionSnapshot,
  type TrackerAdapter,
} from "../src/linear";
import { attachOrchestrator } from "../src/loop";
import { tempHome } from "./helpers";

function created(sessionId: string): AcceptedLinearEvent {
  return {
    dedupeKey: `session:${sessionId}:created`,
    deliveryId: null,
    source: "poll",
    action: "created",
    sessionId,
    issueId: "issue",
    activityId: null,
    body: null,
    signal: null,
    updatedAtMs: 10,
    payload: JSON.stringify({
      organizationId: "org",
      appUserId: "app",
      agentSession: { creatorId: "human" },
    }),
  };
}

async function fixture() {
  const home = tempHome();
  const path = join(home, "paws.db");
  let db = openDatabase(path);
  migrate(db);
  const fake = createFakeTracker([
    {
      linearIssueId: "issue",
      identifier: "PAS-372",
      title: "Recover",
      description: null,
      subIssues: [],
    },
  ]);
  const tracker: TrackerAdapter = fake;
  for (const sessionId of ["old", "new", "other"])
    recordLinearInstallation(db, {
      sessionId,
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      teamId: "team",
      observedAtMs: 1,
    });
  let cancel = async (_itemId: string) => {};
  let authorized = true;
  const makeOrchestrator = () =>
    attachOrchestrator({
      db,
      tracker,
      pawsRoot: home,
      jobs: new JobLoop(db, systemClock),
      outbox: new OutboxDispatcher(db, systemClock),
      authorizeLinearIntake: () => authorized,
      remoteExecution: {
        cancelItem: (id) => cancel(id),
        agentForItem: () => {
          throw new Error("Unexpected agent");
        },
        agentForSession: () => {
          throw new Error("Unexpected agent");
        },
      },
    });
  let orchestrator = makeOrchestrator();
  await orchestrator.onLinearEvent(created("old"));
  const oldId = getLinearSession(db, "old")!.activeItemId!;
  beginImplementRun(db, oldId, 11);
  applyWorkItemEvent(db, oldId, "blocking_question");
  const snapshot: LinearSessionSnapshot = {
    id: "old",
    status: "error",
    createdAt: new Date(1).toISOString(),
    updatedAt: new Date(20).toISOString(),
    endedAt: null,
    dismissedAt: new Date(20).toISOString(),
    appUserId: "app",
    creatorId: "human",
    issue: { id: "issue", identifier: "PAS-372", title: "Recover", description: null },
    comment: null,
    sourceComment: null,
    summary: null,
    plan: null,
    context: null,
    externalLinks: [],
    pullRequest: null,
  };
  tracker.getSession = async (id) => ({ ...snapshot, id });
  const runtime = () =>
    openLinear({
      db,
      secretsDir: join(home, "secrets"),
      env: { LINEAR_ACCESS_TOKEN: "fixture-token" },
      publicUrl: null,
      isAuthorized: () => false,
      fetch: async () => {
        throw new Error("Unexpected provider");
      },
      progressReporter: (event) => orchestrator.sessionProgressReporter(event),
      followUp: (event) => orchestrator.onLinearEvent(event),
    });
  return {
    get db() {
      return db;
    },
    get orchestrator() {
      return orchestrator;
    },
    fake,
    tracker,
    snapshot,
    oldId,
    runtime,
    setCancel(fn: typeof cancel) {
      cancel = fn;
    },
    revoke() {
      authorized = false;
    },
    async reopen() {
      await orchestrator.shutdown();
      db.close();
      db = openDatabase(path);
      orchestrator = makeOrchestrator();
    },
    async close() {
      await orchestrator.shutdown();
      db.close();
    },
  };
}

test.each(["dismissed", "ended", "complete", "error", "stopping"])(
  "a new session safely replaces a %s Linear session",
  async (state) => {
    const f = await fixture();
    f.snapshot.dismissedAt = state === "dismissed" ? new Date(20).toISOString() : null;
    f.snapshot.endedAt = state === "ended" ? new Date(20).toISOString() : null;
    f.snapshot.status = ["dismissed", "ended"].includes(state) ? "awaitingInput" : state;
    try {
      await f.orchestrator.onLinearEvent(created("new"));
      expect(getWorkItem(f.db, f.oldId)?.state).toBe("cancelled");
      expect(getLinearSession(f.db, "old")?.stoppedAt).not.toBeNull();
      const replacement = getLinearSession(f.db, "new")!.activeItemId!;
      expect(getWorkItem(f.db, replacement)).toMatchObject({ state: "queued", sessionKey: "new" });
      await f.orchestrator.onLinearEvent(created("new"));
      expect(f.db.query("SELECT id FROM work_item").all()).toHaveLength(2);
    } finally {
      await f.close();
    }
  },
);

test.each(["pending", "active", "awaitingInput", "stale", "unknown"])(
  "a %s session keeps its claim",
  async (status) => {
    const f = await fixture();
    f.snapshot.dismissedAt = null;
    f.snapshot.status = status;
    try {
      await expect(f.orchestrator.onLinearEvent(created("new"))).rejects.toThrow(
        "unfinished attempt",
      );
      expect(getWorkItem(f.db, f.oldId)?.state).toBe("awaiting_input");
      expect(f.db.query("SELECT id FROM work_item").all()).toHaveLength(1);
    } finally {
      await f.close();
    }
  },
);

test.each(["organization_id", "oauth_client_id", "app_user_id", "team_id"])(
  "another %s cannot cancel an old session",
  async (column) => {
    const f = await fixture();
    f.db.run(`UPDATE linear_session SET ${column} = 'different' WHERE session_id = 'new'`);
    try {
      await expect(f.orchestrator.onLinearEvent(created("new"))).rejects.toThrow();
      expect(getWorkItem(f.db, f.oldId)?.state).toBe("awaiting_input");
    } finally {
      await f.close();
    }
  },
);

test.each(["unavailable", "issue", "app", "id", "generation", "authorization"])(
  "uncertain %s keeps the incoming request retryable",
  async (failure) => {
    const f = await fixture();
    f.tracker.getSession = async () => {
      if (failure === "unavailable") throw new Error("Linear unavailable");
      if (failure === "generation") advanceLinearSessionGeneration(f.db, "old");
      if (failure === "authorization") f.revoke();
      return {
        ...f.snapshot,
        ...(failure === "id" ? { id: "wrong" } : {}),
        ...(failure === "issue" ? { issue: null } : {}),
        ...(failure === "app" ? { appUserId: "wrong" } : {}),
      };
    };
    const linear = f.runtime();
    const event = created("new");
    const store = createInboxStore(f.db);
    store.commit(event);
    try {
      await expect(linear.webhook.onEvent!(event)).rejects.toThrow("retry automatically");
      expect(getWorkItem(f.db, f.oldId)?.state).toBe("awaiting_input");
      expect(store.listUnhandled()).toHaveLength(1);
      expect(
        f.fake.progress.filter((update) => update.sessionId === "new").map((update) => update.kind),
      ).toEqual(["thought", "thought"]);
    } finally {
      await linear.start(0).stop();
      await f.close();
    }
  },
);

test("concurrent retries wait for old runner teardown and admit one replacement", async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.setCancel(async () => {
    entered.resolve();
    await release.promise;
  });
  const first = f.orchestrator.onLinearEvent(created("new"));
  await entered.promise;
  const second = f.orchestrator.onLinearEvent(created("other"));
  const results = Promise.allSettled([first, second]);
  await Bun.sleep(5);
  expect(f.db.query("SELECT id FROM work_item").all()).toHaveLength(1);
  release.resolve();
  try {
    expect((await results).filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(f.db.query("SELECT id FROM work_item WHERE state = 'queued'").all()).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("failed cleanup remains fenced across SQLite reopen until teardown succeeds", async () => {
  const f = await fixture();
  f.setCancel(async () => {
    throw new Error("Runner has not stopped");
  });
  try {
    await expect(f.orchestrator.onLinearEvent(created("new"))).rejects.toThrow(
      "retry automatically",
    );
    expect(f.db.query("SELECT id FROM work_item").all()).toHaveLength(1);
    await f.reopen();
    await expect(f.orchestrator.onLinearEvent(created("new"))).rejects.toThrow(
      "retry automatically",
    );
    f.setCancel(async () => {});
    await f.orchestrator.onLinearEvent(created("new"));
    expect(f.db.query("SELECT id FROM work_item WHERE state = 'queued'").all()).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("an unverified ACP cleanup cannot release the old issue", async () => {
  const f = await fixture();
  saveConversation(f.db, f.oldId, "[]", null, true);
  try {
    await expect(f.orchestrator.onLinearEvent(created("new"))).rejects.toThrow(
      "retry automatically",
    );
    expect(f.db.query("SELECT id FROM work_item").all()).toHaveLength(1);
  } finally {
    await expect(f.orchestrator.shutdown()).rejects.toThrow("cleanup could not be verified");
    f.db.close();
  }
});
