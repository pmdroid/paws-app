import { expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { join } from "node:path";
import { systemClock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  advanceLinearSessionGeneration,
  applyWorkItemEvent,
  beginImplementRun,
  blockConversation,
  getConversation,
  getLinearSession,
  getWorkItem,
  openPawsStore,
  recordLinearInstallation,
  saveConversation,
  syncSteps,
  type Db,
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
import { remoteCommandsGoneSteps } from "../src/runner-backend";
import { RUNNER_LIVE_GRACE_MS } from "../src/runner-work";
import { pawsPaths } from "../src/config";
import { seed, withoutForeignKeys } from "./dialects";
import { migratedHome } from "./helpers";

const workItems = (db: Db, state?: string) =>
  db.run((q) =>
    q.all(
      q.orm
        .select({ id: q.t.workItem.id })
        .from(q.t.workItem)
        .where(state === undefined ? undefined : eq(q.t.workItem.state, state)),
    ),
  );

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
  const home = await migratedHome();
  const pgliteDir = pawsPaths(home).pgliteDir;
  let database = await openPawsStore({ url: null, pgliteDir });
  let db = database.store;
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
    await recordLinearInstallation(db, {
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
      store: db,
      tracker,
      pawsRoot: home,
      jobs: new JobLoop(db, systemClock),
      outbox: new OutboxDispatcher(db, systemClock),
      authorizeLinearIntake: () => syncSteps(() => authorized),
      remoteExecution: {
        cancelItem: (id) => cancel(id),
        agentForItem: () => {
          throw new Error("Unexpected agent");
        },
        agentForSession: () => {
          throw new Error("Unexpected agent");
        },
        commandsGone: (q, itemId, since) => remoteCommandsGoneSteps(q, itemId, since),
      },
    });
  let orchestrator = makeOrchestrator();
  await orchestrator.onLinearEvent(created("old"));
  const oldId = (await getLinearSession(db, "old"))!.activeItemId!;
  await beginImplementRun(db, oldId, 11);
  await applyWorkItemEvent(db, oldId, "blocking_question");
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
  const runtime = async () =>
    await openLinear({
      db,
      store: db,
      secretsDir: join(home, "secrets"),
      env: { LINEAR_ACCESS_TOKEN: "fixture-token" },
      isAuthorized: async () => false,
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
      await database.close();
      database = await openPawsStore({ url: null, pgliteDir });
      db = database.store;
      orchestrator = makeOrchestrator();
    },
    closeStore: () => database.close(),
    async close() {
      await orchestrator.shutdown();
      await database.close();
    },
  };
}

test.each(["dismissed", "ended", "complete", "error", "stopping"])(
  "a new session resumes the item a %s Linear session paused",
  async (state) => {
    const f = await fixture();
    f.snapshot.dismissedAt = state === "dismissed" ? new Date(20).toISOString() : null;
    f.snapshot.endedAt = state === "ended" ? new Date(20).toISOString() : null;
    f.snapshot.status = ["dismissed", "ended"].includes(state) ? "awaitingInput" : state;
    try {
      await f.orchestrator.onLinearEvent(created("new"));
      expect((await getLinearSession(f.db, "old"))?.stoppedAt).not.toBeNull();
      expect((await getLinearSession(f.db, "new"))!.activeItemId).toBe(f.oldId);
      expect(await getWorkItem(f.db, f.oldId)).toMatchObject({
        state: "queued",
        sessionKey: "new",
      });
      await f.orchestrator.onLinearEvent(created("new"));
      expect(await workItems(f.db)).toHaveLength(1);
    } finally {
      await f.close();
    }
  },
);

test("re-delegating an issue a Linear Stop paused resumes the same item", async () => {
  const f = await fixture();
  try {
    await f.orchestrator.onLinearEvent({
      ...created("old"),
      dedupeKey: "old:stop",
      action: "prompted",
      signal: "stop",
      updatedAtMs: 15,
    });
    expect((await getWorkItem(f.db, f.oldId))?.state).toBe("paused");
    await f.orchestrator.onLinearEvent(created("new"));
    expect(await workItems(f.db)).toHaveLength(1);
    expect(await getWorkItem(f.db, f.oldId)).toMatchObject({
      state: "queued",
      sessionKey: "new",
    });
    expect((await getLinearSession(f.db, "new"))?.activeItemId).toBe(f.oldId);
  } finally {
    await f.close();
  }
});

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
      expect((await getWorkItem(f.db, f.oldId))?.state).toBe("awaiting_input");
      expect(await workItems(f.db)).toHaveLength(1);
    } finally {
      await f.close();
    }
  },
);

test.each(["organization_id", "oauth_client_id", "app_user_id", "team_id"])(
  "another %s cannot cancel an old session",
  async (column) => {
    const f = await fixture();
    await f.db.orm.execute(
      sql`UPDATE linear_session SET ${sql.identifier(column)} = 'different' WHERE session_id = 'new'`,
    );
    try {
      await expect(f.orchestrator.onLinearEvent(created("new"))).rejects.toThrow();
      expect((await getWorkItem(f.db, f.oldId))?.state).toBe("awaiting_input");
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
      if (failure === "generation") await advanceLinearSessionGeneration(f.db, "old");
      if (failure === "authorization") f.revoke();
      return {
        ...f.snapshot,
        ...(failure === "id" ? { id: "wrong" } : {}),
        ...(failure === "issue" ? { issue: null } : {}),
        ...(failure === "app" ? { appUserId: "wrong" } : {}),
      };
    };
    const linear = await f.runtime();
    const event = created("new");
    const store = createInboxStore(f.db);
    await store.commit(event);
    try {
      await expect(linear.webhook.onEvent!(event)).rejects.toThrow("retry automatically");
      expect((await getWorkItem(f.db, f.oldId))?.state).toBe("awaiting_input");
      expect(await store.listUnhandled()).toHaveLength(1);
      expect(
        f.fake.progress.filter((update) => update.sessionId === "new").map((update) => update.kind),
      ).toEqual(["thought", "thought"]);
    } finally {
      await (await linear.start()).stop();
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
  expect(await workItems(f.db)).toHaveLength(1);
  release.resolve();
  try {
    expect((await results).filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await workItems(f.db)).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("failed cleanup remains fenced across reopen until teardown succeeds", async () => {
  const f = await fixture();
  f.setCancel(async () => {
    throw new Error("Runner has not stopped");
  });
  try {
    await expect(f.orchestrator.onLinearEvent(created("new"))).rejects.toThrow(
      "retry automatically",
    );
    expect(await workItems(f.db)).toHaveLength(1);
    await f.reopen();
    await expect(f.orchestrator.onLinearEvent(created("new"))).rejects.toThrow(
      "retry automatically",
    );
    f.setCancel(async () => {});
    await f.orchestrator.onLinearEvent(created("new"));
    expect(await workItems(f.db, "queued")).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("an unverified ACP cleanup cannot release the old issue", async () => {
  const f = await fixture();
  await saveConversation(f.db, f.oldId, "[]", null, true);
  try {
    await expect(f.orchestrator.onLinearEvent(created("new"))).rejects.toThrow(
      "retry automatically",
    );
    expect(await workItems(f.db)).toHaveLength(1);
  } finally {
    await expect(f.orchestrator.shutdown()).rejects.toThrow("cleanup could not be verified");
    await f.closeStore();
  }
});

test.each([
  ["reports the old command gone", true],
  ["still names the old command", false],
] as const)(
  "a cancelled item blocked by a failed cleanup, whose runner %s, decides a new delegation",
  async (_case, gone) => {
    const f = await fixture();
    try {
      const old = (await getWorkItem(f.db, f.oldId))!;
      const now = Date.now();
      // The run failed on agentbox with a cleanup error, then the item was cancelled.
      await blockConversation(f.db, f.oldId, now);
      await seed(f.db, (q) =>
        q.orm.update(q.t.workItem).set({ state: "cancelled" }).where(eq(q.t.workItem.id, f.oldId)),
      );
      // The runner's first heartbeat after its restart. Foreign keys are off only for its rows.
      const reported = now + RUNNER_LIVE_GRACE_MS;
      await withoutForeignKeys(f.db);
      await seed(
        f.db,
        (q) =>
          q.orm.insert(q.t.runner).values({
            id: "agentbox",
            workspaceId: "workspace",
            ownerUserId: "owner",
            name: "agentbox",
            status: "active",
            createdAt: now,
            liveReportedAt: reported,
          }),
        (q) =>
          q.orm.insert(q.t.runnerCommand).values({
            id: "command",
            runnerId: "agentbox",
            runId: old.currentRunId,
            generation: 1,
            kind: "run",
            envelope: "{}",
            expiresAt: now + 600_000,
            acknowledgedAt: now,
          }),
        (q) =>
          q.orm.insert(q.t.runnerWork).values({
            runId: old.currentRunId!,
            runnerId: "agentbox",
            workspaceId: "workspace",
            generation: 1,
            runnerFence: 0,
            commandId: "command",
            leaseUntil: now + 60_000,
            endedAt: now,
            confirmedAt: gone ? null : reported,
          }),
      );
      await f.db.orm.execute(sql`SET session_replication_role = origin`);
      if (gone) {
        await f.orchestrator.onLinearEvent(created("new"));
        expect((await getConversation(f.db, f.oldId)).blocked).toBe(false);
        expect(await workItems(f.db, "queued")).toHaveLength(1);
      } else {
        await expect(f.orchestrator.onLinearEvent(created("new"))).rejects.toThrow(
          "retry automatically",
        );
        expect((await getConversation(f.db, f.oldId)).blocked).toBe(true);
        expect(await workItems(f.db)).toHaveLength(1);
      }
    } finally {
      await seed(f.db, (q) => q.orm.update(q.t.linearConversation).set({ blocked: 0 }));
      await f.close();
    }
  },
);
