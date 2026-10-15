import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  applyWorkItemEvent,
  beginImplementRun,
  bindLinearSessionTask,
  enqueueJob,
  getWorkItem,
  getLinearSession,
  acceptLinearStop,
  insertQueuedItem,
  recordLinearInstallation,
  saveCheckpoint,
  saveTaskMode,
} from "../../src/db";
import { hasPendingEpicChanges, intakeDelegatedIssue, readyItems } from "../../src/intake";
import { createFakeTracker, createInboxStore } from "../../src/linear";
import { runtimeLinear } from "../fixtures/workspace-runtime-linear";

export async function probeExecutionRuntime(input: {
  db: Database;
  workspaceId: string;
  secret: string;
  post(body: unknown, headers: Record<string, string>): Promise<{ status: number }>;
  advance(ms: number): void;
  catchUp(): Promise<void>;
  observe(name: string, observed: unknown): void;
}) {
  const { db, observe } = input;
  const until = async (condition: () => boolean) => {
    const deadline = performance.now() + 6000;
    while (!condition()) {
      assert(performance.now() < deadline, "Production execution observation timed out");
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };
  const timers = () =>
    db
      .query<{ queue: string; interval: number; fires: number }, []>(
        "SELECT queue,recurring_every_ms AS interval,fire_count AS fires FROM job WHERE queue IN ('scheduler.tick','execution.reconcile','linear.epics.reconcile') ORDER BY queue",
      )
      .all();
  await until(() => timers().length === 3 && timers().every((row) => row.fires > 0));
  assert.deepEqual(
    timers().map(({ queue, interval }) => ({ queue, interval })),
    [
      { queue: "execution.reconcile", interval: 30_000 },
      { queue: "linear.epics.reconcile", interval: 300_000 },
      { queue: "scheduler.tick", interval: 30_000 },
    ],
  );
  observe(
    "Actual Paws startup persists and executes scheduler, execution and active-epic sweep timers",
    timers(),
  );
  let changed = false;
  let gate: Promise<void> | undefined;
  let fetching = false;
  const page = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
  runtimeLinear.graph = async (query, variables) => {
    const id = variables["id"];
    if (query.includes("PawsSessionInstallation"))
      return Response.json({
        data: {
          viewer: { id: "app", app: true, organization: { id: "org" } },
          agentSession: {
            id,
            appUser: { id: "app", app: true, organization: { id: "org" } },
            issue: { id: "runtime-issue", team: { id: "team" } },
          },
        },
      });
    if (query.includes("PawsTeamAccess")) return Response.json({ data: { team: { id: "team" } } });
    if (query.includes("IssueSnapshot")) {
      assert(id === "runtime-issue" || id === "lin-startup-controlled");
      if (id === "runtime-issue") {
        fetching = true;
        await gate;
      }
      return Response.json({
        data: {
          issue: {
            id,
            identifier: id === "runtime-issue" ? "RUNTIME-1" : id,
            title: id === "runtime-issue" ? "Runtime criteria" : id,
            description:
              id === "runtime-issue" ? (changed ? "Updated criteria" : "Original criteria") : null,
            team: { id: "team" },
            project: null,
            assignee: null,
            priority: 0,
            children: page,
          },
        },
      });
    }
    if (query.includes("IssueOwnership")) {
      assert(
        [
          "runtime-issue",
          "runtime-external",
          "lin-startup-controlled",
          "lin-item-startup-controlled",
        ].includes(String(id)),
      );
      return Response.json({
        data: {
          issue: {
            id,
            team: { id: "team" },
            state: { type: "started" },
            assignee: null,
            delegate: { id: "app" },
            project: null,
          },
        },
      });
    }
    if (query.includes("IssueRelations")) {
      assert(id === "runtime-issue" || id === "lin-startup-controlled");
      return Response.json({
        data: {
          issue: {
            id,
            relations: page,
            inverseRelations: {
              ...page,
              nodes:
                changed && id === "runtime-issue"
                  ? [
                      {
                        type: "blocks",
                        issue: { id: "runtime-external" },
                        relatedIssue: { id: "runtime-issue" },
                      },
                    ]
                  : [],
            },
          },
        },
      });
    }
    if (query.includes("AgentActivityByCallerId"))
      return Response.json({ data: { agentActivities: page } });
    if (query.includes("AgentActivityCreate"))
      return Response.json({
        data: {
          agentActivityCreate: {
            success: true,
            agentActivity: { id: (variables["input"] as { id: string }).id },
          },
        },
      });
    if (query.includes("AgentSessionUpdate"))
      return Response.json({
        data: { agentSessionUpdate: { success: true, agentSession: { id } } },
      });
    throw new Error(`Unexpected execution runtime query: ${query.slice(0, 90)}`);
  };
  const tracker = createFakeTracker([
    {
      linearIssueId: "runtime-issue",
      identifier: "RUNTIME-1",
      title: "Runtime criteria",
      description: "Original criteria",
      subIssues: [],
    },
  ]);
  const accepted = await intakeDelegatedIssue(db, tracker, { linearIssueId: "runtime-issue" });
  assert(accepted.ok);
  const itemId = accepted.items[0]!.id;
  const target = { epicId: accepted.epic.id, workspaceId: input.workspaceId };
  const sessionId = "runtime-execution-session";
  recordLinearInstallation(db, {
    sessionId,
    organizationId: "org",
    teamId: "team",
    oauthClientId: "client",
    appUserId: "app",
    observedAtMs: Date.now(),
  });
  bindLinearSessionTask(db, sessionId, target.epicId, { actorId: "owner" });
  db.run("UPDATE work_item SET session_key=? WHERE id=?", [sessionId, itemId]);
  saveTaskMode(db, itemId, "code", 0, true);
  beginImplementRun(db, itemId, Date.now());
  applyWorkItemEvent(db, itemId, "turn_ended");
  saveCheckpoint(db, itemId, {
    phase: "verifying",
    wipCommit: "a".repeat(40),
    baseSha: "b".repeat(40),
  });
  const oldRun = getWorkItem(db, itemId)!.currentRunId;
  const oldMerge = enqueueJob(db, {
    queue: "github.merge",
    payload: { itemId },
    runAt: Date.now() + 86_400_000,
  });
  const spec = () =>
    db
      .query<{ hash: string; revision: number }, [string]>(
        "SELECT hash,revision FROM work_item_specification WHERE item_id=?",
      )
      .get(itemId);
  const generation = () =>
    db
      .query<{ generation: number }, [string]>(
        "SELECT generation FROM epic_dependency_snapshot WHERE epic_id=?",
      )
      .get(target.epicId)?.generation ?? 0;
  const issueEvent = () => ({
    type: "Issue",
    action: "update",
    organizationId: "org",
    actor: { id: "owner" },
    webhookTimestamp: Date.now(),
    data: { id: "runtime-issue", parentId: null },
  });
  const post = (body: unknown, delivery: string, signed = true) =>
    input.post(body, {
      "linear-delivery": delivery,
      ...(signed
        ? {
            "linear-signature": createHmac("sha256", input.secret)
              .update(JSON.stringify(body))
              .digest("hex"),
          }
        : {}),
    });
  assert.equal((await post(issueEvent(), "runtime-unsigned", false)).status, 401);
  assert.equal(generation(), 0);
  assert.equal((await post(issueEvent(), "runtime-initial")).status, 200);
  await until(() => generation() > 0 && !hasPendingEpicChanges(db, target.epicId));
  assert.equal(spec()!.revision, 1);
  const first = { ...spec()! };
  observe(
    "Authenticated signed Issue ingress creates the authoritative runtime snapshot and unsigned ingress changes nothing",
    { generation: generation(), revision: first.revision, unsigned: 401, signed: 200 },
  );
  const release = Promise.withResolvers<void>();
  gate = release.promise;
  fetching = false;
  changed = true;
  try {
    assert.equal((await post(issueEvent(), "runtime-criteria-edit")).status, 200);
    await until(() => fetching && hasPendingEpicChanges(db, target.epicId));
    const before = timers().find((row) => row.queue === "scheduler.tick")!.fires;
    db.run("UPDATE job SET run_at=? WHERE queue='scheduler.tick' AND status='pending'", [
      Date.now(),
    ]);
    await until(() => timers().find((row) => row.queue === "scheduler.tick")!.fires > before);
    assert.deepEqual(readyItems(db, target).readyItemIds, []);
    assert.equal(
      db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM job WHERE queue='item.start' AND json_extract(payload,'$.itemId')=?",
        )
        .get(itemId)!.n,
      0,
    );
  } finally {
    release.resolve();
  }
  await until(() => spec()?.revision === 2 && !hasPendingEpicChanges(db, target.epicId));
  assert.notEqual(spec()!.hash, first.hash);
  assert.equal(getWorkItem(db, itemId)!.currentRunId, null);
  assert.equal(getWorkItem(db, itemId)!.checkpoint, null);
  assert.equal(getWorkItem(db, itemId)!.state, "queued");
  assert.equal(
    db.query<{ status: string }, [number]>("SELECT status FROM job WHERE id=?").get(oldMerge)!
      .status,
    "cancelled",
  );
  assert.equal(
    db.query<{ status: string }, [string]>("SELECT status FROM run WHERE id=?").get(oldRun!)!
      .status,
    "lost",
  );
  assert.deepEqual(readyItems(db, target).readyItemIds, []);
  observe(
    "Signed live criteria changes hold the actual scheduler during reads then fence old candidate, run and merge before blocked redispatch",
    {
      revision: spec()!.revision,
      candidate: null,
      oldRun: "lost",
      oldMerge: "cancelled",
      ready: [],
    },
  );
  const beforeSweep = timers().find((row) => row.queue === "linear.epics.reconcile")!.fires;
  const beforeGeneration = generation();
  input.advance(300_001);
  await until(
    () =>
      timers().find((row) => row.queue === "linear.epics.reconcile")!.fires > beforeSweep &&
      generation() > beforeGeneration &&
      !hasPendingEpicChanges(db, target.epicId),
  );
  assert.equal(spec()!.revision, 2);
  assert.deepEqual(readyItems(db, target).readyItemIds, []);
  observe(
    "The actual five-minute durable runtime sweep refreshes active epics without changing unchanged criteria or bypassing blockers",
    {
      previousGeneration: beforeGeneration,
      generation: generation(),
      sweepFires: timers().find((row) => row.queue === "linear.epics.reconcile")!.fires,
      revision: 2,
    },
  );
  acceptLinearStop(db, sessionId, JSON.stringify(["activity", "runtime-session-late"]), Date.now());
  applyWorkItemEvent(db, itemId, "cancel");
  db.run("UPDATE epic SET state='done' WHERE id=?", [target.epicId]);
  const late = {
    type: "AgentSessionEvent",
    action: "prompted",
    organizationId: "org",
    oauthClientId: "client",
    appUserId: "app",
    webhookTimestamp: Date.now(),
    agentSession: { id: sessionId, issue: { id: "runtime-issue", team: { id: "team" } } },
    agentActivity: {
      id: "runtime-session-late",
      userId: "owner",
      body: "stop",
      signal: "stop",
      createdAt: new Date(Date.now()).toISOString(),
    },
  };
  assert.equal((await post(late, "runtime-session-late")).status, 200);
  await until(
    () =>
      db
        .query<{ handled: number }, []>(
          "SELECT handled FROM inbox_event WHERE delivery_id='runtime-session-late'",
        )
        .get()?.handled === 1,
  );
  assert.equal(getWorkItem(db, itemId)!.state, "cancelled");
  observe("Signed Stop replay drains without reconciling or reviving its stopped epic", {
    cancelled: true,
    handled: true,
  });
  const terminal = insertQueuedItem(db, {
    id: "runtime-terminal",
    sessionKey: "runtime-terminal-session",
  });
  for (const nextSession of ["runtime-terminal-session", "runtime-fresh-session"])
    recordLinearInstallation(db, {
      sessionId: nextSession,
      organizationId: "org",
      teamId: "team",
      oauthClientId: "client",
      appUserId: "app",
      observedAtMs: Date.now(),
    });
  bindLinearSessionTask(db, "runtime-terminal-session", terminal.epicId, { actorId: "owner" });
  applyWorkItemEvent(db, terminal.id, "cancel");
  db.run("UPDATE epic SET state='done' WHERE id=?", [terminal.epicId]);
  const store = createInboxStore(db);
  const replayKeys = [];
  for (const [nextSession, body] of [
    [sessionId, "stop"],
    ["runtime-terminal-session", " "],
    ["runtime-fresh-session", " "],
  ] as const) {
    const dedupeKey = `runtime-replay:${nextSession}`;
    replayKeys.push(dedupeKey);
    store.commit({
      dedupeKey,
      deliveryId: null,
      source: "poll",
      action: "prompted",
      sessionId: nextSession,
      issueId: "runtime-issue",
      activityId: nextSession === sessionId ? "runtime-session-late" : dedupeKey,
      actorId: "owner",
      activityCreatedAtMs: Date.now(),
      body,
      signal: nextSession === sessionId ? "stop" : null,
      updatedAtMs: Date.now(),
      payload: JSON.stringify({ actorId: "owner", activityCreatedAtMs: Date.now(), body }),
    });
  }
  await input.catchUp();
  assert(
    replayKeys.every(
      (key) =>
        db
          .query<{ handled: number }, [string]>(
            "SELECT handled FROM inbox_event WHERE dedupe_key=?",
          )
          .get(key)?.handled === 1,
    ),
  );
  assert.equal(getWorkItem(db, itemId)!.state, "cancelled");
  assert.equal(getLinearSession(db, "runtime-fresh-session")!.stoppedAt, null);
  observe(
    "Production catch-up drains stopped and terminal session replays before delivering a fresh session activity",
    { handled: replayKeys.length, oldCancelled: true, freshSessionActive: true },
  );
}
