import { afterEach, expect, test } from "bun:test";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { rmSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import {
  consumeWorkspaceBootstrap,
  JobLoop,
  OutboxDispatcher,
  putWorkspaceUser,
  recordLinearInstallation,
  recordRunnerCapacity,
  recordRunnerHostStatus,
  runnerOccupancy,
  syncWorkspaceMember,
} from "../src/db";
import {
  issueWorkspaceBootstrap,
  issueWorkspaceSession,
  workspaceId,
  workspaceTokenHash,
  WORKSPACE_COOKIE,
} from "../src/workspace";
import {
  acceptSlackMention,
  createSlackLinkPage,
  createSlackThreads,
  handleSlackWebhook,
  SLACK_THREAD_JOB,
  slackReplyAllowedSteps,
  slackRunnerModel,
} from "../src/slack";
import { createRunnerHelpers } from "../src/runner-helpers";
import { createSlackReplies } from "../src/runner-backend";
import { createRunnerPlacement } from "../src/runner-placement";
import { MINIMUM_RUNNER_VERSION, SLACK_REPLY_RUNNER_VERSION } from "../src/runner-protocol";
import { replaceScopedCredentialSteps } from "../src/credentials";
import { pawsPaths } from "../src/config";
import { tempHome } from "./helpers";
import { sqlRows, sqlRun, tempStore } from "./pglite";
import { signInFixtureRunner } from "./pglite-fixtures";

const ORIGIN = "https://paws.example";
const SECRET = "signing-secret";
const BOT = "UPAWS";
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

type Posted = { method: string; body: Record<string, unknown> };

async function fixture() {
  const home = tempHome();
  const { db, close } = await tempStore();
  cleanup.push(close, () => rmSync(home, { recursive: true, force: true }));
  let now = Date.now();
  const clock = { now: () => now, mono: () => now };
  const shared: Record<string, boolean> = { C0ONE: false, C0TWO: false };
  const posted: Posted[] = [];
  const calls: string[] = [];
  const failNext: Record<string, "rate" | "lost" | "error" | "down" | undefined> = {};
  const slackFetch = async (url: string, init?: RequestInit) => {
    const method = url.replace("https://slack.com/api/", "");
    calls.push(method);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const fail = failNext[method];
    failNext[method] = undefined;
    if (fail === "rate") return new Response("", { status: 429, headers: { "retry-after": "7" } });
    if (fail === "down") return new Response("", { status: 503 });
    if (fail === "error") return Response.json({ ok: false, error: "missing_scope" });
    if (method === "conversations.info") {
      const external = shared[body.channel as string];
      if (external === undefined) return Response.json({ ok: false, error: "channel_not_found" });
      const flags = { is_shared: external, is_ext_shared: external, is_org_shared: false };
      return Response.json({ ok: true, channel: { id: body.channel, is_channel: true, ...flags } });
    }
    if (method === "conversations.replies")
      return Response.json({
        ok: true,
        messages: posted
          .filter((post) => post.method === "chat.postMessage")
          .map((post) => ({ metadata: post.body.metadata })),
      });
    posted.push({ method, body });
    if (fail === "lost") throw new Error("socket hang up");
    return Response.json({ ok: true });
  };
  const prompts: { userId: string; prompt: string }[] = [];
  const helpers = createRunnerHelpers({
    store: db,
    keyId: "fixture",
    privateKey: generateKeyPairSync("ed25519").privateKey,
    slack: (q, input) => slackReplyAllowedSteps(q, home, input),
  });
  const lane = createSlackReplies({
    store: db,
    helpers,
    placement: createRunnerPlacement({ store: db }),
    pollIntervalMs: 1,
  });
  const runner = { hold: false, stopped: false };
  const answered = new Set<string>();
  const loop = (async () => {
    while (!runner.stopped) {
      await Bun.sleep(2);
      if (runner.hold) continue;
      const open = await sqlRows<{ id: string; runner_id: string }>(
        db,
        "SELECT id, runner_id FROM runner_helper WHERE purpose='slack_reply' AND ended_at IS NULL AND result IS NULL",
      ).catch(() => []);
      for (const row of open) {
        if (answered.has(row.id)) continue;
        answered.add(row.id);
        const { command } = await helpers.current(row.id).catch(() => ({ command: null }));
        if (command?.type !== "helper" || !command.slack) continue;
        prompts.push({ userId: command.slack.memberUserId, prompt: command.prompt });
        await helpers.acknowledge(row.runner_id, command.id).catch(() => undefined);
        await helpers
          .submit(row.runner_id, {
            executionId: workspaceId(),
            commandId: command.id,
            ...(command.account ? { account: command.account } : {}),
            role: "implementer",
            stopReason: "end_turn",
            cancelled: false,
            timedOut: false,
            authRequired: false,
            agentExited: true,
            text: `answer ${prompts.length}`,
          })
          .catch(() => undefined);
      }
    }
  })();
  cleanup.unshift(async () => {
    runner.stopped = true;
    await loop;
  });
  const threads = createSlackThreads({
    store: db,
    home,
    env: {},
    origin: ORIGIN,
    fetch: slackFetch,
    now: () => now,
    model: slackRunnerModel(
      async () => lane,
      () => ({ agent: "codex" as const, model: null }),
    ),
  });
  const jobs = new JobLoop(db, clock, { backoffBaseMs: 10 });
  jobs.register(SLACK_THREAD_JOB, (job, context) => threads.handle(job, context));
  const outbox = new OutboxDispatcher(db, clock, { backoffBaseMs: 10 });
  outbox.setHandler((row, context) => threads.deliver(row, context));
  const linkPage = createSlackLinkPage({ store: db, now: () => now });
  const cookies: Record<string, string> = {};

  async function workspace(id: string, team: string, users: Record<string, "admin" | "member">) {
    for (const user of Object.keys(users))
      await putWorkspaceUser(db, {
        id: user,
        linearUserId: user,
        name: user,
        email: "u@x.invalid",
      });
    const tokenHash = workspaceTokenHash(await issueWorkspaceBootstrap(db, id, now));
    const userId = Object.keys(users)[0]!;
    await consumeWorkspaceBootstrap(db, {
      id,
      organizationId: id,
      name: id,
      userId,
      tokenHash,
      now,
    });
    for (const [user, role] of Object.entries(users)) {
      const at = { workspaceId: id, userId: user, now };
      await syncWorkspaceMember(db, { ...at, role, active: true, teamIds: [] });
      cookies[user] = `${WORKSPACE_COOKIE}=${(await issueWorkspaceSession(db, at)).token}`;
      await addRunner(id, user, SLACK_REPLY_RUNNER_VERSION.join("."));
    }
    await install(id, team);
  }
  async function addRunner(workspaceId: string, owner: string, version: string) {
    const runnerId = `runner-${owner}`;
    const at = Date.now();
    await sqlRun(
      db,
      "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES(?,?,?,?,'active',?,?) ON CONFLICT (id) DO NOTHING",
      [runnerId, workspaceId, owner, runnerId, at, at],
    );
    await recordRunnerCapacity(db, runnerId, 1, 1, 2);
    await signInFixtureRunner(db, runnerId, "codex");
    await recordRunnerHostStatus(db, runnerId, { runnerVersion: version }, at);
    return runnerId;
  }
  async function install(id: string, team: string) {
    const dir = pawsPaths(home).secretsDir;
    const token = JSON.stringify({
      accessToken: `xoxb-${team}`,
      refreshToken: null,
      expiresAtMs: null,
      scope: "app_mentions:read,channels:history,channels:read,chat:write",
      teamId: team,
      botUserId: BOT,
      appId: "A1",
    });
    await db.run((q) =>
      q.exec(q.orm.delete(q.t.credential).where(eq(q.t.credential.kind, "slack"))),
    );
    await Bun.sleep(2);
    await db.transaction(function* (q) {
      yield* replaceScopedCredentialSteps(
        q,
        dir,
        { kind: "slack", workspace: `team:${team}` },
        id,
        0,
      );
      yield* replaceScopedCredentialSteps(q, dir, { kind: "slack", workspace: id }, token, 0);
    });
  }

  let events = 0;
  let ts = 1_700_000_000;
  async function deliver(
    event: Record<string, unknown>,
    options: { team?: string; eventId?: string; signature?: string; at?: number } = {},
  ) {
    const raw = JSON.stringify({
      type: "event_callback",
      team_id: options.team ?? "T0ONE",
      api_app_id: "A1",
      event_id: options.eventId ?? `Ev${String(++events).padStart(6, "0")}`,
      is_ext_shared_channel: false,
      event,
    });
    const time = String(Math.floor((options.at ?? now) / 1000));
    const signature =
      options.signature ??
      `v0=${createHmac("sha256", SECRET).update(`v0:${time}:${raw}`).digest("hex")}`;
    const request = new Request(`${ORIGIN}/webhooks/slack`, {
      method: "POST",
      headers: { "x-slack-signature": signature, "x-slack-request-timestamp": time },
      body: raw,
    });
    return handleSlackWebhook(request, SECRET, now, undefined, (mention) =>
      acceptSlackMention(db, home, mention, now),
    );
  }
  const mention = (user: string, text: string, extra: Record<string, unknown> = {}) => ({
    type: "app_mention",
    channel: "C0ONE",
    user,
    text: `<@${BOT}> ${text}`,
    ts: `${++ts}.000100`,
    ...extra,
  });
  async function runJobs() {
    while (await jobs.tick([SLACK_THREAD_JOB])) {}
  }
  async function settle() {
    for (let round = 0; round < 4; round++) {
      await runJobs();
      await outbox.tick();
      await outbox.idle();
    }
  }
  async function code(user: string | null) {
    const headers: Record<string, string> = user ? { cookie: cookies[user]! } : {};
    const response = (await linkPage(new Request(`${ORIGIN}/oauth/slack/link`, { headers })))!;
    return {
      status: response.status,
      code: /link ([A-Z2-7]{4}-[A-Z2-7]{4})/.exec(await response.text())?.[1],
    };
  }
  async function link(user: string, slackUser: string, channel = "C0ONE") {
    const issued = (await code(user)).code!;
    await deliver(mention(slackUser, `link ${issued}`, { channel }));
    await settle();
    return issued;
  }
  const posts = (method: string) => posted.filter((post) => post.method === method);
  const lastNotice = () => String(posts("chat.postEphemeral").at(-1)?.body.text);
  const replies = () =>
    db.run((q) =>
      q.all(
        q.orm
          .select()
          .from(q.t.outbox)
          .where(and(eq(q.t.outbox.target, "slack"), eq(q.t.outbox.op, "chat.postMessage")))
          .orderBy(q.t.outbox.id),
      ),
    );
  const sideEffects = () =>
    db.run(function* (q) {
      return {
        workItems: (yield* q.all(q.orm.select().from(q.t.workItem))).length,
        reservations: (yield* q.all(q.orm.select().from(q.t.runnerReservation))).length,
        helpers: (yield* q.all(q.orm.select().from(q.t.runnerHelper))).filter(
          (row) => row.purpose !== "slack_reply",
        ).length,
        linear: (yield* q.all(
          q.orm.select().from(q.t.outbox).where(eq(q.t.outbox.target, "linear")),
        )).length,
        otherJobs: (yield* q.all(q.orm.select().from(q.t.job)))
          .map((row) => row.queue)
          .filter((queue) => queue !== SLACK_THREAD_JOB && queue !== "agent.usage.after-run"),
      };
    });
  return {
    db,
    shared,
    posted,
    calls,
    failNext,
    prompts,
    workspace,
    install,
    addRunner,
    runner,
    helpers,
    deliver,
    mention,
    runJobs,
    settle,
    code,
    link,
    posts,
    lastNotice,
    replies,
    sideEffects,
    advance: (ms: number) => (now += ms),
    revoke: (userId: string) =>
      syncWorkspaceMember(db, {
        workspaceId: "W1",
        userId,
        role: "member",
        active: false,
        teamIds: [],
        now,
      }),
  };
}

async function linked() {
  const f = await fixture();
  await f.workspace("W1", "T0ONE", { ua: "admin", um: "member" });
  await f.link("ua", "SADMIN");
  expect(f.lastNotice()).toContain("Linked");
  f.posted.length = 0;
  return f;
}

const NONE = { workItems: 0, reservations: 0, helpers: 0, linear: 0, otherJobs: [] };

test("an admin sets up the channel from Slack with a code only they can post", async () => {
  const f = await fixture();
  await f.workspace("W1", "T0ONE", { ua: "admin", um: "member" });
  await f.deliver(f.mention("SADMIN", "hello"));
  await f.settle();
  expect(f.posts("chat.postEphemeral")[0]!.body).toMatchObject({
    channel: "C0ONE",
    user: "SADMIN",
  });
  expect(f.lastNotice()).toContain(`${ORIGIN}/oauth/slack/link`);
  expect(f.lastNotice()).toContain("must be a Paws workspace admin");
  expect(await f.code(null)).toEqual({ status: 401, code: undefined });

  await f.link("um", "SMEMBER");
  expect(f.lastNotice()).toContain("must be a Paws workspace admin");
  const issued = await f.link("ua", "SADMIN");
  expect(f.lastNotice()).toContain("Linked");
  await f.deliver(f.mention("SOTHER", `link ${issued}`));
  await f.settle();
  expect(f.lastNotice()).toContain("expired");
  const notices = f.posts("chat.postEphemeral").length;
  await f.link("um", "SMEMBER", "C0TWO");
  expect(f.posts("chat.postEphemeral")).toHaveLength(notices);
  const late = (await f.code("um")).code!;
  f.advance(11 * 60_000);
  await f.deliver(f.mention("SMEMBER", `link ${late}`));
  await f.settle();
  expect(f.lastNotice()).toContain("expired");

  expect(f.prompts).toEqual([]);
  expect(f.posts("chat.postMessage")).toEqual([]);
  expect(await f.sideEffects()).toEqual(NONE);
});

test("a linked member's mentions get one reply each in the thread, with its context", async () => {
  const f = await linked();
  const first = f.mention("SADMIN", "what is a monad?");
  await f.deliver(first);
  await f.settle();
  await f.deliver(f.mention("SADMIN", "and a functor?", { thread_ts: first.ts }));
  await f.settle();
  expect(f.prompts.map((turn) => turn.userId)).toEqual(["ua", "ua"]);
  expect(f.prompts[1]!.prompt).toContain("what is a monad?");
  expect(f.prompts[1]!.prompt).toContain("[Paws]: answer 1");
  expect(f.posts("chat.postMessage").map((post) => [post.body.thread_ts, post.body.text])).toEqual([
    [first.ts, "answer 1"],
    [first.ts, "answer 2"],
  ]);
  expect(await f.sideEffects()).toEqual(NONE);
});

test("only an explicit mention from a linked member in the channel starts a turn", async () => {
  const f = await linked();
  const root = f.mention("SADMIN", "start");
  await f.deliver(root);
  await f.settle();
  f.posted.length = 0;
  const unmentioned = { type: "message", channel: "C0ONE", user: "SADMIN", text: "thanks" };
  await f.deliver({ ...unmentioned, ts: "1800000000.000001", thread_ts: root.ts });
  await f.deliver(f.mention("SADMIN", "bot", { bot_id: "B9" }));
  await f.deliver(f.mention("SADMIN", "elsewhere", { channel: "C0TWO" }));
  await f.deliver(f.mention("SADMIN", "other team"), { team: "T0NINE" });
  await f.deliver({ ...f.mention("SADMIN", "x"), text: "<@UOTHER> hi" });
  const forged = await f.deliver(f.mention("SADMIN", "f"), { signature: `v0=${"0".repeat(64)}` });
  const stale = await f.deliver(f.mention("SADMIN", "s"), { at: Date.now() - 600_000 });
  expect([forged.status, stale.status]).toEqual([401, 401]);
  await f.deliver(f.mention("SMEMBER", "unlinked"));
  await f.settle();
  expect(f.prompts).toHaveLength(1);
  expect(f.posts("chat.postMessage")).toEqual([]);
  expect(f.posts("chat.postEphemeral").map((post) => post.body.user)).toEqual(["SMEMBER"]);
});

test("duplicate and concurrent deliveries and a rerun turn keep one reply", async () => {
  const f = await linked();
  const event = f.mention("SADMIN", "once");
  await Promise.all([
    f.deliver(event, { eventId: "EvDUP001" }),
    f.deliver(event, { eventId: "EvDUP001" }),
  ]);
  await f.settle();
  await f.deliver(event, { eventId: "EvDUP002" });
  await f.settle();
  expect(f.prompts).toHaveLength(1);
  expect(f.posts("chat.postMessage")).toHaveLength(1);
  expect(await f.replies()).toHaveLength(1);
});

test("an uncertain send is reconciled, a rate limit waits, and an unreadable thread is not resent", async () => {
  const f = await linked();
  f.failNext["chat.postMessage"] = "lost";
  await f.deliver(f.mention("SADMIN", "careful"));
  await f.settle();
  f.advance(60_000);
  await f.settle();
  expect(f.calls).toContain("conversations.replies");
  expect(f.posts("chat.postMessage")).toHaveLength(1);

  f.calls.length = 0;
  f.failNext["chat.postMessage"] = "rate";
  await f.deliver(f.mention("SADMIN", "busy"));
  await f.settle();
  expect((await f.replies())[1]).toMatchObject({ status: "pending" });
  expect((await f.replies())[1]!.notBefore).toBeGreaterThanOrEqual(Date.now() + 6_000);
  f.advance(8_000);
  await f.settle();
  expect(f.calls).not.toContain("conversations.replies");
  expect(f.posts("chat.postMessage")).toHaveLength(2);

  f.failNext["chat.postMessage"] = "lost";
  await f.deliver(f.mention("SADMIN", "lost"));
  await f.settle();
  f.failNext["conversations.replies"] = "error";
  f.advance(60_000);
  await f.settle();
  expect((await f.replies())[2]).toMatchObject({ status: "pending" });
  expect(f.posts("chat.postMessage")).toHaveLength(3);
});

test("a transient channel lookup failure retries instead of dropping the mention", async () => {
  const f = await linked();
  f.failNext["conversations.info"] = "down";
  await f.deliver(f.mention("SADMIN", "retry me"));
  await f.settle();
  expect(f.prompts).toHaveLength(0);
  f.advance(60_000);
  await f.settle();
  expect(f.posts("chat.postMessage")).toHaveLength(1);
});

test("revocation, a shared channel or a reinstall before delivery withholds the reply", async () => {
  for (const change of ["member", "channel", "reinstall"] as const) {
    const f = await linked();
    await f.deliver(f.mention("SADMIN", "late canary-7"));
    await f.runJobs();
    expect(await f.replies()).toHaveLength(1);
    if (change === "member") await f.revoke("ua");
    if (change === "channel") f.shared.C0ONE = true;
    if (change === "reinstall") {
      f.advance(5_000);
      await f.install("W1", "T0ONE");
    }
    await f.settle();
    expect(f.posts("chat.postMessage")).toEqual([]);
  }
});

test("a reinstall invalidates old links, and a revoked member gets no turn", async () => {
  const f = await linked();
  await f.install("W1", "T0ONE");
  await f.deliver(f.mention("SADMIN", "after reinstall"));
  await f.settle();
  expect(f.prompts).toHaveLength(0);
  expect(f.lastNotice()).toContain("open");

  const g = await linked();
  await g.revoke("ua");
  await g.deliver(g.mention("SADMIN", "revoked"));
  await g.settle();
  expect(g.prompts).toHaveLength(0);
  expect(g.posted).toEqual([]);
});

test("one thread's context never reaches another thread or member", async () => {
  const f = await linked();
  await f.link("um", "SMEMBER");
  await f.deliver(f.mention("SADMIN", "private canary-42"));
  await f.settle();
  await f.deliver(f.mention("SMEMBER", "what was said?"));
  await f.settle();
  expect(f.prompts.at(-1)!.userId).toBe("um");
  expect(f.prompts.at(-1)!.prompt).not.toContain("canary-42");
});

test("a reply runs in the conversation lane while every implementation slot is taken", async () => {
  const f = await linked();
  await recordLinearInstallation(f.db, {
    organizationId: "W1",
    oauthClientId: "app",
    appUserId: "app-user",
    sessionId: "session-1",
    teamId: "team",
    observedAtMs: Date.now(),
  });
  await f.helpers.dispatch({
    runnerId: "runner-ua",
    sessionId: "session-1",
    purpose: "classify",
    profile: { agent: "codex", model: null },
    prompt: "Classify this request",
  });
  const full = { capacity: 1, occupied: 1 };
  expect(await runnerOccupancy(f.db, "runner-ua", Date.now())).toEqual(full);
  await f.deliver(f.mention("SADMIN", "busy runner?"));
  await f.settle();
  expect(f.posts("chat.postMessage").map((post) => post.body.text)).toEqual(["answer 1"]);
  expect(await runnerOccupancy(f.db, "runner-ua", Date.now())).toEqual(full);
  expect(await f.sideEffects()).toEqual({ ...NONE, helpers: 1 });
});

test("a runner too old for Slack replies, or none at all, answers nothing", async () => {
  const f = await linked();
  await f.addRunner("W1", "ua", MINIMUM_RUNNER_VERSION.join("."));
  await f.deliver(f.mention("SADMIN", "old runner"));
  await f.settle();
  await f.db.run((q) => q.exec(q.orm.update(q.t.runner).set({ status: "revoked" })));
  await f.deliver(f.mention("SADMIN", "no runner"));
  await f.settle();
  expect(f.prompts).toEqual([]);
  expect(f.posted).toEqual([]);
});

test("revoking the member while the runner answers fences the reply", async () => {
  const f = await linked();
  f.runner.hold = true;
  await f.deliver(f.mention("SADMIN", "in flight canary-9"));
  const pending = f.settle();
  for (let tick = 0; tick < 500; tick++) {
    const open = await f.db.run((q) => q.all(q.orm.select().from(q.t.runnerHelper)));
    if (open.length > 0) break;
    await Bun.sleep(2);
  }
  await f.revoke("ua");
  f.runner.hold = false;
  await pending;
  expect(f.posted).toEqual([]);
  expect(await f.replies()).toEqual([]);
});
