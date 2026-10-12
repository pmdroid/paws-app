import { afterEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { CommandBus, FakeClock } from "../src/core";
import {
  bindLinearSessionTask,
  enqueueOutbox,
  getLinearSession,
  getLinearSessionAccess,
  getOutbox,
  getWorkItem,
  hasLinearNotification,
  isLinearAppRevoked,
  listOutbox,
  migrate,
  openDatabase,
  OutboxDispatcher,
  recordLinearInstallation,
} from "../src/db";
import { intakeDelegatedIssue } from "../src/intake";
import { createLinearReconnect } from "../src/linear-reconnect";
import {
  createFakeTracker,
  createInboxStore,
  linearTokenPath,
  openLinear,
  parseAgentEvent,
  writeStoredToken,
} from "../src/linear";
import { deliverLinearOutbox, handleLinearAdministration } from "../src/loop";
import { startServer } from "../src/server";
import { tempHome } from "./helpers";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
const scope = { organizationId: "org", oauthClientId: "client", appUserId: "app" };
const secret = "fake-webhook-secret";

async function fixture(token = true, children = false) {
  const home = tempHome();
  const db = openDatabase(join(home, "paws.db"));
  migrate(db);
  cleanup.push(() => db.close());
  const tracker = createFakeTracker([
    {
      linearIssueId: "issue",
      identifier: "ENG-1",
      title: "Task",
      description: null,
      subIssues: children
        ? [
            { linearIssueId: "first", identifier: "ENG-2", title: "First child" },
            { linearIssueId: "second", identifier: "ENG-3", title: "Second child" },
          ]
        : [],
    },
  ]);
  const task = await intakeDelegatedIssue(db, tracker, { linearIssueId: "issue" });
  if (!task.ok) throw new Error("Unexpected issue cycle");
  recordLinearInstallation(db, { ...scope, sessionId: "session", teamId: "team", observedAtMs: 1 });
  bindLinearSessionTask(db, "session", task.epic.id, { actorId: "human" });
  const bus = new CommandBus();
  const owned = new AbortController();
  const notifications: string[] = [];
  const interrupted: string[] = [];
  const cleanupFailure: { sessionId: string | null } = { sessionId: null };
  bus.subscribe((command) => {
    notifications.push(command.itemId);
    owned.abort(new Error("Cancelled"));
  });
  if (token)
    writeStoredToken(linearTokenPath(join(home, "secrets")), {
      accessToken: "fake-old-access",
      refreshToken: "fake-old-refresh",
      expiresAtMs: Date.now() + 600_000,
      actor: "app",
      scope: "read,write",
    });
  const requests: string[] = [];
  const active = Promise.withResolvers<void>();
  const opened = openLinear({
    db,
    secretsDir: join(home, "secrets"),
    env: { LINEAR_CLIENT_ID: "client", LINEAR_APP_USER_ID: "app" },
    publicUrl: null,
    noTunnel: true,
    isAuthorized: () => !isLinearAppRevoked(db, scope),
    beforeEvent: async (event) =>
      !(await handleLinearAdministration(db, event, {
        ...scope,
        revalidate: async () => {},
        notify: (command) => bus.emit(command),
        interrupt: async (sessionId) => {
          interrupted.push(sessionId);
          if (cleanupFailure.sessionId === sessionId) throw new Error("Owned cleanup failed");
        },
      })),
    fetch: async (_url, init) => {
      const data = JSON.parse(String(init?.body));
      const body = data.variables.input.content.body;
      requests.push(body);
      if (body === "Working") {
        active.resolve();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        });
      }
      return Response.json({
        data: { agentActivityCreate: { success: true, agentActivity: { id: "sent" } } },
      });
    },
  });
  const server = startServer({
    port: 0,
    linearWebhookSecret: secret,
    linearWebhook: opened.webhook,
    webhooks: true,
  });
  cleanup.push(() => server.stop(true));
  const dispatcher = new OutboxDispatcher(db, new FakeClock(Date.now() + 10_000));
  dispatcher.setHandler((message, context) =>
    deliverLinearOutbox(message, opened.tracker!, async () => {}, context),
  );
  const post = async (body: object, delivery: string = crypto.randomUUID()) => {
    const raw = JSON.stringify({ ...body, webhookTimestamp: Date.now() });
    return fetch(new URL("/webhooks/linear", server.url), {
      method: "POST",
      headers: {
        "linear-delivery": delivery,
        "linear-signature": createHmac("sha256", secret).update(raw).digest("hex"),
      },
      body: raw,
    });
  };
  return {
    db,
    home,
    opened,
    task,
    owned,
    dispatcher,
    requests,
    active,
    post,
    notifications,
    interrupted,
    cleanupFailure,
  };
}

function revoked() {
  return { ...scope, type: "OAuthApp", action: "revoked", createdAt: new Date().toISOString() };
}

test("one session cleanup failure still interrupts every session and remains retryable", async () => {
  const f = await fixture(false);
  recordLinearInstallation(f.db, {
    ...scope,
    sessionId: "session-two",
    teamId: "team",
    observedAtMs: 1,
  });
  f.cleanupFailure.sessionId = "session";
  const event = revoked();
  expect((await f.post(event, "cleanup-revocation")).status).toBe(200);
  for (let i = 0; i < 100 && f.interrupted.length < 2; i++) await Bun.sleep(5);
  expect(f.interrupted).toEqual(["session", "session-two"]);
  expect(createInboxStore(f.db).listUnhandled()).toHaveLength(1);
  expect(getLinearSessionAccess(f.db, "session-two")).toBe("revoked");
  expect(getLinearSession(f.db, "session-two")?.generation).toBe(1);
  f.cleanupFailure.sessionId = null;
  expect((await f.post(event, "cleanup-revocation")).status).toBe(200);
  for (let i = 0; i < 100 && createInboxStore(f.db).listUnhandled().length > 0; i++)
    await Bun.sleep(5);
  expect(createInboxStore(f.db).listUnhandled()).toEqual([]);
  expect(f.interrupted).toEqual(["session", "session-two", "session", "session-two"]);
  expect(getLinearSession(f.db, "session-two")?.generation).toBe(1);
});

test("a rejected second-child cancellation rolls back signed revocation before notifying owned writers", async () => {
  const f = await fixture(true, true);
  const second = f.task.items.find((item) => item.linearIssueId === "second")!;
  f.db.run(
    "CREATE TRIGGER reject_second_cancel BEFORE UPDATE OF state ON work_item WHEN NEW.id = '" +
      second.id +
      "' AND NEW.state = 'cancelled' BEGIN SELECT RAISE(ABORT, 'Second child cannot cancel'); END",
  );
  const original = f.task.items.map((item) => getWorkItem(f.db, item.id)?.state);
  const event = revoked();
  expect((await f.post(event, "atomic-revocation")).status).toBe(200);
  expect(createInboxStore(f.db).listUnhandled()).toHaveLength(1);
  expect(f.task.items.map((item) => getWorkItem(f.db, item.id)?.state)).toEqual(original);
  expect(getLinearSession(f.db, "session")?.generation).toBe(0);
  expect(getLinearSession(f.db, "session")?.stoppedAt).toBeNull();
  expect(getLinearSessionAccess(f.db, "session")).toBe("allowed");
  expect(
    f.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM linear_access_event").get()?.n,
  ).toBe(0);
  expect(
    f.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM linear_app_revocation").get()?.n,
  ).toBe(0);
  expect(listOutbox(f.db, "session")).toEqual([]);
  expect(f.notifications).toEqual([]);
  expect(f.interrupted).toEqual([]);
  expect(f.owned.signal.aborted).toBe(false);
  f.db.run("DROP TRIGGER reject_second_cancel");
  expect((await f.post(event, "atomic-revocation")).status).toBe(200);
  for (let i = 0; i < 100 && createInboxStore(f.db).listUnhandled().length > 0; i++)
    await Bun.sleep(5);
  expect(createInboxStore(f.db).listUnhandled()).toEqual([]);
  expect(f.task.items.map((item) => getWorkItem(f.db, item.id)?.state)).toEqual([
    "cancelled",
    "cancelled",
  ]);
  expect(f.notifications).toEqual(f.task.items.map((item) => item.id));
  expect(f.interrupted).toEqual(["session"]);
  expect(f.owned.signal.aborted).toBe(true);
  expect(getLinearSessionAccess(f.db, "session")).toBe("revoked");
  expect(listOutbox(f.db, "session").every((row) => row.status === "dropped")).toBe(true);
});

test("signed revocation stops owned work and fences active, queued and delayed responses across verified reconnect", async () => {
  const f = await fixture();
  const progress = enqueueOutbox(f.db, {
    target: "linear",
    op: "activity",
    orderingKey: "session",
    idempotencyKey: "progress",
    payload: { sessionId: "session", kind: "thought", body: "Working" },
  });
  f.dispatcher.tick();
  await f.active.promise;
  expect((await f.post(revoked())).status).toBe(200);
  expect(getLinearSessionAccess(f.db, "session")).toBe("revoked");
  expect(getWorkItem(f.db, f.task.items[0]!.id)?.state).toBe("cancelled");
  expect(f.owned.signal.aborted).toBe(true);
  expect(listOutbox(f.db, "session").every((row) => row.status === "dropped")).toBe(true);
  f.dispatcher.tick();
  await f.dispatcher.idle();
  expect(getOutbox(f.db, progress)?.status).toBe("dropped");
  const late = enqueueOutbox(f.db, {
    target: "linear",
    op: "activity",
    orderingKey: "session",
    delivery: "stop",
    idempotencyKey: "late",
    payload: { sessionId: "session", kind: "response", body: "Stale cancellation" },
  });
  const reconnect = createLinearReconnect({
    now: () => Date.now() + 1000,
    fetch: async () =>
      Response.json({ data: { viewer: { id: "app", app: true, organization: { id: "org" } } } }),
  })(f.home);
  expect(
    await reconnect.complete({
      clientId: "client",
      token: {
        accessToken: "fake-new-access",
        refreshToken: "fake-new-refresh",
        expiresAtMs: Date.now() + 600_000,
        scope: "read,write",
        actor: "app",
      },
    }),
  ).toBe(true);
  expect(getOutbox(f.db, late)?.status).toBe("dropped");
  const reopened = openDatabase(join(f.home, "paws.db"));
  cleanup.push(() => reopened.close());
  const recovered = new OutboxDispatcher(reopened, new FakeClock(Date.now() + 10_000));
  recovered.setHandler((message, context) =>
    deliverLinearOutbox(message, f.opened.tracker!, async () => {}, context),
  );
  expect(recovered.tick()).toEqual([]);
  await recovered.idle();
  expect(f.requests).toEqual(["Working"]);
});

test("signed revocation is persisted and stops queued work even without a stored Linear credential", async () => {
  const f = await fixture(false);
  expect(f.opened.tracker).toBeNull();
  expect((await f.post(revoked())).status).toBe(200);
  expect(getLinearSessionAccess(f.db, "session")).toBe("revoked");
  expect(f.owned.signal.aborted).toBe(true);
  expect(f.requests).toEqual([]);
});

test("team removal keeps the authorized stopped response while human unassignment does not revoke credentials", async () => {
  const f = await fixture();
  expect(
    (
      await f.post({
        ...scope,
        type: "PermissionChange",
        action: "teamAccessChanged",
        createdAt: new Date().toISOString(),
        canAccessAllPublicTeams: false,
        addedTeamIds: [],
        removedTeamIds: ["team"],
      })
    ).status,
  ).toBe(200);
  expect(getLinearSessionAccess(f.db, "session")).toBe("team_removed");
  expect(isLinearAppRevoked(f.db, scope)).toBe(false);
  f.dispatcher.tick();
  await f.dispatcher.idle();
  expect(f.requests).toEqual(["Cancelled from Linear."]);
});

test("notification dedupe follows successful reconciliation and serializes overlapping delivery IDs", async () => {
  const f = await fixture(false);
  const payload = {
    ...scope,
    type: "AppUserNotification",
    action: "issueUnassignedFromYou",
    createdAt: new Date().toISOString(),
    notification: {
      id: "notification",
      type: "issueUnassignedFromYou",
      userId: "app",
      issueId: "issue",
      issue: { id: "issue", teamId: "team" },
    },
  };
  const first = parseAgentEvent(JSON.stringify(payload), "delivery-a", Date.now())!;
  const second = parseAgentEvent(JSON.stringify(payload), "delivery-b", Date.now())!;
  let calls = 0;
  const failed = {
    ...scope,
    notify: () => {},
    reconcile: async () => {
      calls++;
      throw new Error("Retry reconciliation");
    },
  };
  await expect(handleLinearAdministration(f.db, first, failed)).rejects.toThrow(
    "Retry reconciliation",
  );
  expect(
    hasLinearNotification(f.db, {
      ...scope,
      notificationId: "notification",
      createdAtMs: Date.now(),
    }),
  ).toBe(false);
  const released = Promise.withResolvers<void>();
  const options = {
    ...scope,
    notify: () => {},
    reconcile: async () => {
      calls++;
      await released.promise;
    },
  };
  const a = handleLinearAdministration(f.db, first, options);
  const b = handleLinearAdministration(f.db, second, options);
  released.resolve();
  await Promise.all([a, b]);
  await handleLinearAdministration(f.db, second, options);
  expect(calls).toBe(2);
  expect(isLinearAppRevoked(f.db, scope)).toBe(false);
  expect(getWorkItem(f.db, f.task.items[0]!.id)?.state).toBe("queued");
});
