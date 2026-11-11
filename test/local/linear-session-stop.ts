import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { FakeClock, JOB_KIND } from "../../src/core";
import {
  openDatabase,
  migrate,
  insertQueuedItem,
  beginImplementRun,
  applyWorkItemEvent,
  ensureLinearSession,
  getWorkItem,
  getLinearSession,
  enqueueCommand,
  enqueueJob,
  JobLoop,
  listJobs,
  listOutbox,
  OutboxDispatcher,
  recordItemPullRequest,
  sqliteDb,
} from "../../src/db";
import {
  createInboxStore,
  createIntakePollSource,
  startCatchUpPoller,
  handleLinearWebhook,
} from "../../src/linear";
import { Orchestrator } from "../../src/loop";

export async function probeLinearSessionStop(root: string) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const db = openDatabase(join(root, "paws.db"));
  migrate(db);
  const clock = new FakeClock(10_000);
  const jobs = new JobLoop(db, clock);
  let joined = 0;
  const orchestrator = new Orchestrator({
    store: sqliteDb(db),
    jobs,
    clock,
    outbox: new OutboxDispatcher(db, clock),
    pawsRoot: root,
    home: root,
    launch: () => {
      throw new Error("No agent should launch during Stop");
    },
  });
  const observations = [];
  try {
    for (const field of ["dismissedAt", "archivedAt", "stopping"] as const) {
      const old = await insertQueuedItem(db, { id: `old-${field}`, sessionKey: `old-${field}` });
      await beginImplementRun(sqliteDb(db), old.id, clock.now());
      await applyWorkItemEvent(sqliteDb(db), old.id, "blocking_question");
      const replacement = await insertQueuedItem(db, {
        id: `new-${field}`,
        sessionKey: `new-${field}`,
      });
      await ensureLinearSession(sqliteDb(db), {
        sessionId: old.sessionKey!,
        issueId: old.linearIssueId,
        organizationId: "organization",
        appUserId: "app",
        creatorId: "user",
        now: 1,
      });
      const store = createInboxStore(sqliteDb(db));
      await store.commit({
        dedupeKey: `session:${old.sessionKey}:created`,
        deliveryId: null,
        source: "poll",
        action: "created",
        sessionId: old.sessionKey,
        issueId: old.linearIssueId,
        activityId: null,
        body: null,
        signal: null,
        updatedAtMs: 1,
        payload: "{}",
      });
      await store.markHandled(`session:${old.sessionKey}:created`);
      let slept!: () => void;
      const sleeping = new Promise<void>((resolve) => {
        slept = resolve;
      });
      const source = createIntakePollSource(
        {
          async query(query) {
            assert.ok(query.includes("includeArchived: true"));
            const stamp = new Date(9_000).toISOString();
            const oldSession = {
              id: old.sessionKey,
              status: field === "stopping" ? "stopping" : "awaitingInput",
              createdAt: new Date(1).toISOString(),
              updatedAt: stamp,
              ...(field !== "stopping" ? { [field]: stamp } : {}),
              appUser: { id: "app" },
              issue: { id: old.linearIssueId, team: { id: "team" } },
            };
            const newSession = {
              id: replacement.sessionKey,
              createdAt: stamp,
              updatedAt: stamp,
              appUser: { id: "app" },
              issue: { id: old.linearIssueId, team: { id: "team" } },
            };
            return { viewer: { id: "app" }, agentSessions: { nodes: [newSession, oldSession] } };
          },
        },
        { teamId: "team" },
      );
      let release!: () => void;
      const poller = startCatchUpPoller({
        source,
        store,
        db,
        now: () => clock.now(),
        sleeper: {
          wait: () =>
            new Promise<void>((r) => {
              release = r;
              slept();
            }),
          wake: () => release?.(),
        },
        onEvent: async (event) => {
          if (event.signal === "stop") {
            await orchestrator.onLinearEvent(event);
            joined++;
          }
        },
        submitCommand: async (command) => {
          assert.equal(command.itemId, old.id);
        },
      });
      await sleeping;
      await poller.pollNow();
      await poller.stop();
      assert.equal((await getWorkItem(sqliteDb(db), old.id))?.state, "paused");
      assert.equal((await getLinearSession(sqliteDb(db), old.sessionKey!))?.stoppedAt, 9_000);
      assert.equal((await getWorkItem(sqliteDb(db), replacement.id))?.state, "queued");
      observations.push({
        case: field,
        oldStopped: true,
        replacementPreserved: true,
        passed: true,
      });
    }
    const queued = await insertQueuedItem(db, { id: "queued-stop" });
    await enqueueCommand(sqliteDb(db), {
      type: "stop",
      source: "linear",
      itemId: queued.id,
      requestedAt: clock.now(),
    });
    await jobs.tick();
    assert.equal((await getWorkItem(sqliteDb(db), queued.id))?.state, "paused");
    observations.push({ case: "claimed-stop-job", passed: true });
    assert.equal(joined, 3);
    for (const field of ["stop", "archivedAt", "dismissedAt", "stopping"] as const) {
      const old = await insertQueuedItem(db, {
        id: `webhook-${field}`,
        sessionKey: `webhook-${field}`,
      });
      // The item waits in the merge queue with an open pull request.
      for (const step of ["dispatched", "turn_ended", "closeout_accepted"] as const)
        await applyWorkItemEvent(sqliteDb(db), old.id, step);
      await recordItemPullRequest(sqliteDb(db), {
        itemId: old.id,
        pullNumber: 42,
        pullUrl: null,
        openedAt: 1,
      });
      await enqueueJob(sqliteDb(db), {
        queue: JOB_KIND.merge,
        payload: { itemId: old.id },
        now: clock.now(),
      });
      const replacement = await insertQueuedItem(db, {
        id: `webhook-new-${field}`,
        sessionKey: `webhook-new-${field}`,
      });
      await ensureLinearSession(sqliteDb(db), {
        sessionId: old.sessionKey!,
        issueId: old.linearIssueId,
        organizationId: "organization",
        appUserId: "app",
        creatorId: "user",
        now: 1,
      });
      const body = JSON.stringify({
        type: "AgentSessionEvent",
        action: "prompted",
        webhookTimestamp: clock.now(),
        agentSession: {
          id: old.sessionKey,
          issueId: old.linearIssueId,
          ...(field === "stopping"
            ? { status: "stopping" }
            : field !== "stop"
              ? { [field]: new Date(clock.now()).toISOString() }
              : {}),
        },
        ...(field === "stop" ? { agentActivity: { id: `stop-${field}`, signal: "stop" } } : {}),
      });
      const signature = createHmac("sha256", "test-webhook-secret").update(body).digest("hex");
      let done: Promise<unknown> = Promise.resolve();
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request) =>
          handleLinearWebhook(request, "test-webhook-secret", {
            store: createInboxStore(sqliteDb(db)),
            now: () => clock.now(),
            onEvent: (event) => {
              done = orchestrator.onLinearEvent(event);
              return done.then(() => undefined);
            },
          }),
      });
      try {
        const unsigned = await fetch(server.url, { method: "POST", body });
        assert.equal(unsigned.status, 401);
        assert.equal((await getWorkItem(sqliteDb(db), old.id))?.state, "merge_queue");
        for (let attempt = 0; attempt < 2; attempt++) {
          const response = await fetch(server.url, {
            method: "POST",
            body,
            headers: { "linear-signature": signature, "linear-delivery": `delivery-${field}` },
          });
          assert.equal(response.status, 200);
          await done;
        }
        assert.equal((await getWorkItem(sqliteDb(db), old.id))?.state, "paused");
        assert.equal((await getWorkItem(sqliteDb(db), replacement.id))?.state, "queued");
        // A stop or archive from Linear leaves the pull request and the issue status alone.
        assert.ok(
          !(await listJobs(sqliteDb(db))).some(
            (job) =>
              job.queue === JOB_KIND.closeStoppedPull &&
              (job.payload as { itemId?: string }).itemId === old.id,
          ),
        );
        const sessionRows = (await listOutbox(sqliteDb(db))).filter(
          (row) => row.orderingKey === old.sessionKey,
        );
        assert.ok(!sessionRows.some((row) => row.op === "status"));
        assert.ok(
          (await listOutbox(sqliteDb(db))).every(
            (row) => row.op !== "status" || (row.payload as { itemId?: string }).itemId !== old.id,
          ),
        );
        assert.ok(
          sessionRows.some(
            (row) =>
              (row.payload as { body?: string }).body ===
              "Paused. Reply here or re-delegate to continue.",
          ),
        );
        assert.ok(
          !(await listJobs(sqliteDb(db))).some(
            (job) =>
              job.queue === JOB_KIND.merge &&
              job.status === "pending" &&
              (job.payload as { itemId?: string }).itemId === old.id,
          ),
        );
        observations.push({
          case: `signed-webhook-${field}`,
          unsignedDenied: true,
          duplicateSafe: true,
          replacementPreserved: true,
          passed: true,
        });
      } finally {
        await server.stop(true);
      }
    }
    writeFileSync(join(root, "observations.json"), JSON.stringify(observations, null, 2));
    return observations;
  } finally {
    await orchestrator.shutdown();
    db.close();
  }
}
if (import.meta.main) console.log(await probeLinearSessionStop(process.argv[2]!));
