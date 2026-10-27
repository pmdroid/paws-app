import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { CommandBus, FakeClock, JOB_KIND } from "../src/core";
import {
  applyWorkItemEvent,
  bindLinearSessionTask,
  getWorkItem,
  listJobs,
  listOutbox,
  migrate,
  openDatabase,
  OutboxDispatcher,
  recordConfirmedRemoteMerge,
  recordLinearInstallation,
  setJournalSink,
} from "../src/db";
import { intakeDelegatedIssue } from "../src/intake";
import {
  createFakeTracker,
  createInboxStore,
  linearTokenPath,
  openLinear,
  parseAgentEvent,
  parseLinearIssueClosed,
  startCatchUpPoller,
  writeStoredToken,
  type AcceptedLinearEvent,
  type IntakeSighting,
} from "../src/linear";
import { closeClosedIssueTasks, deliverLinearOutbox, ISSUE_CLOSED_RESPONSE } from "../src/loop";
import { startServer } from "../src/server";
import { createLiveStatusProvider } from "../src/web";
import { tempHome } from "./helpers";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
const scope = { organizationId: "org", oauthClientId: "client", appUserId: "app" };
const secret = "fake-webhook-secret";

async function fixture() {
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
      subIssues: [],
    },
  ]);
  const task = await intakeDelegatedIssue(db, tracker, { linearIssueId: "issue" });
  if (!task.ok) throw new Error("Unexpected issue cycle");
  recordLinearInstallation(db, { ...scope, sessionId: "session", teamId: "team", observedAtMs: 1 });
  bindLinearSessionTask(db, "session", task.delegation.id, { actorId: "human" });
  const journal: string[] = [];
  const restore = setJournalSink((line) => journal.push(line));
  cleanup.push(restore);
  return { home, db, task, item: task.items[0]!, journal };
}

function issueUpdate(stateType: string, updatedFrom: Record<string, unknown> = { stateId: "old" }) {
  const at = new Date(Date.now() + 1_000).toISOString();
  return {
    ...scope,
    type: "Issue",
    action: "update",
    createdAt: at,
    data: {
      id: "issue",
      identifier: "ENG-1",
      stateId: "closed",
      state: { id: "closed", type: stateType, name: stateType },
      ...(stateType === "completed" ? { completedAt: at } : {}),
      ...(stateType === "canceled" ? { canceledAt: at } : {}),
    },
    updatedFrom,
  };
}

test("a failed task whose issue moves to Done leaves Needs a person and completes its session without reading Linear", async () => {
  const f = await fixture();
  applyWorkItemEvent(f.db, f.item.id, "start_timed_out");
  const status = createLiveStatusProvider(f.db);
  const needsPerson = () =>
    status
      .snapshot()
      .items.filter((item) => item.state === "needs_human")
      .map((item) => item.title);
  expect(needsPerson()).toEqual(["Task"]);

  writeStoredToken(linearTokenPath(join(f.home, "secrets")), {
    accessToken: "fake-access",
    refreshToken: "fake-refresh",
    expiresAtMs: Date.now() + 600_000,
    actor: "app",
    scope: "read,write",
  });
  const requests: { query: string; body: unknown }[] = [];
  const bus = new CommandBus();
  const notified: string[] = [];
  bus.subscribe((command) => notified.push(command.itemId));
  const interrupted: string[] = [];
  const handled = Promise.withResolvers<void>();
  const opened = openLinear({
    db: f.db,
    secretsDir: join(f.home, "secrets"),
    env: { LINEAR_CLIENT_ID: "client", LINEAR_APP_USER_ID: "app" },
    beforeEvent: async (event) => {
      const closed = parseLinearIssueClosed(event);
      if (closed)
        await closeClosedIssueTasks(f.db, closed, {
          notify: (command) => bus.emit(command),
          interrupt: async (sessionId) => {
            interrupted.push(sessionId);
          },
        });
      handled.resolve();
      return false;
    },
    fetch: async (_url, init) => {
      const data = JSON.parse(String(init?.body));
      if (String(data.query).includes("agentSessionUpdate"))
        return Response.json({
          data: { agentSessionUpdate: { success: true, agentSession: { id: data.variables.id } } },
        });
      requests.push({ query: data.query, body: data.variables?.input?.content?.body });
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
  const raw = JSON.stringify({ ...issueUpdate("completed"), webhookTimestamp: Date.now() });
  const response = await fetch(new URL("/webhooks/linear", server.url), {
    method: "POST",
    headers: {
      "linear-delivery": "issue-done",
      "linear-signature": createHmac("sha256", secret).update(raw).digest("hex"),
    },
    body: raw,
  });
  expect(response.status).toBe(200);
  await handled.promise;

  expect(getWorkItem(f.db, f.item.id)?.state).toBe("cancelled");
  expect(needsPerson()).toEqual([]);
  expect(notified).toEqual([f.item.id]);
  expect(interrupted).toEqual(["session"]);
  expect(f.journal.some((line) => line.includes("ENG-1 cancelled") && line.includes("Done"))).toBe(
    true,
  );

  const dispatcher = new OutboxDispatcher(f.db, new FakeClock(Date.now() + 10_000));
  dispatcher.setHandler((message, context) =>
    deliverLinearOutbox(message, opened.tracker!, async () => {}, context),
  );
  while (dispatcher.tick().length > 0) await dispatcher.idle();
  expect(requests.map((request) => request.body)).toEqual([ISSUE_CLOSED_RESPONSE.completed]);
  expect(requests.every((request) => request.query.trim().startsWith("mutation"))).toBe(true);
  const responses = listOutbox(f.db).filter(
    (row) => (row.payload as { kind?: string }).kind === "response",
  );
  expect(responses).toHaveLength(1);
  expect(responses[0]!.payload).toMatchObject({ sessionId: "session", kind: "response" });
});

test("an issue moved to Canceled cancels a queued task", async () => {
  const f = await fixture();
  const notified: string[] = [];
  const event = parseAgentEvent(
    JSON.stringify(issueUpdate("canceled")),
    "issue-canceled",
    Date.now(),
  )!;
  const closed = parseLinearIssueClosed(event);
  expect(closed).toMatchObject({ issueId: "issue", organizationId: "org", stateType: "canceled" });
  const outcomes = await closeClosedIssueTasks(f.db, closed!, {
    notify: (command) => notified.push(command.itemId),
  });
  expect(outcomes).toEqual([{ itemId: f.item.id, outcome: "cancelled" }]);
  expect(getWorkItem(f.db, f.item.id)?.state).toBe("cancelled");
  expect(notified).toEqual([f.item.id]);
  const responses = listOutbox(f.db).filter(
    (row) => (row.payload as { kind?: string }).kind === "response",
  );
  expect(responses.map((row) => (row.payload as { body: string }).body)).toEqual([
    ISSUE_CLOSED_RESPONSE.canceled,
  ]);
  expect(f.journal.some((line) => line.includes("ENG-1 cancelled"))).toBe(true);
});

test("a confirmed merge from the task's own branch completes the task as merged", async () => {
  const f = await fixture();
  for (const step of ["dispatched", "turn_ended", "closeout_accepted"] as const)
    applyWorkItemEvent(f.db, f.item.id, step);
  recordConfirmedRemoteMerge(f.db, {
    itemId: f.item.id,
    repositoryOwner: "acme",
    repositoryName: "app",
    pullNumber: 7,
    pullUrl: null,
    mergeSha: "abc",
    confirmedAt: Date.now(),
  });
  const closed = parseLinearIssueClosed(
    parseAgentEvent(JSON.stringify(issueUpdate("completed")), "issue-merged", Date.now())!,
  )!;
  const outcomes = await closeClosedIssueTasks(f.db, closed, { notify: () => {} });
  expect(outcomes).toEqual([{ itemId: f.item.id, outcome: "merged" }]);
  expect(getWorkItem(f.db, f.item.id)?.state).toBe("merged");
});

test("Done cancels a merge-queue task without a confirmed merge and completes its session", async () => {
  const f = await fixture();
  for (const step of ["dispatched", "turn_ended", "closeout_accepted"] as const)
    applyWorkItemEvent(f.db, f.item.id, step);
  const closed = parseLinearIssueClosed(
    parseAgentEvent(JSON.stringify(issueUpdate("completed")), "issue-queued", Date.now())!,
  )!;
  expect(await closeClosedIssueTasks(f.db, closed, { notify: () => {} })).toEqual([
    { itemId: f.item.id, outcome: "cancelled" },
  ]);
  expect(getWorkItem(f.db, f.item.id)?.state).toBe("cancelled");
  const responses = listOutbox(f.db).filter(
    (row) => (row.payload as { kind?: string }).kind === "response",
  );
  expect(responses.map((row) => (row.payload as { body: string }).body)).toEqual([
    ISSUE_CLOSED_RESPONSE.completed,
  ]);
  expect(
    listJobs(f.db).some(
      (job) =>
        job.queue === JOB_KIND.closeStoppedPull &&
        (job.payload as { itemId?: string }).itemId === f.item.id,
    ),
  ).toBe(true);
});

test("a task created after the issue closed is a later delegation and stays", async () => {
  const f = await fixture();
  const outcomes = await closeClosedIssueTasks(
    f.db,
    {
      issueId: "issue",
      organizationId: "org",
      identifier: "ENG-1",
      stateType: "completed",
      closedAtMs: 0,
    },
    { notify: () => {} },
  );
  expect(outcomes).toEqual([]);
  expect(getWorkItem(f.db, f.item.id)?.state).toBe("queued");
});

test("the catch-up poll closes the tasks of an issue whose webhook was missed", async () => {
  const f = await fixture();
  applyWorkItemEvent(f.db, f.item.id, "start_timed_out");
  const store = createInboxStore(f.db);
  const closedAtMs = Date.now() + 1_000;
  const sighting: IntakeSighting = {
    sessions: [],
    issues: [
      {
        id: "issue",
        identifier: "ENG-1",
        updatedAtMs: closedAtMs,
        labeled: false,
        delegated: false,
        closed: { stateType: "completed", closedAtMs },
      },
      {
        id: "unrelated",
        identifier: "ENG-9",
        updatedAtMs: closedAtMs,
        labeled: false,
        delegated: false,
        closed: { stateType: "completed", closedAtMs },
      },
    ],
    comments: [],
    activities: [],
    budget: null,
    caughtUp: true,
    queried: true,
  };
  const seen: AcceptedLinearEvent[] = [];
  const poller = startCatchUpPoller({
    source: { poll: async () => sighting },
    store,
    db: f.db,
    onEvent: async (event) => {
      seen.push(event);
      const closed = parseLinearIssueClosed(event);
      if (closed) await closeClosedIssueTasks(f.db, closed, { notify: () => {} });
      return false;
    },
    sleeper: { wait: () => new Promise(() => {}), wake: () => {} },
  });
  cleanup.push(() => void poller.stop());
  await poller.pollNow();
  expect(seen.map((event) => event.issueId)).toEqual(["issue"]);
  expect(getWorkItem(f.db, f.item.id)?.state).toBe("cancelled");
  expect(store.get(seen[0]!.dedupeKey)).not.toBeNull();
  expect(store.listUnhandled().map((event) => event.dedupeKey)).not.toContain(seen[0]!.dedupeKey);
});

describe("parseLinearIssueClosed", () => {
  const parse = (payload: object) =>
    parseLinearIssueClosed(parseAgentEvent(JSON.stringify(payload), "delivery", Date.now())!);

  test("only a state change into a completed or canceled state counts", () => {
    expect(parse(issueUpdate("completed"))?.stateType).toBe("completed");
    expect(parse(issueUpdate("canceled"))?.stateType).toBe("canceled");
    expect(parse(issueUpdate("started"))).toBeNull();
    expect(parse(issueUpdate("completed", { title: "Old" }))).toBeNull();
    expect(parse({ ...issueUpdate("completed"), action: "create" })).toBeNull();
    expect(parse({ ...issueUpdate("completed"), type: "Comment" })).toBeNull();
  });
});
