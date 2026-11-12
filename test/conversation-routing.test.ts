import { afterEach, expect, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import { generateKeyPairSync } from "node:crypto";
import { FakeClock, JOB_KIND } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  claimNextJob,
  enqueueJob,
  saveSchedulerAdmission,
  beginImplementRun,
  consumeWorkspaceBootstrap,
  enterMergeQueue,
  getLinearComment,
  getLinearSession,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  listOutbox,
  listPendingLinearTurns,
  putWorkspaceUser,
  recordLinearInstallation,
  recordRunnerCapacity,
  recordLinearTurn,
  recordRunnerHostStatus,
  runnerTaskSlots,
} from "../src/db";
import type { AcceptedLinearEvent } from "../src/linear";
import {
  CONVERSATION_TIMEOUT_REPLY,
  Orchestrator,
  START_WORK_RESPONSE,
  deliverLinearComments,
  linearCommentBrief,
  type LinearCommentPolicy,
} from "../src/loop";
import { createConversationTurns } from "../src/runner-backend";
import { createRunnerHelpers } from "../src/runner-helpers";
import { RUNNER_CONVERSATION_MS } from "../src/runner-protocol";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../src/workspace";
import { json, seed } from "./dialects";
import { tempStore } from "./pglite";

const T0 = Date.parse("2026-11-07T20:00:00.000Z");
const PASCAL = "user-pascal";
const TEAM = "team-acme";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function setup(options: { version?: string; conversations?: number } = {}) {
  const { db, close: closeDb } = await tempStore();
  const clock = new FakeClock(T0);
  const userId = await putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "owner",
    name: "Owner",
    email: "owner@acme.test",
  });
  const workspace = await consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "org-acme",
    name: "Acme",
    userId,
    tokenHash: workspaceTokenHash(await issueWorkspaceBootstrap(db, "org-acme", T0)),
    now: T0,
  });
  await seed(db, (q) =>
    q.orm.insert(q.t.runner).values({
      id: "runner",
      workspaceId: workspace.id,
      ownerUserId: userId,
      name: "Acme box",
      status: "active",
      createdAt: T0,
      lastSeenAt: T0,
    }),
  );
  await recordRunnerCapacity(db, "runner", 1, 1, options.conversations ?? 2);
  await recordRunnerHostStatus(db, "runner", { runnerVersion: options.version ?? "0.1.77" }, T0);
  const helpers = createRunnerHelpers({
    store: db,
    keyId: "acme",
    privateKey: generateKeyPairSync("ed25519").privateKey,
    now: () => clock.now(),
  });
  const policy: LinearCommentPolicy = {
    appUserId: "paws-app",
    agents: [],
    authorize: async (actor) => actor.id === PASCAL,
    wait: () => ({ quietMs: 0, maxMs: 0 }),
  };
  const orchestrator = new Orchestrator({
    store: db,
    clock,
    jobs: new JobLoop(db, clock),
    outbox: new OutboxDispatcher(db, clock),
    pawsRoot: "/nonexistent-paws-root",
    linearComments: policy,
    conversations: async () =>
      createConversationTurns({ store: db, helpers, now: () => clock.now() }),
  });
  cleanup.push(async () => {
    await orchestrator.shutdown();
    await closeDb();
  });

  async function item(id: string, state: "merge_queue" | "running" | "queued" = "merge_queue") {
    const session = `ses-${id}`;
    await insertQueuedItem(db, { id, now: T0, sessionKey: session });
    await recordLinearInstallation(db, {
      organizationId: "org-acme",
      oauthClientId: "app",
      appUserId: "paws-app",
      sessionId: session,
      teamId: TEAM,
      observedAtMs: T0,
    });
    const { run } = await beginImplementRun(db, id, T0);
    const command = `command-${id}`;
    const payload = Buffer.from(
      JSON.stringify({
        runnerId: "runner",
        runId: run.id,
        profile: { agent: "claude", model: "acme-model" },
      }),
    ).toString("base64url");
    const ended = state === "running" ? null : T0;
    await seed(
      db,
      (q) =>
        q.orm.insert(q.t.runnerWork).values({
          runId: run.id,
          runnerId: "runner",
          workspaceId: workspace.id,
          generation: 1,
          runnerFence: 0,
          commandId: command,
          leaseUntil: T0 + 3_600_000,
          endedAt: ended,
          teardownConfirmedAt: ended,
        }),
      (q) =>
        q.orm.insert(q.t.runnerCommand).values({
          id: command,
          runnerId: "runner",
          runId: run.id,
          generation: 1,
          kind: "run",
          envelope: json(db, { payload }),
          expiresAt: T0 + 3_600_000,
        }),
      (q) =>
        q.orm.insert(q.t.runnerResult).values({
          runId: run.id,
          generation: 1,
          commandId: command,
          payload: json(db, { stopReason: "end_turn", sessionId: `claude-${id}` }),
          receivedAt: T0,
        }),
    );
    if (state === "merge_queue")
      await enterMergeQueue(db, id, {
        phase: "merge_queue",
        baseSha: "b",
        wipCommit: "h",
      });
    if (state === "queued")
      await seed(db, (q) =>
        q.orm.update(q.t.workItem).set({ state: "queued" }).where(eq(q.t.workItem.id, id)),
      );
    return { id, session, runId: run.id };
  }

  function comment(itemId: string, id: string, body: string): AcceptedLinearEvent {
    const record = {
      commentId: id,
      issueId: `lin-item-${itemId}`,
      organizationId: null,
      teamId: TEAM,
      authorId: PASCAL,
      actorId: null,
      actorType: null,
      botActor: null,
      onBehalfOf: null,
      parentId: null,
      body,
      createdAtMs: T0 + 1_000,
      updatedAtMs: T0 + 1_000,
      removed: false,
    };
    return {
      dedupeKey: `comment:${id}:at:${record.updatedAtMs}`,
      deliveryId: null,
      source: "poll",
      action: "other",
      sessionId: null,
      issueId: record.issueId,
      activityId: null,
      actorId: PASCAL,
      body,
      signal: null,
      updatedAtMs: record.updatedAtMs,
      payload: JSON.stringify({ kind: "comment", comment: record }),
    };
  }

  const caps = () => orchestrator["linearCommentCapabilities"](policy);
  return {
    db,
    clock,
    orchestrator,
    helpers,
    item,
    say: async (itemId: string, id: string, body: string) => {
      expect(await orchestrator.onLinearEvent(comment(itemId, id, body))).toBe(true);
    },
    deliver: (itemId: string) => deliverLinearComments(db, itemId, caps()),
    turn: async (session: string, key: string, body: string) =>
      await recordLinearTurn(db, {
        eventKey: key,
        activityId: null,
        sessionId: session,
        actorId: PASCAL,
        body,
        payload: "{}",
        createdAtMs: clock.now(),
        now: clock.now(),
      }),
    reply: async (session: string, body: string) => {
      await recordLinearTurn(db, {
        eventKey: `turn:${session}:1`,
        activityId: null,
        sessionId: session,
        actorId: PASCAL,
        body,
        payload: "{}",
        createdAtMs: clock.now(),
        now: clock.now(),
      });
      await orchestrator["resumeLinearSession"](session);
    },
    brief: async (itemId: string) =>
      linearCommentBrief(db, (await getWorkItem(db, itemId))!, {
        now: () => clock.now(),
        policy,
      }),
    conversations: async () => {
      const rows = await db.run((q) =>
        q.all(
          q.orm
            .select({ id: q.t.runnerHelper.id, sessionId: q.t.runnerHelper.sessionId })
            .from(q.t.runnerHelper)
            .where(
              and(eq(q.t.runnerHelper.purpose, "conversation"), isNull(q.t.runnerHelper.endedAt)),
            ),
        ),
      );
      const open = await Promise.all(
        rows.map(async (row) => ({ ...row, command: (await helpers.current(row.id)).command })),
      );
      return open.sort((a, b) =>
        (a.command.conversation?.itemId ?? "").localeCompare(b.command.conversation?.itemId ?? ""),
      );
    },
    answer: (
      commandId: string,
      result: { text: string; replies?: string[]; startWork?: string; timedOut?: boolean },
    ) =>
      helpers.submit("runner", {
        executionId: "01K9ACME00000000000000000A",
        commandId,
        role: "implementer",
        stopReason: result.timedOut ? "timeout" : "end_turn",
        timedOut: result.timedOut ?? false,
        cancelled: false,
        authRequired: false,
        agentExited: true,
        text: result.text,
        ...(result.replies ? { replies: result.replies } : {}),
        ...(result.startWork ? { startWork: result.startWork } : {}),
      }),
    responses: async (session: string) =>
      (await listOutbox(db, session))
        .filter((row) => (row.payload as { kind: string }).kind === "response")
        .map((row) => (row.payload as { body: string }).body),
    resumes: async () => (await listJobs(db)).filter((job) => job.queue === JOB_KIND.resume),
    taskSlots: async () => await runnerTaskSlots(db, clock.now(), clock.now() - 60_000),
  };
}

test("with every work slot busy, a message on an idle item starts a conversation at once and the reply reaches the session", async () => {
  const f = await setup();
  await f.item("acme-busy", "running");
  const acme = await f.item("acme-1");
  const slots = await f.taskSlots();
  expect(slots[0]!.used).toBeGreaterThanOrEqual(slots[0]!.capacity);

  await f.say("acme-1", "c-1", "Why does checkout retry the card twice?");
  expect(await f.deliver("acme-1")).toBe("wait");

  const [started] = await f.conversations();
  expect(started!.sessionId).toBe(acme.session);
  expect(started!.command).toMatchObject({
    purpose: "conversation",
    profile: { agent: "claude", model: "acme-model" },
    conversation: { itemId: "acme-1", runId: acme.runId, resumeSessionId: "claude-acme-1" },
  });
  expect(started!.command.prompt).toContain("Why does checkout retry the card twice?");
  expect(await f.taskSlots()).toEqual(slots);
  expect((await getWorkItem(f.db, "acme-1"))!.state).toBe("merge_queue");
  expect(await f.resumes()).toEqual([]);
  expect((await getLinearComment(f.db, "c-1"))!.state).toBe("delivered");

  await f.answer(started!.id, {
    text: "Done.",
    replies: ["The gateway retries once on a network timeout; Paws does not retry."],
  });
  expect(await f.deliver("acme-1")).toBe("done");
  expect(await f.responses(acme.session)).toEqual([
    "The gateway retries once on a network timeout; Paws does not retry.",
  ]);
  expect(await f.conversations()).toEqual([]);
  expect((await getWorkItem(f.db, "acme-1"))!.state).toBe("merge_queue");
});

test("a reply in the Linear session of an idle item goes to a conversation, not a restart", async () => {
  const f = await setup();
  const acme = await f.item("acme-1");
  await f.reply(acme.session, "Is the retry covered by a test?");
  expect(await f.resumes()).toEqual([]);
  expect(await f.deliver("acme-1")).toBe("wait");
  const [started] = await f.conversations();
  expect(started!.command.prompt).toContain("Is the retry covered by a test?");
  expect(await listPendingLinearTurns(f.db, acme.session)).toEqual([]);
  expect((await getWorkItem(f.db, "acme-1"))!.state).toBe("merge_queue");
});

test("a turn that ends without a reply posts its final message as the reply", async () => {
  const f = await setup();
  const acme = await f.item("acme-1", "queued");
  await f.say("acme-1", "c-1", "Which file holds the checkout form?");
  expect(await f.deliver("acme-1")).toBe("wait");
  await f.answer((await f.conversations())[0]!.id, { text: "It is src/checkout/form.tsx." });
  expect(await f.deliver("acme-1")).toBe("done");
  expect(await f.responses(acme.session)).toEqual(["It is src/checkout/form.tsx."]);
  expect((await getWorkItem(f.db, "acme-1"))!.state).toBe("queued");
});

test("three messages on three items with a conversation limit of 2: two run and the third waits for a conversation slot", async () => {
  const f = await setup({ conversations: 2 });
  for (const id of ["acme-1", "acme-2", "acme-3"]) {
    await f.item(id);
    await f.say(id, `c-${id}`, `What does ${id} change?`);
  }
  expect(await f.deliver("acme-1")).toBe("wait");
  expect(await f.deliver("acme-2")).toBe("wait");
  expect(await f.deliver("acme-3")).toBe("wait");
  expect((await f.conversations()).map((row) => row.command.conversation?.itemId)).toEqual([
    "acme-1",
    "acme-2",
  ]);
  expect((await getLinearComment(f.db, "c-acme-3"))!.state).toBe("queued");
  expect(await f.resumes()).toEqual([]);

  await f.answer((await f.conversations())[0]!.id, { text: "acme-1 renames the flag." });
  expect(await f.deliver("acme-1")).toBe("done");
  expect(await f.deliver("acme-3")).toBe("wait");
  expect((await f.conversations()).map((row) => row.command.conversation?.itemId)).toEqual([
    "acme-2",
    "acme-3",
  ]);
  expect(await f.resumes()).toEqual([]);
});

test("a timeout posts the timeout reply once and keeps the session", async () => {
  const f = await setup();
  const acme = await f.item("acme-1");
  await f.say("acme-1", "c-1", "Walk me through the whole payment flow.");
  expect(await f.deliver("acme-1")).toBe("wait");
  await f.answer((await f.conversations())[0]!.id, { text: "Still reading", timedOut: true });
  expect(await f.deliver("acme-1")).toBe("done");
  expect(await f.deliver("acme-1")).toBe("done");
  expect(await f.responses(acme.session)).toEqual([CONVERSATION_TIMEOUT_REPLY]);
  expect((await getLinearSession(f.db, acme.session))!.stoppedAt).toBeNull();
  expect((await getWorkItem(f.db, "acme-1"))!.state).toBe("merge_queue");
});

test("a helper that expires without a result posts the timeout reply once", async () => {
  const f = await setup();
  const acme = await f.item("acme-1");
  await f.say("acme-1", "c-1", "Walk me through the whole payment flow.");
  expect(await f.deliver("acme-1")).toBe("wait");
  expect(await f.deliver("acme-1")).toBe("wait");
  f.clock.advance(RUNNER_CONVERSATION_MS);
  expect(await f.deliver("acme-1")).toBe("done");
  expect(await f.deliver("acme-1")).toBe("done");
  expect(await f.responses(acme.session)).toEqual([CONVERSATION_TIMEOUT_REPLY]);
  expect((await getLinearSession(f.db, acme.session))!.stoppedAt).toBeNull();
});

test("a message while a work turn runs is delivered at the turn boundary, as today", async () => {
  const f = await setup();
  await f.item("acme-1", "running");
  await f.say("acme-1", "c-1", "Also cover the empty cart.");
  expect(await f.deliver("acme-1")).toBe("wait");
  expect(await f.conversations()).toEqual([]);
  expect((await f.brief("acme-1"))?.text).toContain("Also cover the empty cart.");
});

// 0.1.74 to 0.1.76 run conversations but refuse Claude's reply and start_work calls (and 0.1.74
// and 0.1.75 drop `replies` and `startWork` from the result): the turn could not act on the message.
for (const version of ["0.1.73", "0.1.75", "0.1.76"])
  test(`a runner at ${version}, which cannot return a conversation's replies or start_work, gets a follow_up restart with the message`, async () => {
    const f = await setup({ version });
    await f.item("acme-1");
    await f.say("acme-1", "c-1", "Use the v2 endpoint.");
    expect(await f.deliver("acme-1")).toBe("restarted");
    expect(await f.conversations()).toEqual([]);
    expect(await f.resumes()).toHaveLength(1);
    expect(((await f.resumes())[0]!.payload as { reason: string }).reason).toBe("follow_up");
    expect((await f.brief("acme-1"))?.text).toContain("Use the v2 endpoint.");
  });

test("a queued item's start job waits while a conversation runs on its session", async () => {
  const f = await setup();
  await f.item("acme-1", "queued");
  await f.say("acme-1", "c-1", "What is left to do?");
  expect(await f.deliver("acme-1")).toBe("wait");
  const [started] = await f.conversations();
  const jobId = await enqueueJob(f.db, {
    queue: JOB_KIND.start,
    payload: { itemId: "acme-1" },
    now: f.clock.now(),
  });
  await seed(f.db, (q) =>
    q.orm.update(q.t.run).set({ status: "ended" }).where(eq(q.t.run.itemId, "acme-1")),
  );
  await saveSchedulerAdmission(f.db, {
    itemId: "acme-1",
    jobId,
    repositoryKey: "acme/web",
    sessionId: null,
    now: f.clock.now(),
  });
  const job = (await claimNextJob(f.db, {
    now: f.clock.now(),
    queues: [JOB_KIND.start],
  }))!;
  const current = { isCurrent: async () => true };
  expect(await f.orchestrator["waitingForConversation"](job, current)).toBe(true);
  expect((await listJobs(f.db)).find((entry) => entry.id === job.id)).toMatchObject({
    status: "pending",
    attempts: job.attempts - 1,
  });
  expect((await getWorkItem(f.db, "acme-1"))!.state).toBe("queued");

  await f.answer(started!.id, { text: "Only the tests." });
  expect(await f.deliver("acme-1")).toBe("done");
  f.clock.advance(60_000);
  const again = (await claimNextJob(f.db, {
    now: f.clock.now(),
    queues: [JOB_KIND.start],
  }))!;
  expect(await f.orchestrator["waitingForConversation"](again, current)).toBe(false);
});

test("session replies past the prompt budget wait for the next conversation", async () => {
  const f = await setup();
  const acme = await f.item("acme-1");
  await f.turn(acme.session, "turn-1", `First: ${"a".repeat(40_000)}`);
  await f.turn(acme.session, "turn-2", `Second: ${"b".repeat(40_000)}`);
  expect(await f.deliver("acme-1")).toBe("wait");
  const [first] = await f.conversations();
  expect(first!.command.prompt).toContain("First:");
  expect(first!.command.prompt).not.toContain("Second:");
  expect((await listPendingLinearTurns(f.db, acme.session)).map((turn) => turn.eventKey)).toEqual([
    "turn-2",
  ]);

  await f.answer(first!.id, { text: "Read the first one." });
  expect(await f.deliver("acme-1")).toBe("wait");
  const [second] = await f.conversations();
  expect(second!.command.prompt).toContain("Second:");
  expect(await listPendingLinearTurns(f.db, acme.session)).toEqual([]);
});

test("start_work in a conversation on a 0.1.77 runner restarts the item with the plan and posts it, holding no slot while it waits", async () => {
  const f = await setup({ version: "0.1.77" });
  await f.item("acme-busy", "running");
  const acme = await f.item("acme-1");
  const slots = await f.taskSlots();
  expect(slots[0]!.used).toBeGreaterThanOrEqual(slots[0]!.capacity);
  await f.say("acme-1", "c-1", "Please add a test for the card retry.");
  expect(await f.deliver("acme-1")).toBe("wait");
  const [started] = await f.conversations();
  // The person's message goes to the agent session that the work turn resumes.
  expect(started!.command.prompt).toContain("Please add a test for the card retry.");
  expect(started!.command.conversation!.resumeSessionId).toBe("claude-acme-1");

  const plan = "Add a test that checkout retries a card once on a gateway timeout.";
  await f.answer(started!.id, { text: "", replies: ["I will add that test."], startWork: plan });
  expect(await f.deliver("acme-1")).toBe("done");
  expect(await f.deliver("acme-1")).toBe("done");

  expect(await f.responses(acme.session)).toEqual([
    "I will add that test.",
    `${START_WORK_RESPONSE}${plan}`,
  ]);
  const [resume] = await f.resumes();
  expect(await f.resumes()).toHaveLength(1);
  expect(resume!.payload).toMatchObject({ itemId: "acme-1", reason: "follow_up" });
  expect((resume!.payload as { handoff: string }).handoff).toContain(plan);
  expect((await getWorkItem(f.db, "acme-1"))!.state).toBe("queued");
  // Waiting in line holds neither a conversation nor a work slot: only acme-busy holds one.
  expect(await f.conversations()).toEqual([]);
  expect((await f.taskSlots())[0]).toMatchObject({ used: 1, capacity: 1 });
});

test("start_work after the item moved on posts that the work did not start", async () => {
  const f = await setup();
  const acme = await f.item("acme-1");
  await f.say("acme-1", "c-1", "Please rename the flag.");
  expect(await f.deliver("acme-1")).toBe("wait");
  const [started] = await f.conversations();
  await seed(f.db, (q) =>
    q.orm.update(q.t.workItem).set({ cancelRequested: 1 }).where(eq(q.t.workItem.id, "acme-1")),
  );
  await f.answer(started!.id, { text: "", startWork: "Rename the flag." });
  expect(await f.deliver("acme-1")).toBe("done");
  expect(await f.resumes()).toEqual([]);
  expect(await f.responses(acme.session)).toEqual([
    "I could not start the work: the item moved on while we talked. Reply to try again.",
  ]);
});
