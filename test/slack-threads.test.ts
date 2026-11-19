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
  markSlackInstallationSteps,
  SLACK_THREAD_JOB,
  slackReplyAllowedSteps,
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
const BOT = "UPAWS";
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

type Fail = "rate" | "down" | "refused" | "lost" | "scope";

async function fixture() {
  const home = tempHome();
  const { db, close } = await tempStore();
  cleanup.push(close, () => rmSync(home, { recursive: true, force: true }));
  let now = Date.now();
  const clock = { now: () => now, mono: () => now };
  const shared: Record<string, boolean> = { C0ONE: false, C0TWO: false };
  const posted: { method: string; body: Record<string, unknown> }[] = [];
  const failNext: Record<string, Fail | undefined> = {};
  const slackFetch = async (url: string, init?: RequestInit) => {
    const method = url.replace("https://slack.com/api/", "");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const fail = failNext[method];
    failNext[method] = undefined;
    if (fail === "rate") return new Response("", { status: 429, headers: { "retry-after": "7" } });
    if (fail === "down") return new Response("", { status: 503 });
    if (fail === "refused") throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
    if (fail === "scope") return Response.json({ ok: false, error: "missing_scope" });
    if (method === "conversations.info") {
      const external = shared[body.channel as string];
      if (external === undefined) return Response.json({ ok: false, error: "channel_not_found" });
      const flags = { is_shared: external, is_ext_shared: external, is_org_shared: false };
      return Response.json({ ok: true, channel: { id: body.channel, is_channel: true, ...flags } });
    }
    posted.push({ method, body });
    if (fail === "lost") throw new Error("socket hang up");
    return Response.json({ ok: true, ts: `1800000000.${String(posted.length).padStart(6, "0")}` });
  };
  const prompts: { userId: string; prompt: string }[] = [];
  const helpers = createRunnerHelpers({
    store: db,
    keyId: "fixture",
    privateKey: generateKeyPairSync("ed25519").privateKey,
    slack: (q, input) => slackReplyAllowedSteps(q, home, input),
  });
  const placement = createRunnerPlacement({ store: db });
  const lane = createSlackReplies({ store: db, helpers, placement, pollIntervalMs: 1 });
  const runner = { hold: false, stopped: false };
  const answered = new Set<string>();
  const loop = (async () => {
    while (!runner.stopped) {
      await Bun.sleep(2);
      if (runner.hold) continue;
      const open = await sqlRows<{ id: string; runner_id: string }>(
        db,
        "SELECT id, runner_id FROM runner_helper WHERE ended_at IS NULL AND result IS NULL",
      ).catch(() => []);
      for (const row of open.filter((item) => !answered.has(item.id))) {
        answered.add(row.id);
        const { command } = await helpers.current(row.id).catch(() => ({ command: null }));
        if (command?.type !== "helper" || !command.slack) continue;
        prompts.push({ userId: command.slack.memberUserId, prompt: command.prompt });
        await helpers.acknowledge(row.runner_id, command.id).catch(() => undefined);
        const result = {
          executionId: workspaceId(),
          commandId: command.id,
          ...(command.account ? { account: command.account } : {}),
          role: "implementer" as const,
          stopReason: "end_turn" as const,
          cancelled: false,
          timedOut: false,
          authRequired: false,
          agentExited: true,
          text: `answer ${prompts.length}`,
        };
        await helpers.submit(row.runner_id, result).catch(() => undefined);
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
    replies: async () => lane,
    profile: () => ({ agent: "codex" as const, model: null }),
  });
  const jobs = new JobLoop(db, clock, { backoffBaseMs: 10 });
  jobs.register(SLACK_THREAD_JOB, (job, context) => threads.handle(job, context));
  const outbox = new OutboxDispatcher(db, clock, { backoffBaseMs: 10 });
  outbox.setTargetHandler("slack", threads.deliver);
  const linkPage = createSlackLinkPage({ store: db, home, now: () => now });
  const cookies: Record<string, string> = {};

  async function addRunner(owner: string, version: string) {
    const id = `runner-${owner}`;
    const at = Date.now();
    await sqlRun(
      db,
      "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES(?,'W1',?,?,'active',?,?) ON CONFLICT (id) DO NOTHING",
      [id, owner, id, at, at],
    );
    await recordRunnerCapacity(db, id, 1, 1, 2);
    await signInFixtureRunner(db, id, "codex");
    await recordRunnerHostStatus(db, id, { runnerVersion: version }, at);
  }
  async function install() {
    const dir = pawsPaths(home).secretsDir;
    const token = JSON.stringify({
      accessToken: "xoxb-T0ONE",
      refreshToken: null,
      expiresAtMs: null,
      scope: "app_mentions:read,channels:read,chat:write",
      teamId: "T0ONE",
      botUserId: BOT,
      appId: "A1",
    });
    await db.transaction(function* (q) {
      const team = { kind: "slack" as const, workspace: "team:T0ONE" };
      yield* replaceScopedCredentialSteps(q, dir, team, "W1", 0);
      yield* replaceScopedCredentialSteps(q, dir, { kind: "slack", workspace: "W1" }, token, 0);
    });
  }
  const users = { ua: "admin", um: "member" } as const;
  for (const user of Object.keys(users))
    await putWorkspaceUser(db, { id: user, linearUserId: user, name: user, email: "u@x.invalid" });
  const tokenHash = workspaceTokenHash(await issueWorkspaceBootstrap(db, "W1", now));
  const boot = { id: "W1", organizationId: "W1", name: "W1", userId: "ua", tokenHash, now };
  await consumeWorkspaceBootstrap(db, boot);
  for (const [user, role] of Object.entries(users)) {
    const at = { workspaceId: "W1", userId: user, now };
    await syncWorkspaceMember(db, { ...at, role, active: true, teamIds: [] });
    cookies[user] = `${WORKSPACE_COOKIE}=${(await issueWorkspaceSession(db, at)).token}`;
    await addRunner(user, SLACK_REPLY_RUNNER_VERSION.join("."));
  }
  await install();

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
      `v0=${createHmac("sha256", "secret").update(`v0:${time}:${raw}`).digest("hex")}`;
    const headers = { "x-slack-signature": signature, "x-slack-request-timestamp": time };
    const request = new Request(`${ORIGIN}/webhooks/slack`, { method: "POST", headers, body: raw });
    return handleSlackWebhook(request, "secret", now, undefined, (mention) =>
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
  async function code(user: string | null, slackUser: string) {
    const query = new URLSearchParams({ team: "T0ONE", channel: "C0ONE", user: slackUser });
    const headers: Record<string, string> = user ? { cookie: cookies[user]! } : {};
    const response = (await linkPage(
      new Request(`${ORIGIN}/oauth/slack/link?${query}`, { headers }),
    ))!;
    const found = /link ([A-Z2-7]{4}-[A-Z2-7]{4})/.exec(await response.text())?.[1];
    return { status: response.status, code: found };
  }
  async function say(slackUser: string, text: string, extra: Record<string, unknown> = {}) {
    await deliver(mention(slackUser, text, extra));
    await settle();
  }
  const posts = (method: string) => posted.filter((post) => post.method === method);
  const notice = () => String(posts("chat.postEphemeral").at(-1)?.body.text);
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
      const jobsLeft = (yield* q.all(q.orm.select().from(q.t.job))).map((row) => row.queue);
      return {
        workItems: (yield* q.all(q.orm.select().from(q.t.workItem))).length,
        reservations: (yield* q.all(q.orm.select().from(q.t.runnerReservation))).length,
        linear: (yield* q.all(
          q.orm.select().from(q.t.outbox).where(eq(q.t.outbox.target, "linear")),
        )).length,
        jobs: jobsLeft.filter(
          (queue) => queue !== SLACK_THREAD_JOB && queue !== "agent.usage.after-run",
        ),
      };
    });
  return {
    db,
    shared,
    posted,
    failNext,
    prompts,
    runner,
    helpers,
    deliver,
    mention,
    runJobs,
    settle,
    code,
    say,
    posts,
    notice,
    replies,
    sideEffects,
    addRunner,
    install,
    advance: (ms: number) => (now += ms),
    reconnect: () => db.transaction((q) => markSlackInstallationSteps(q, "W1", Date.now())),
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

async function linked(...who: ["ua" | "um", string][]) {
  const f = await fixture();
  for (const [user, slackUser] of [["ua", "SADMIN"], ...who] as const) {
    await f.say(slackUser, `link ${(await f.code(user, slackUser)).code}`);
    expect(f.notice()).toContain("Linked");
  }
  f.posted.length = 0;
  return f;
}

const NONE = { workItems: 0, reservations: 0, linear: 0, jobs: [] };

test("setup from Slack: only the admin's own Slack user can redeem a fresh code from this installation", async () => {
  const f = await fixture();
  await f.say("SADMIN", "hello");
  expect(f.posts("chat.postEphemeral")[0]!.body).toMatchObject({
    channel: "C0ONE",
    user: "SADMIN",
  });
  expect(f.notice()).toContain(`${ORIGIN}/oauth/slack/link?team=T0ONE&channel=C0ONE&user=SADMIN`);
  expect(await f.code(null, "SADMIN")).toEqual({ status: 401, code: undefined });
  await f.say("SMEMBER", `link ${(await f.code("um", "SMEMBER")).code}`);
  expect(f.notice()).toContain("must be a Paws workspace admin");
  const stolen = (await f.code("ua", "SADMIN")).code;
  await f.say("SOTHER", `link ${stolen}`);
  expect(f.notice()).toContain("expired");
  const late = (await f.code("ua", "SADMIN")).code;
  f.advance(11 * 60_000);
  await f.say("SADMIN", `link ${late}`);
  expect(f.notice()).toContain("expired");
  const old = (await f.code("ua", "SADMIN")).code;
  await f.reconnect();
  await f.say("SADMIN", `link ${old}`);
  expect(f.notice()).not.toContain("Linked");
  await f.say("SADMIN", `link ${(await f.code("ua", "SADMIN")).code}`);
  expect(f.notice()).toContain("Linked");
  expect(f.prompts).toEqual([]);
  expect(f.posts("chat.postMessage")).toEqual([]);
  expect(await f.sideEffects()).toEqual(NONE);
});

test("a linked member's mentions get one reply each, in the thread, with full implementation slots", async () => {
  const f = await linked();
  await recordLinearInstallation(f.db, {
    organizationId: "W1",
    oauthClientId: "app",
    appUserId: "app-user",
    sessionId: "session-1",
    teamId: "team",
    observedAtMs: Date.now(),
  });
  const profile = { agent: "codex" as const, model: null };
  const classify = { runnerId: "runner-ua", sessionId: "session-1", purpose: "classify" as const };
  await f.helpers.dispatch({ ...classify, profile, prompt: "Classify this" });
  expect(await runnerOccupancy(f.db, "runner-ua", Date.now())).toEqual({
    capacity: 1,
    occupied: 1,
  });
  const first = f.mention("SADMIN", "what is a monad?");
  await Promise.all([
    f.deliver(first, { eventId: "EvDUP001" }),
    f.deliver(first, { eventId: "EvDUP001" }),
  ]);
  await f.settle();
  await f.deliver(first, { eventId: "EvDUP002" });
  await f.say("SADMIN", "and a functor?", { thread_ts: first.ts });
  expect(f.prompts.map((turn) => turn.userId)).toEqual(["ua", "ua"]);
  expect(f.prompts[1]!.prompt).toContain("what is a monad?\n[Paws]: answer 1");
  const sent = f.posts("chat.postMessage").map((post) => [post.body.thread_ts, post.body.text]);
  expect(sent).toEqual([
    [first.ts, "answer 1"],
    [first.ts, "answer 2"],
  ]);
  expect(await runnerOccupancy(f.db, "runner-ua", Date.now())).toEqual({
    capacity: 1,
    occupied: 1,
  });
  expect(await f.sideEffects()).toEqual(NONE);
});

test("only an explicit, signed, fresh mention from a linked member in the channel starts a turn", async () => {
  const f = await linked();
  const unmentioned = { type: "message", channel: "C0ONE", user: "SADMIN", text: "thanks" };
  await f.deliver({ ...unmentioned, ts: "1800000000.000001" });
  await f.deliver(f.mention("SADMIN", "bot", { bot_id: "B9" }));
  await f.deliver(f.mention("SADMIN", "elsewhere", { channel: "C0TWO" }));
  await f.deliver(f.mention("SADMIN", "other team"), { team: "T0NINE" });
  await f.deliver({ ...f.mention("SADMIN", "x"), text: "<@UOTHER> hi" });
  const forged = await f.deliver(f.mention("SADMIN", "f"), { signature: `v0=${"0".repeat(64)}` });
  const stale = await f.deliver(f.mention("SADMIN", "s"), { at: Date.now() - 600_000 });
  expect([forged.status, stale.status]).toEqual([401, 401]);
  await f.say("SMEMBER", "unlinked");
  expect(f.prompts).toEqual([]);
  expect(f.posts("chat.postMessage")).toEqual([]);
  expect(f.posts("chat.postEphemeral").map((post) => post.body.user)).toEqual(["SMEMBER"]);
});

test("Slack sends are at most once: clear refusals retry, unknown and refused outcomes never post again", async () => {
  const f = await linked();
  for (const fail of ["rate", "down", "refused"] as const) {
    f.failNext["chat.postMessage"] = fail;
    await f.say("SADMIN", fail);
    f.advance(60_000);
    await f.settle();
  }
  f.failNext["chat.postMessage"] = "lost";
  await f.say("SADMIN", "lost canary-5");
  f.failNext["chat.postMessage"] = "scope";
  await f.say("SADMIN", "refused canary-6");
  await f.deliver(f.mention("SADMIN", "crashed canary-7"));
  await f.runJobs();
  const pending = (await f.replies()).at(-1)!;
  await f.db.run((q) =>
    q.exec(
      q.orm.update(q.t.outbox).set({ externalId: "sending" }).where(eq(q.t.outbox.id, pending.id)),
    ),
  );
  f.advance(60_000);
  await f.settle();
  const rows = await f.replies();
  expect(
    rows.map((row) => [row.status, /^1800000000\./.test(row.externalId!) ? "ts" : row.externalId]),
  ).toEqual([
    ["sent", "ts"],
    ["sent", "ts"],
    ["sent", "ts"],
    ["dropped", "unknown"],
    ["dropped", "refused"],
    ["dropped", "unknown"],
  ]);
  expect(f.posts("chat.postMessage").map((post) => post.body.text)).toEqual([
    "answer 1",
    "answer 2",
    "answer 3",
    "answer 4",
  ]);
  await f.say("SADMIN", "next");
  expect(f.prompts.at(-1)!.prompt).not.toMatch(/canary-[567]/);
});

test("access, audience or installation changes before processing or delivery fence the reply", async () => {
  for (const change of ["member", "channel", "reconnect", "queued", "running"] as const) {
    const f = await linked();
    if (change === "queued") {
      await f.deliver(f.mention("SADMIN", "queued"));
      await f.reconnect();
      await f.say("SADMIN", `link ${(await f.code("ua", "SADMIN")).code}`);
    } else if (change === "running") {
      f.runner.hold = true;
      await f.deliver(f.mention("SADMIN", "in flight"));
      const pending = f.settle();
      while (!(await f.db.run((q) => q.all(q.orm.select().from(q.t.runnerHelper)))).length)
        await Bun.sleep(2);
      await f.revoke("ua");
      f.runner.hold = false;
      await pending;
    } else {
      await f.deliver(f.mention("SADMIN", "late"));
      await f.runJobs();
      if (change === "member") await f.revoke("ua");
      if (change === "channel") f.shared.C0ONE = true;
      if (change === "reconnect") await f.reconnect();
    }
    await f.settle();
    expect(f.posts("chat.postMessage")).toEqual([]);
    if (change !== "queued" && change !== "running")
      expect((await f.replies())[0]).toMatchObject({ status: "dropped", externalId: "withheld" });
  }
});

test("a runner too old for Slack replies, or none, answers nothing", async () => {
  const f = await linked();
  await f.addRunner("ua", MINIMUM_RUNNER_VERSION.join("."));
  await f.say("SADMIN", "old runner");
  await f.db.run((q) => q.exec(q.orm.update(q.t.runner).set({ status: "revoked" })));
  await f.say("SADMIN", "no runner");
  expect(f.prompts).toEqual([]);
  expect(f.posted).toEqual([]);
});

test("another member in the same thread never sees a member's turns", async () => {
  const f = await linked(["um", "SMEMBER"]);
  const root = f.mention("SADMIN", "private canary-42");
  await f.deliver(root);
  await f.settle();
  await f.say("SMEMBER", "what was said?", { thread_ts: root.ts });
  expect(f.prompts.at(-1)!.userId).toBe("um");
  expect(f.prompts.at(-1)!.prompt).not.toContain("canary-42");
});

const conversations = async (f: Awaited<ReturnType<typeof fixture>>, threadTs?: string) =>
  (await f.db.run((q) => q.all(q.orm.select().from(q.t.slackConversation)))).filter(
    (row) => threadTs === undefined || row.threadTs === threadTs,
  );

test("a thread's conversation is recorded once with its installation, channel, thread and first actor", async () => {
  const f = await linked(["um", "SMEMBER"]);
  const before = (await conversations(f)).length;
  const root = f.mention("SADMIN", "plan the release");
  await f.deliver(f.mention("SADMIN", "forged"), { signature: `v0=${"0".repeat(64)}` });
  await f.deliver(f.mention("SADMIN", "stale"), { at: Date.now() - 600_000 });
  await f.deliver(f.mention("SADMIN", "other team"), { team: "T0NINE" });
  expect((await conversations(f)).length).toBe(before);
  await f.deliver(root, { eventId: "EvROOT01" });
  await f.settle();
  await f.deliver(root, { eventId: "EvROOT01" });
  await f.say("SMEMBER", "and the changelog?", { thread_ts: root.ts });
  await f.deliver(root, { eventId: "EvROOT01" });
  await f.settle();
  const rows = await conversations(f, root.ts);
  expect(rows).toEqual([
    expect.objectContaining({
      workspaceId: "W1",
      teamId: "T0ONE",
      appId: "A1",
      channelId: "C0ONE",
      threadTs: root.ts,
      startedBySlackUserId: "SADMIN",
      startedEventId: "EvROOT01",
      replyChannelId: "C0ONE",
      replyThreadTs: root.ts,
      workItemId: null,
      issueId: null,
      stoppedTs: null,
    }),
  ]);
  const events = await f.db.run((q) => q.all(q.orm.select().from(q.t.inboxEvent)));
  const ofThread = events
    .map((event) => event.payload as unknown as { conversationId: string; mention: SlackEvent })
    .filter((event) => event.mention.threadTs === root.ts);
  expect(ofThread.map((event) => [event.conversationId, event.mention.slackUserId])).toEqual([
    [rows[0]!.id, "SADMIN"],
    [rows[0]!.id, "SMEMBER"],
  ]);
  expect(f.prompts.map((turn) => turn.userId)).toEqual(["ua", "um"]);
  expect(f.posts("chat.postMessage")).toHaveLength(2);
  expect(await f.sideEffects()).toEqual(NONE);
});

type SlackEvent = { threadTs: string; slackUserId: string };

test("a linked member's stop ends the running turn while runners are full, and fences delayed mentions", async () => {
  const f = await linked(["um", "SMEMBER"]);
  f.runner.hold = true;
  const root = f.mention("SADMIN", "write a long essay");
  await f.deliver(root);
  const running = f.settle();
  while (!(await f.db.run((q) => q.all(q.orm.select().from(q.t.runnerHelper)))).length)
    await Bun.sleep(2);
  const outsider = f.mention("SOTHER", "stop", { thread_ts: root.ts });
  await f.deliver(outsider);
  expect((await conversations(f, root.ts))[0]!.stoppedTs).toBeNull();
  const stop = f.mention("SMEMBER", "stop", { thread_ts: root.ts });
  await f.deliver(stop);
  await f.deliver(stop);
  expect(await conversations(f, root.ts)).toEqual([
    expect.objectContaining({ stoppedTs: stop.ts, stoppedBySlackUserId: "SMEMBER" }),
  ]);
  await running;
  f.runner.hold = false;
  await f.deliver(root, { eventId: "EvLATE001" });
  await f.settle();
  expect(f.posts("chat.postMessage")).toEqual([]);
  const notices = f.posts("chat.postEphemeral").map((post) => [post.body.user, post.body.text]);
  expect(notices).toContainEqual(["SMEMBER", expect.stringContaining("Stopped")]);
  expect(notices).toHaveLength(1);
  await f.say("SADMIN", "and now a short one", { thread_ts: root.ts });
  expect(f.posts("chat.postMessage").map((post) => post.body.thread_ts)).toEqual([root.ts]);
  expect(await f.sideEffects()).toEqual(NONE);
});
