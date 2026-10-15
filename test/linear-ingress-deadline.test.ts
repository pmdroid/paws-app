import { expect, spyOn, test } from "bun:test";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { systemClock } from "../src/core";
import { JobLoop, OutboxDispatcher } from "../src/db";
import {
  getLinearSessionGeneration,
  listOutbox,
  ensureLinearSession,
  enqueueOutbox,
  recordLinearInstallation,
} from "../src/db";
import {
  createFakeLinearIssueLifecycle,
  createFakeTracker,
  handleLinearWebhook,
  openLinear,
  type AcceptedLinearEvent,
  type TrackerRequestOptions,
} from "../src/linear";
import { attachOrchestrator, LinearTaskAccess } from "../src/loop";
import { tempDb, tempHome } from "./helpers";

async function delayed(release: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  try {
    await Promise.race([
      release,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function fixture() {
  const db = tempDb();
  const home = tempHome();
  const deadlines: AbortController[] = [];
  const timeout = spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    expect(ms).toBe(10_000);
    const controller = new AbortController();
    deadlines.push(controller);
    return controller.signal;
  });
  const sessionStarted = Promise.withResolvers<void>();
  const sessionRelease = Promise.withResolvers<void>();
  const otherStarted = Promise.withResolvers<void>();
  const otherRelease = Promise.withResolvers<void>();
  const teamStarted = Promise.withResolvers<void>();
  const teamRelease = Promise.withResolvers<void>();
  const activityStarted = Promise.withResolvers<AbortSignal>();
  const activityRelease = Promise.withResolvers<void>();
  const requests: string[] = [];
  const sent: { id: string; body: string }[] = [];
  let delaySession = false;
  let delayTeam = false;
  let delayActivity = false;
  let followedUp = 0;
  let followUpOperation: ((event: AcceptedLinearEvent) => Promise<void | boolean>) | undefined;
  let rejectProgress = false;
  let gate: LinearTaskAccess;
  let orchestrator: ReturnType<typeof attachOrchestrator>;
  let pending: Promise<void | boolean> | undefined;
  const scope = { organizationId: "org", oauthClientId: "client", appUserId: "app" };
  const linear = openLinear({
    db,
    secretsDir: join(home, "secrets"),
    env: { LINEAR_ACCESS_TOKEN: "fixture-token", LINEAR_CLIENT_ID: "client" },
    publicUrl: null,
    beforeEvent: (event, ...args: unknown[]) =>
      (
        gate.accept as (
          event: AcceptedLinearEvent,
          options?: TrackerRequestOptions,
        ) => Promise<boolean>
      )(event, args[0] as TrackerRequestOptions | undefined),
    progressReporter: (event) => orchestrator.sessionProgressReporter(event),
    followUp: async (event) => {
      if (event.signal === "stop") await orchestrator.onLinearEvent(event);
      else {
        followedUp++;
        await followUpOperation?.(event);
      }
    },
    async fetch(_url, init) {
      const { query, variables } = JSON.parse(String(init?.body));
      const signal = init?.signal;
      requests.push(query);
      if (query.includes("PawsSessionInstallation")) {
        if (delaySession) {
          sessionStarted.resolve();
          await delayed(sessionRelease.promise, signal!);
        }
        return Response.json({
          data: {
            viewer: { id: "app", app: true, organization: { id: "org" } },
            agentSession: {
              id: variables.id,
              appUser: { id: "app", app: true, organization: { id: "org" } },
              issue: { id: "issue", team: { id: "team" } },
            },
          },
        });
      }
      if (query.includes("PawsTeamAccess")) {
        if (delayTeam) {
          teamStarted.resolve();
          await delayed(teamRelease.promise, signal!);
        }
        signal?.throwIfAborted();
        return Response.json({ data: { team: { id: "team" } } });
      }
      if (query.includes("AgentActivityByCallerId"))
        return Response.json({
          data: { agentActivities: { nodes: [], pageInfo: { hasNextPage: false } } },
        });
      if (query.includes("AgentActivityCreate")) {
        if (rejectProgress && variables.input.content.body === "Picked up ENG-1.")
          throw new Error("Progress delivery failed");
        if (variables.input.agentSessionId === "other") {
          otherStarted.resolve();
          await delayed(otherRelease.promise, signal!);
        }
        if (
          delayActivity &&
          variables.input.agentSessionId === "session" &&
          variables.input.content.body === "Picked up this issue."
        ) {
          activityStarted.resolve(signal!);
          await delayed(activityRelease.promise, signal!);
        }
        signal?.throwIfAborted();
        sent.push({ id: variables.input.id, body: variables.input.content.body });
        return Response.json({
          data: {
            agentActivityCreate: { success: true, agentActivity: { id: variables.input.id } },
          },
        });
      }
      throw new Error("Unexpected Linear request");
    },
  });
  gate = new LinearTaskAccess(db, {
    access: linear.access,
    lifecycle: createFakeLinearIssueLifecycle({
      id: "issue",
      teamId: "team",
      assigneeId: "human",
      delegateId: "app",
      stateType: "started",
    }),
    oauthClientId: "client",
    appUserId: "app",
    stopSession() {},
  });
  const outbox = new OutboxDispatcher(db, systemClock);
  orchestrator = attachOrchestrator({
    db,
    pawsRoot: home,
    tracker: linear.tracker,
    linearAccess: gate,
    outbox,
    jobs: new JobLoop(db, systemClock),
  });
  const payload = {
    ...scope,
    type: "AgentSessionEvent",
    action: "created",
    createdAt: new Date().toISOString(),
    webhookTimestamp: Date.now(),
    agentSession: {
      ...scope,
      id: "session",
      creatorId: "human",
      issue: { id: "issue", team: { id: "team" } },
    },
  };
  return {
    db,
    outbox,
    orchestrator,
    linear,
    deadlines,
    requests,
    sent,
    sessionStarted,
    sessionRelease,
    otherStarted,
    otherRelease,
    teamStarted,
    teamRelease,
    activityStarted,
    activityRelease,
    get followedUp() {
      return followedUp;
    },
    followUp(operation: (event: AcceptedLinearEvent) => Promise<void | boolean>) {
      followUpOperation = operation;
    },
    runFollowUps() {
      const tracker = createFakeTracker([
        {
          linearIssueId: "issue",
          identifier: "ENG-1",
          title: "Early task",
          description: null,
          subIssues: [],
        },
      ]);
      orchestrator.setTracker({
        ...linear.tracker!,
        loadEpic: tracker.loadEpic,
        listDeps: tracker.listDeps,
      });
      followUpOperation = (event) => orchestrator.onLinearEvent(event);
      rejectProgress = true;
    },
    delaySession() {
      delaySession = true;
    },
    blockOtherSession() {
      ensureLinearSession(db, { sessionId: "other", issueId: "issue" });
      recordLinearInstallation(db, {
        ...scope,
        sessionId: "other",
        teamId: "team",
        observedAtMs: Date.now(),
      });
      enqueueOutbox(db, {
        target: "linear",
        op: "activity",
        orderingKey: "other",
        idempotencyKey: "other",
        payload: { sessionId: "other", kind: "thought", body: "Other session progress" },
      });
      outbox.tick();
    },
    delayTeam() {
      delayTeam = true;
    },
    delayActivity() {
      delayActivity = true;
    },
    async deliver(action: "created" | "prompted" = "created") {
      const raw = JSON.stringify({
        ...payload,
        action,
        ...(action === "prompted"
          ? { agentActivity: { id: "early", content: { type: "prompt", body: "Make it blue" } } }
          : {}),
      });
      return handleLinearWebhook(
        new Request("http://localhost/webhook", {
          method: "POST",
          body: raw,
          headers: {
            "linear-signature": createHmac("sha256", "secret").update(raw).digest("hex"),
            "linear-delivery": `${action}-delivery`,
          },
        }),
        "secret",
        {
          ...linear.webhook,
          onEvent(event) {
            pending = Promise.resolve(linear.webhook.onEvent!(event));
            return pending;
          },
        },
      );
    },
    async stop() {
      const event: AcceptedLinearEvent = {
        dedupeKey: "activity:stop",
        deliveryId: "stop-delivery",
        source: "webhook",
        action: "prompted",
        sessionId: "session",
        issueId: "issue",
        activityId: "stop",
        body: null,
        signal: "stop",
        updatedAtMs: Date.now(),
        payload: JSON.stringify({
          organizationId: "org",
          oauthClientId: "client",
          appUserId: "app",
          type: "AgentSessionEvent",
          agentSession: { id: "session", issue: { id: "issue", team: { id: "team" } } },
        }),
      };
      await linear.webhook.onEvent!(event);
    },
    async outcome() {
      return pending?.then(
        () => null,
        (error: unknown) => error,
      );
    },
    async close() {
      sessionRelease.resolve();
      otherRelease.resolve();
      teamRelease.resolve();
      activityRelease.resolve();
      await pending?.catch(() => {});
      await outbox.idle();
      timeout.mockRestore();
      db.close();
    },
  };
}

test("one initial deadline spans authoritative reads and timeout leaves the inbox retryable", async () => {
  const f = fixture();
  try {
    f.delaySession();
    f.delayTeam();
    expect((await f.deliver()).status).toBe(200);
    await f.sessionStarted.promise;
    expect(f.deadlines).toHaveLength(1);
    f.sessionRelease.resolve();
    await f.teamStarted.promise;
    expect(f.deadlines).toHaveLength(1);
    f.deadlines[0]!.abort(new Error("Initial acknowledgement deadline expired"));
    expect(await f.outcome()).toBeInstanceOf(Error);
    f.teamRelease.resolve();
    expect(f.sent).toEqual([]);
    expect(f.followedUp).toBe(0);
    expect(f.db.query("SELECT handled FROM inbox_event").get()).toEqual({ handled: 0 });
    await Bun.sleep(0);
    await f.deliver();
    expect(await f.outcome()).toBeNull();
    expect(f.sent).toHaveLength(1);
    expect(f.followedUp).toBe(1);
    expect(
      f.db.query<{ handled: number }, []>("SELECT handled FROM inbox_event").get()?.handled,
    ).toBeGreaterThan(0);
  } finally {
    await f.close();
  }
});

test("a deadline aborts the real acknowledgement transport and replay retains its durable UUID", async () => {
  const f = fixture();
  try {
    f.delayActivity();
    await f.deliver();
    const signal = await f.activityStarted.promise;
    const original = listOutbox(f.db)[0]!;
    f.deadlines[0]!.abort(new Error("Initial acknowledgement deadline expired"));
    expect(signal.aborted).toBe(true);
    expect(await f.outcome()).toBeInstanceOf(Error);
    f.activityRelease.resolve();
    expect(f.sent).toEqual([]);
    expect(f.followedUp).toBe(0);
    await f.outbox.idle();
    expect(listOutbox(f.db)[0]?.status).toBe("pending");
    f.db.run("UPDATE outbox SET not_before = 0");
    await Bun.sleep(0);
    await f.deliver();
    expect(await f.outcome()).toBeNull();
    expect(f.sent).toEqual([
      { id: (original.payload as { id: string }).id, body: "Picked up this issue." },
    ]);
    expect(f.followedUp).toBe(1);
    expect(listOutbox(f.db)).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("Stop during delayed ingress prevents the first acknowledgement after its deadline is released", async () => {
  const f = fixture();
  try {
    f.delayTeam();
    await f.deliver();
    await f.teamStarted.promise;
    await f.stop();
    expect(getLinearSessionGeneration(f.db, "session")).toBe(1);
    f.deadlines[0]!.abort(new Error("Initial acknowledgement deadline expired"));
    f.teamRelease.resolve();
    await f.outcome();
    expect(f.followedUp).toBe(0);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]?.body).toMatch(/stopp/i);
  } finally {
    await f.close();
  }
});

test("the first-activity deadline does not silence a later intake error", async () => {
  const f = fixture();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    f.followUp(async () => {
      started.resolve();
      await release.promise;
      throw new Error("Later intake failed");
    });
    await f.deliver();
    await started.promise;
    expect(f.sent).toHaveLength(1);
    f.deadlines[0]!.abort(new Error("Initial acknowledgement deadline expired"));
    release.resolve();
    await f.outcome();
    expect(f.sent.map((activity) => activity.body)).toEqual([
      "Picked up this issue.",
      "Paws could not start work on this issue. Please retry.",
    ]);
  } finally {
    release.resolve();
    await f.close();
  }
});

test("another session delivery cannot hold an expired first-acknowledgement attempt open", async () => {
  const f = fixture();
  try {
    f.blockOtherSession();
    await f.otherStarted.promise;
    const deadlineIndex = f.deadlines.length;
    f.delayActivity();
    await f.deliver();
    await f.activityStarted.promise;
    const original = listOutbox(f.db, "session")[0]!;
    let otherSettled = false;
    const others = f.outbox.idle().then(() => {
      otherSettled = true;
    });
    f.deadlines[deadlineIndex]!.abort(new Error("Initial acknowledgement deadline expired"));
    const outcome = await Promise.race([f.outcome(), Bun.sleep(100).then(() => "still pending")]);
    expect(outcome).toBeInstanceOf(Error);
    expect(otherSettled).toBe(false);
    expect(f.sent).toEqual([]);
    expect(f.followedUp).toBe(0);
    f.activityRelease.resolve();
    f.otherRelease.resolve();
    await others;
    f.db.run("UPDATE outbox SET not_before = 0");
    await Bun.sleep(0);
    await f.deliver();
    expect(await f.outcome()).toBeNull();
    expect(f.sent.filter((activity) => activity.body === "Picked up this issue.")).toEqual([
      { id: (original.payload as { id: string }).id, body: "Picked up this issue." },
    ]);
    expect(f.followedUp).toBe(1);
  } finally {
    await f.close();
  }
});

test("a signed created acknowledgement bypasses and retains dead public history from a preceding prompt", async () => {
  const f = fixture();
  try {
    f.runFollowUps();
    expect((await f.deliver("prompted")).status).toBe(200);
    expect(await f.outcome()).toBeNull();
    for (let attempt = 0; attempt < 5; attempt++) {
      f.db.run("UPDATE outbox SET not_before = 0");
      f.outbox.tick();
      await f.outbox.idle();
    }
    const progress = listOutbox(f.db, "session").find(
      (row) => (row.payload as { body: string }).body === "Picked up ENG-1.",
    )!;
    expect(progress.status).toBe("dead");
    expect(f.sent.map((activity) => activity.body)).toEqual(["Received your update."]);
    expect((await f.deliver()).status).toBe(200);
    expect(await f.outcome()).toBeNull();
    expect(f.sent.map((activity) => activity.body)).toEqual([
      "Received your update.",
      "Picked up this issue.",
    ]);
    expect(listOutbox(f.db, "session").find((row) => row.id === progress.id)?.status).toBe("dead");
    const acknowledgement = f.sent[1]!;
    await Bun.sleep(0);
    await f.deliver();
    expect(await f.outcome()).toBeNull();
    expect(f.sent.filter((activity) => activity.id === acknowledgement.id)).toEqual([
      acknowledgement,
    ]);
  } finally {
    await f.close();
  }
});

test("Stop aborts a critical first acknowledgement and prevents its later retry", async () => {
  const f = fixture();
  try {
    f.followUp((event) => f.orchestrator.onLinearEvent(event));
    f.delayActivity();
    await f.deliver();
    const signal = await f.activityStarted.promise;
    expect(listOutbox(f.db, "session")[0]?.delivery).toBe("critical");
    await f.stop();
    expect(signal.aborted).toBe(true);
    expect(await f.outcome()).toBeNull();
    f.activityRelease.resolve();
    expect(f.db.query("SELECT count(*) AS n FROM work_item").get()).toEqual({ n: 0 });
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]?.body).toMatch(/stopp/i);
    expect(listOutbox(f.db, "session")[0]?.status).toBe("dropped");
    f.db.run("UPDATE outbox SET not_before = 0");
    f.outbox.tick();
    await f.outbox.idle();
    expect(f.sent).toHaveLength(1);
  } finally {
    await f.close();
  }
});
