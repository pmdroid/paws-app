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
  acceptSlackInteraction,
  acceptSlackMention,
  createSlackLinkPage,
  createSlackLinks,
  createSlackThreads,
  handleSlackWebhook,
  markSlackInstallationSteps,
  SLACK_THREAD_JOB,
  slackReplyAllowedSteps,
} from "../src/slack";
import { createRunnerHelpers } from "../src/runner-helpers";
import {
  createFakeContextAccess,
  ingestContext,
  invalidateContext,
  type ContextNamespace,
} from "../src/project-context";
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

async function fixture(
  setup: { memory?: Parameters<typeof createSlackThreads>[0]["memory"] } = {},
) {
  const home = tempHome();
  const { db, close } = await tempStore();
  cleanup.push(close, () => rmSync(home, { recursive: true, force: true }));
  let now = Date.now();
  const clock = { now: () => now, mono: () => now };
  const shared: Record<string, boolean> = { C0ONE: false, C0TWO: false };
  const posted: { method: string; body: Record<string, unknown> }[] = [];
  const failNext: Record<string, Fail | undefined> = {};
  const hooks: { onInfo?: () => Promise<unknown> } = {};
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
      const hook = hooks.onInfo;
      hooks.onInfo = undefined;
      await hook?.();
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
  const start = () =>
    createSlackThreads({
      store: db,
      home,
      env: {},
      origin: ORIGIN,
      fetch: slackFetch,
      now: () => now,
      replies: async () => lane,
      profile: () => ({ agent: "codex" as const, model: null }),
      ...(setup.memory ? { memory: setup.memory } : {}),
    });
  let threads = start();
  const jobs = new JobLoop(db, clock, { backoffBaseMs: 10 });
  jobs.register(SLACK_THREAD_JOB, (job, context) => threads.handle(job, context));
  const outbox = new OutboxDispatcher(db, clock, { backoffBaseMs: 10 });
  outbox.setTargetHandler("slack", (row, context) => threads.deliver(row, context));
  const linkPage = createSlackLinkPage({ store: db, home, now: () => now });
  const cookies: Record<string, string> = {};
  const csrf: Record<string, string> = {};

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
    const issued = await issueWorkspaceSession(db, at);
    cookies[user] = `${WORKSPACE_COOKIE}=${issued.token}`;
    csrf[user] = issued.session.csrfToken;
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
  async function click(
    slackUser: string,
    message: { ts: string; threadTs: string },
    options: { team?: string; app?: string; signature?: string; at?: number; value?: string } = {},
  ) {
    const payload = {
      type: "block_actions",
      team: { id: options.team ?? "T0ONE" },
      api_app_id: options.app ?? "A1",
      user: { id: slackUser },
      channel: { id: "C0ONE" },
      container: { type: "message", message_ts: message.ts, channel_id: "C0ONE" },
      message: { ts: message.ts, thread_ts: message.threadTs },
      actions: [
        { action_id: "paws_stop", value: options.value ?? "stop", action_ts: `${++ts}.000200` },
      ],
    };
    const raw = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    const time = String(Math.floor((options.at ?? now) / 1000));
    const signature =
      options.signature ??
      `v0=${createHmac("sha256", "secret").update(`v0:${time}:${raw}`).digest("hex")}`;
    const headers = {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-signature": signature,
      "x-slack-request-timestamp": time,
    };
    const request = new Request(`${ORIGIN}/webhooks/slack`, { method: "POST", headers, body: raw });
    return handleSlackWebhook(request, "secret", now, undefined, undefined, (interaction) =>
      acceptSlackInteraction(db, home, interaction, now),
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
  async function api(user: string, method: string, path: string, token = csrf[user]!) {
    const headers = { origin: ORIGIN, cookie: cookies[user]!, "x-paws-csrf": token };
    const links = createSlackLinks({ store: db, home, origin: ORIGIN, now: () => now });
    const response = (await links(new Request(`${ORIGIN}${path}`, { method, headers })))!;
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }
  const audit = (action: string) =>
    sqlRows<{ user_id: string; subject: string }>(
      db,
      "SELECT user_id, subject FROM workspace_access_audit WHERE action = ? ORDER BY id",
      [action],
    );
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
    home,
    shared,
    posted,
    failNext,
    hooks,
    prompts,
    runner,
    helpers,
    deliver,
    click,
    api,
    audit,
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
    now: () => now,
    restart: () => void (threads = start()),
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
  return linkedWith({}, ...who);
}

async function linkedWith(options: Parameters<typeof fixture>[0], ...who: ["ua" | "um", string][]) {
  const f = await fixture(options);
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

test("a stop that lands while a reply is being prepared for delivery withholds it, and stops never move back", async () => {
  const f = await linked(["um", "SMEMBER"]);
  const root = f.mention("SADMIN", "quick one");
  await f.deliver(root);
  await f.runJobs();
  const stop = f.mention("SMEMBER", "stop", { thread_ts: root.ts });
  const earlier = f.mention("SADMIN", "stop", { thread_ts: root.ts, ts: "1690000000.000100" });
  expect(await f.replies()).toEqual([expect.objectContaining({ status: "pending" })]);
  f.hooks.onInfo = () => f.deliver(stop);
  await f.settle();
  expect(f.posts("chat.postMessage")).toEqual([]);
  expect((await f.replies()).at(-1)).toMatchObject({ status: "dropped", externalId: "withheld" });
  await f.deliver(earlier);
  expect((await conversations(f, root.ts))[0]!.stoppedTs).toBe(stop.ts);
});

test("an unlinked member's question is held and answered once, in its thread, after they link", async () => {
  const f = await linked();
  const question = f.mention("SMEMBER", "what is a monad?");
  await f.deliver(question);
  await f.settle();
  expect(f.notice()).toContain("within 10 minutes");
  expect(f.prompts).toEqual([]);
  expect(await f.sideEffects()).toEqual(NONE);
  await f.say("SOTHER", "me too");
  await f.say("SMEMBER", `link ${(await f.code("um", "SMEMBER")).code}`, {
    thread_ts: "1700000999.000100",
  });
  expect(f.notice()).toContain("answering the question you asked before linking");
  await f.deliver(question);
  await f.say("SMEMBER", `link ${(await f.code("um", "SMEMBER")).code}`);
  expect(f.notice()).toBe("Linked. Mention @Paws in this thread to ask it something.");
  expect(f.prompts.map((turn) => turn.userId)).toEqual(["um"]);
  expect(f.prompts[0]!.prompt).toContain("what is a monad?");
  const sent = f.posts("chat.postMessage").map((post) => [post.body.thread_ts, post.body.text]);
  expect(sent).toEqual([[question.ts, "answer 1"]]);
  expect(await f.sideEffects()).toEqual(NONE);
});

test("a held question lapses with its link, and a revoked member's code links and releases nothing", async () => {
  const f = await linked();
  await f.say("SMEMBER", "first");
  f.advance(11 * 60_000);
  await f.say("SMEMBER", `link ${(await f.code("um", "SMEMBER")).code}`);
  expect(f.notice()).toBe("Linked. Mention @Paws in this thread to ask it something.");
  await f.revoke("um");
  await f.say("SMEMBER", "second");
  expect(f.prompts).toEqual([]);
  expect(f.posts("chat.postMessage")).toEqual([]);
  expect(await f.sideEffects()).toEqual(NONE);
});

test("a link never moves a Slack account or a Paws account to another, and no one inherits the installer's role", async () => {
  const f = await linked(["um", "SMEMBER"]);
  await f.say("SALT", "hi");
  await f.say("SALT", `link ${(await f.code("ua", "SALT")).code}`);
  expect(f.notice()).toContain("already linked");
  await f.say("SADMIN", `link ${(await f.code("um", "SADMIN")).code}`);
  expect(f.notice()).toContain("already linked");
  await f.say("SALT", "still there?");
  await f.say("SADMIN", "who am I?");
  await f.say("SMEMBER", "and me?");
  expect(f.prompts.map((turn) => turn.userId)).toEqual(["ua", "um"]);
  expect(await f.sideEffects()).toEqual(NONE);
});

test("a Stop click on Paws's reply stops the thread once while runners are full; forged, stale and foreign clicks do nothing", async () => {
  const f = await linked(["um", "SMEMBER"]);
  const root = f.mention("SADMIN", "first question");
  await f.deliver(root);
  await f.settle();
  const reply = f.posts("chat.postMessage")[0]!.body;
  expect(reply.blocks).toContainEqual(
    expect.objectContaining({
      type: "actions",
      elements: [expect.objectContaining({ action_id: "paws_stop", value: "stop" })],
    }),
  );
  const message = { ts: (await f.replies())[0]!.externalId!, threadTs: root.ts };
  await recordLinearInstallation(f.db, {
    organizationId: "W1",
    oauthClientId: "app",
    appUserId: "app-user",
    sessionId: "session-1",
    teamId: "team",
    observedAtMs: Date.now(),
  });
  const profile = { agent: "codex" as const, model: null };
  await f.helpers.dispatch({
    runnerId: "runner-ua",
    sessionId: "session-1",
    purpose: "classify",
    profile,
    prompt: "Classify this",
  });
  expect(await runnerOccupancy(f.db, "runner-ua", Date.now())).toEqual({
    capacity: 1,
    occupied: 1,
  });
  f.runner.hold = true;
  await f.deliver(f.mention("SADMIN", "second, long", { thread_ts: root.ts }));
  const running = f.settle();
  const slackTurns = () =>
    f.db.run((q) =>
      q.all(
        q.orm.select().from(q.t.runnerHelper).where(eq(q.t.runnerHelper.purpose, "slack_reply")),
      ),
    );
  while ((await slackTurns()).length < 2) await Bun.sleep(2);
  const stored = async () =>
    (await f.db.run((q) => q.all(q.orm.select().from(q.t.inboxEvent)))).filter(
      (event) => (event.payload as unknown as { type: string }).type === "SlackInteraction",
    );
  const forged = await f.click("SMEMBER", message, { signature: `v0=${"0".repeat(64)}` });
  const stale = await f.click("SMEMBER", message, { at: Date.now() - 600_000 });
  expect([forged.status, stale.status]).toEqual([401, 401]);
  expect((await f.click("SMEMBER", message, { team: "T0NINE" })).status).toBe(200);
  expect((await f.click("SMEMBER", message, { app: "A9" })).status).toBe(200);
  expect(await stored()).toEqual([]);
  await f.click("SOTHER", message);
  expect(await stored()).toHaveLength(1);
  expect((await conversations(f, root.ts))[0]!.stoppedTs).toBeNull();
  const clicks = await Promise.all([f.click("SMEMBER", message), f.click("SMEMBER", message)]);
  await f.click("SADMIN", message);
  expect(clicks.map((response) => response.status)).toEqual([200, 200]);
  expect(await stored()).toHaveLength(2);
  const [conversation] = await conversations(f, root.ts);
  expect(conversation).toMatchObject({ stoppedBySlackUserId: "SMEMBER" });
  await running;
  f.runner.hold = false;
  await f.settle();
  expect(f.prompts.some((turn) => turn.prompt.includes("second, long"))).toBe(false);
  expect(f.posts("chat.postMessage")).toHaveLength(1);
  const notices = f.posts("chat.postEphemeral").map((post) => [post.body.user, post.body.text]);
  expect(notices).toEqual([["SMEMBER", expect.stringContaining("Stopped")]]);
  await f.say("SADMIN", "and now a short one", { thread_ts: root.ts });
  expect(f.posts("chat.postMessage")).toHaveLength(2);
  await f.click("SADMIN", { ts: message.ts, threadTs: root.ts }, { value: "other" });
  expect((await conversations(f, root.ts))[0]!.stoppedTs).not.toBe(conversation!.stoppedTs);
  expect(await f.sideEffects()).toEqual(NONE);
});

const OWN = "/api/workspaces/slack/link";
const ALL = "/api/workspaces/slack/links";

test("a member sees and unlinks only their own link, once, and is asked to verify again", async () => {
  const f = await linked(["um", "SMEMBER"]);
  await sqlRun(f.db, "INSERT INTO setting(key, value, updated_at) VALUES(?, ?, 0)", [
    "slack.member:T0TWO:SFOREIGN",
    JSON.stringify({
      teamId: "T0TWO",
      channelId: "C0X",
      generation: 1,
      workspaceId: "W2",
      userId: "ux",
    }),
  ]);
  expect((await f.api("um", "GET", OWN)).body).toEqual({
    connected: true,
    link: { teamId: "T0ONE", channelId: "C0ONE", slackUserId: "SMEMBER" },
  });
  expect((await f.api("um", "GET", ALL)).status).toBe(403);
  expect((await f.api("um", "DELETE", `${ALL}?user=SADMIN`)).status).toBe(403);
  expect((await f.api("um", "DELETE", OWN, "forged")).status).toBe(403);
  expect((await f.api("ua", "DELETE", `${ALL}?user=SFOREIGN`)).body).toEqual({ removed: 0 });
  expect((await f.api("um", "DELETE", OWN)).body).toEqual({ removed: 1 });
  expect((await f.api("um", "DELETE", OWN)).body).toEqual({ removed: 0 });
  expect((await f.api("um", "GET", OWN)).body.link).toBeNull();
  f.advance(1);
  expect(await f.audit("slack.member_unlinked")).toEqual([
    { user_id: "um", subject: "slack:T0ONE:SMEMBER" },
  ]);
  expect(await f.audit("slack.member_revoked")).toEqual([]);
  const foreign = await sqlRows(f.db, "SELECT key FROM setting WHERE key = ?", [
    "slack.member:T0TWO:SFOREIGN",
  ]);
  expect(foreign).toHaveLength(1);
  await f.say("SMEMBER", "still linked?");
  expect(f.notice()).toContain(`${ORIGIN}/oauth/slack/link?team=T0ONE&channel=C0ONE&user=SMEMBER`);
  await f.say("SADMIN", "and me?");
  expect(f.prompts.map((turn) => turn.userId)).toEqual(["ua"]);
  expect(f.posts("chat.postMessage")).toHaveLength(1);
  await f.say("SMEMBER", `link ${(await f.code("um", "SMEMBER")).code}`);
  expect(f.notice()).toContain("answering the question you asked before linking");
  expect(f.prompts.map((turn) => turn.userId)).toEqual(["ua", "um"]);
});

test("@Paws unlink unlinks only its poster, and a redelivery or an outsider's unlink changes nothing", async () => {
  const f = await linked(["um", "SMEMBER"]);
  const unlink = f.mention("SMEMBER", "unlink");
  await f.deliver(unlink, { eventId: "EvUNLINK1" });
  await f.settle();
  expect(f.notice()).toContain("Unlinked");
  f.advance(1);
  await f.deliver(unlink, { eventId: "EvUNLINK1" });
  await f.say("SOTHER", "unlink");
  expect(f.notice()).toContain("user=SOTHER");
  expect(await f.audit("slack.member_unlinked")).toEqual([
    { user_id: "um", subject: "slack:T0ONE:SMEMBER" },
  ]);
  await f.say("SMEMBER", "hello?");
  expect(f.notice()).toContain("user=SMEMBER");
  await f.say("SADMIN", "hello");
  expect(f.prompts.map((turn) => turn.userId)).toEqual(["ua"]);
  expect(await f.sideEffects()).toEqual(NONE);
});

test("an admin revoke fences a pending reply and a running turn, and keeps the installation", async () => {
  for (const change of ["pending", "running"] as const) {
    const f = await linked(["um", "SMEMBER"]);
    if (change === "pending") {
      await f.deliver(f.mention("SMEMBER", "late"));
      await f.runJobs();
      expect((await f.api("ua", "DELETE", `${ALL}?user=SMEMBER`)).body).toEqual({ removed: 1 });
    } else {
      f.runner.hold = true;
      await f.deliver(f.mention("SMEMBER", "in flight"));
      const pending = f.settle();
      while (!(await f.db.run((q) => q.all(q.orm.select().from(q.t.runnerHelper)))).length)
        await Bun.sleep(2);
      expect((await f.api("ua", "DELETE", `${ALL}?user=SMEMBER`)).body).toEqual({ removed: 1 });
      await pending;
      f.runner.hold = false;
    }
    await f.settle();
    expect(f.posts("chat.postMessage")).toEqual([]);
    expect((await f.api("ua", "DELETE", `${ALL}?user=SMEMBER`)).body).toEqual({ removed: 0 });
    expect(await f.audit("slack.member_revoked")).toEqual([
      { user_id: "ua", subject: "slack:T0ONE:SMEMBER" },
    ]);
    const { body } = await f.api("ua", "GET", ALL);
    expect(body.links).toEqual([
      expect.objectContaining({ slackUserId: "SADMIN", userId: "ua", active: true }),
    ]);
    await f.say("SADMIN", "still here?");
    expect(f.posts("chat.postMessage")).toHaveLength(1);
  }
});

test("work from before an unlink stays fenced after the same accounts link again", async () => {
  const f = await linked(["um", "SMEMBER"]);
  await f.deliver(f.mention("SMEMBER", "reply before unlink"));
  await f.runJobs();
  f.runner.hold = true;
  await f.deliver(f.mention("SMEMBER", "queued before unlink"));
  expect((await f.api("um", "DELETE", OWN)).body).toEqual({ removed: 1 });
  f.advance(1);
  await f.say("SMEMBER", `link ${(await f.code("um", "SMEMBER")).code}`);
  expect(f.notice()).toBe("Linked. Mention @Paws in this thread to ask it something.");
  f.runner.hold = false;
  await f.settle();
  expect(f.posts("chat.postMessage")).toEqual([]);
  expect((await f.replies())[0]).toMatchObject({ status: "dropped", externalId: "withheld" });
  expect(f.prompts.map((turn) => turn.prompt)).not.toContainEqual(
    expect.stringContaining("queued before unlink"),
  );
  await f.say("SMEMBER", "after relinking");
  expect(f.posts("chat.postMessage")).toHaveLength(1);
});

test("a revoke that lands while Paws checks the channel before sending withholds the reply", async () => {
  const f = await linked(["um", "SMEMBER"]);
  await f.deliver(f.mention("SMEMBER", "quick one"));
  await f.runJobs();
  f.hooks.onInfo = () => f.api("ua", "DELETE", `${ALL}?user=SMEMBER`);
  await f.settle();
  expect(f.posts("chat.postMessage")).toEqual([]);
  expect((await f.replies())[0]).toMatchObject({ status: "dropped", externalId: "withheld" });
});

test("a runner helper issued before an unlink is refused after the same accounts link again", async () => {
  const f = await linked(["um", "SMEMBER"]);
  const generation = Number(
    (
      await sqlRows<{ value: string }>(f.db, "SELECT value FROM setting WHERE key = ?", [
        "slack.member:T0ONE:SMEMBER",
      ]).then((rows) => JSON.parse(rows[0]!.value) as { generation: number })
    ).generation,
  );
  const scope = {
    teamId: "T0ONE",
    channelId: "C0ONE",
    memberUserId: "um",
    installGeneration: generation,
  };
  const allowed = (issuedAt: number) =>
    f.db.run((q) => slackReplyAllowedSteps(q, f.home, { workspaceId: "W1", scope, issuedAt }));
  const before = f.advance(0);
  expect(await allowed(before)).toBe(true);
  expect((await f.api("um", "DELETE", OWN)).body).toEqual({ removed: 1 });
  f.advance(1);
  await f.say("SMEMBER", `link ${(await f.code("um", "SMEMBER")).code}`);
  expect(f.notice()).toContain("Linked");
  expect(await allowed(before)).toBe(false);
  expect(await allowed(f.advance(1))).toBe(true);
});

const RECORD = /`([0-9A-HJKMNP-TV-Z]{26})`/;

async function channelScope(f: Awaited<ReturnType<typeof fixture>>, channel = "C0ONE") {
  const [row] = await sqlRows<{ value: string }>(f.db, "SELECT value FROM setting WHERE key = ?", [
    "slack.channel:W1",
  ]);
  const { generation } = JSON.parse(row!.value) as { generation: number };
  return `T0ONE:${channel}:${generation}`;
}

async function plant(
  f: Awaited<ReturnType<typeof fixture>>,
  namespace: ContextNamespace,
  body: string,
  classification: "decision" | "reported_fact" = "decision",
) {
  const access = createFakeContextAccess();
  const requester = { workspaceId: namespace.workspaceId, userId: "planter" };
  access.grant(requester, { teamIds: [], repositories: [], channelIds: [namespace.scopeId] });
  const outcome = await ingestContext(f.db, access, {
    namespace,
    requester,
    source: {
      kind: "slack_channel_message",
      id: `${namespace.scopeId}:${body}`,
      url: null,
      revision: "1",
      revisionAt: f.now(),
      actorId: "planter",
      restriction: { channelId: namespace.scopeId },
    },
    claims: [{ key: "k", layer: "observation", classification, importance: 5, body }],
    now: f.now(),
  });
  expect(outcome.status).toBe("stored");
}

const lastPrompt = (f: Awaited<ReturnType<typeof fixture>>) => f.prompts.at(-1)?.prompt ?? "";

test("a remembered channel decision reaches a new thread after restart, with no work, runner slot or extra post", async () => {
  const f = await linked(["um", "SMEMBER"]);
  await f.say("SMEMBER", "remember We deploy on Tuesdays (canary-tuesday).");
  expect(f.notice()).toContain("Paws will remember this for this channel");
  const id = RECORD.exec(f.notice())?.[1];
  expect(id).toBeDefined();
  expect(f.prompts).toEqual([]);
  f.restart();
  await f.say("SADMIN", "when do we deploy?");
  expect(lastPrompt(f)).toContain("canary-tuesday");
  expect(lastPrompt(f)).toContain("never approves an action");
  expect(lastPrompt(f).indexOf("canary-tuesday")).toBeLessThan(
    lastPrompt(f).indexOf("when do we deploy?"),
  );
  expect(f.posts("chat.postMessage")).toHaveLength(1);
  await f.say("SADMIN", "memory");
  expect(f.notice()).toContain(id!);
  expect(new Set(f.posted.map((post) => post.method))).toEqual(
    new Set(["chat.postEphemeral", "chat.postMessage"]),
  );
  expect(await f.sideEffects()).toEqual(NONE);
});

test("other channels, workspaces and installations never share the channel's memory", async () => {
  const f = await linked(["um", "SMEMBER"]);
  const here = await channelScope(f);
  await plant(
    f,
    { workspaceId: "W1", scopeKind: "slack_channel", scopeId: await channelScope(f, "C0TWO") },
    "canary-other-channel",
  );
  await plant(
    f,
    { workspaceId: "W2", scopeKind: "slack_channel", scopeId: here },
    "canary-other-workspace",
  );
  await f.say("SMEMBER", "remember canary-here is our release branch");
  await f.say("SMEMBER", "what is our release branch?");
  expect(lastPrompt(f)).toContain("canary-here");
  expect(lastPrompt(f)).not.toContain("canary-other");
  await f.reconnect();
  f.advance(1);
  await f.say("SADMIN", `link ${(await f.code("ua", "SADMIN")).code}`);
  expect(f.notice()).toContain("Linked");
  await f.say("SADMIN", "what is our release branch?");
  expect(lastPrompt(f)).toContain("what is our release branch?");
  expect(lastPrompt(f)).not.toContain("canary-here");
  expect(lastPrompt(f)).not.toContain("canary-other");
});

test("only the author or an admin can correct or forget, and old text never returns after restart", async () => {
  const f = await linked(["um", "SMEMBER"]);
  await f.say("SMEMBER", "remember canary-old: the API lives in Frankfurt");
  const mine = RECORD.exec(f.notice())![1]!;
  await f.say("SADMIN", "remember canary-admin: staging resets nightly");
  const admins = RECORD.exec(f.notice())![1]!;
  await f.say("SMEMBER", `forget ${admins}`);
  expect(f.notice()).toContain("Only its author or a Paws workspace admin");
  await f.say("SMEMBER", `correct ${mine} canary-new: the API lives in Dublin`);
  expect(f.notice()).toContain("Corrected");
  const corrected = RECORD.exec(f.notice())![1]!;
  await f.say("SMEMBER", "where does the API live?");
  expect(lastPrompt(f)).toContain("canary-new");
  expect(lastPrompt(f)).not.toContain("canary-old");
  expect(lastPrompt(f)).toContain("canary-admin");
  await f.say("SADMIN", `forget ${corrected}`);
  expect(f.notice()).toContain("Forgotten");
  f.restart();
  await f.say("SMEMBER", "where does the API live, again?");
  expect(lastPrompt(f)).not.toContain("canary-new");
  expect(lastPrompt(f)).not.toContain("canary-old");
  expect(lastPrompt(f)).toContain("canary-admin");
  await f.say("SMEMBER", "memory");
  expect(f.notice()).not.toContain("canary-new");
  expect(await f.sideEffects()).toEqual(NONE);
});

test("forgetting what an answer used, before it is posted, withholds that answer", async () => {
  const f = await linked(["um", "SMEMBER"]);
  await f.say("SMEMBER", "remember canary-fence: deploys need two approvals");
  const id = RECORD.exec(f.notice())![1]!;
  await f.deliver(f.mention("SMEMBER", "how many approvals do deploys need?"));
  await f.runJobs();
  expect(lastPrompt(f)).toContain("canary-fence");
  await f.deliver(f.mention("SADMIN", `forget ${id}`));
  await f.runJobs();
  await f.settle();
  expect(f.posts("chat.postMessage")).toEqual([]);
  expect((await f.replies()).at(-1)).toMatchObject({ status: "dropped", externalId: "withheld" });
  expect(f.notice()).toContain("Forgotten");
});

test("memory invalidated while the runner answers is never posted, and the member is told", async () => {
  const f = await linked(["um", "SMEMBER"]);
  await f.say("SMEMBER", "remember canary-race: the cache is Redis");
  const scopeId = await channelScope(f);
  f.runner.hold = true;
  await f.deliver(f.mention("SMEMBER", "what cache do we use?"));
  const running = f.runJobs();
  while (
    (await sqlRows(f.db, "SELECT id FROM runner_helper WHERE ended_at IS NULL AND result IS NULL"))
      .length === 0
  )
    await Bun.sleep(2);
  const [source] = await sqlRows<{ source_id: string }>(
    f.db,
    "SELECT source_id FROM context_record WHERE scope_id = ?",
    [scopeId],
  );
  await invalidateContext(f.db, {
    namespace: { workspaceId: "W1", scopeKind: "slack_channel", scopeId },
    source: { kind: "slack_channel_message", id: source!.source_id },
    reason: "deleted",
    now: f.now(),
  });
  f.runner.hold = false;
  await running;
  await f.settle();
  expect(lastPrompt(f)).toContain("canary-race");
  expect(f.posts("chat.postMessage")).toEqual([]);
  expect(await f.replies()).toEqual([]);
  expect(f.notice()).toContain("channel memory or your access changed");
});

test("a queued memory listing is bound to its member's link and lists only what is current when sent", async () => {
  const f = await linked(["um", "SMEMBER"]);
  await f.say("SMEMBER", "remember canary-list-kept: logs live in Loki");
  await f.say("SMEMBER", "remember canary-list-gone: metrics live in Graphite");
  const gone = RECORD.exec(f.notice())![1]!;
  await f.deliver(f.mention("SMEMBER", "memory"));
  await f.runJobs();
  const [source] = await sqlRows<{ source_id: string }>(
    f.db,
    "SELECT source_id FROM context_record WHERE id = ?",
    [gone],
  );
  await invalidateContext(f.db, {
    namespace: { workspaceId: "W1", scopeKind: "slack_channel", scopeId: await channelScope(f) },
    source: { kind: "slack_channel_message", id: source!.source_id },
    reason: "deleted",
    now: f.now(),
  });
  await f.settle();
  expect(f.notice()).toContain("canary-list-kept");
  expect(f.notice()).not.toContain("canary-list-gone");
  const sent = f.posts("chat.postEphemeral").length;
  await f.deliver(f.mention("SMEMBER", "memory"));
  await f.runJobs();
  expect((await f.api("um", "DELETE", OWN)).body).toEqual({ removed: 1 });
  f.advance(1);
  await f.settle();
  expect(f.posts("chat.postEphemeral")).toHaveLength(sent);
  await f.say("SMEMBER", `link ${(await f.code("um", "SMEMBER")).code}`);
  expect(f.notice()).toContain("Linked");
  expect(f.posted.map((post) => String(post.body.text)).join("\n")).not.toContain(
    "canary-list-gone",
  );
});

test("an earlier answer that used corrected memory leaves later prompts, also after restart", async () => {
  const f = await linked(["um", "SMEMBER"]);
  await f.say("SMEMBER", "remember canary-thread: builds run on Buildkite");
  const id = RECORD.exec(f.notice())![1]!;
  const root = f.mention("SMEMBER", "where do builds run?");
  await f.deliver(root);
  await f.settle();
  const first = String(f.posts("chat.postMessage").at(-1)!.body.text);
  await f.say("SMEMBER", "and how long do they take?", { thread_ts: root.ts });
  expect(lastPrompt(f)).toContain(`[Paws]: ${first}`);
  await f.say("SADMIN", `correct ${id} canary-fixed: builds run on GitHub Actions`);
  expect(f.notice()).toContain("Corrected");
  f.restart();
  await f.say("SMEMBER", "anything else?", { thread_ts: root.ts });
  expect(lastPrompt(f)).not.toContain(`[Paws]: ${first}`);
  expect(lastPrompt(f)).toContain("where do builds run?");
  expect(lastPrompt(f)).toContain("canary-fixed");
  expect(lastPrompt(f)).not.toContain("canary-thread");
});

test("a channel memory past its soft threshold is compacted into a summary without a runner or a post", async () => {
  const memory = {
    settings: {
      hardCapTokens: 4_000,
      responseTokens: 1_000,
      memoryTokens: 800,
      recentTokens: 300,
      softThresholdTokens: 500,
      summaryOutputTokens: 200,
      summaryInputTokens: 2_000,
      summaryTimeoutMs: 1_000,
    },
  };
  const f = await linkedWith({ memory }, ["um", "SMEMBER"]);
  const scopeId = await channelScope(f);
  const namespace: ContextNamespace = { workspaceId: "W1", scopeKind: "slack_channel", scopeId };
  for (let index = 0; index < 40; index++)
    await plant(
      f,
      namespace,
      `fact ${index}: service-${index} is owned by team-${index % 5} and deploys from region-${index % 3}`,
      "reported_fact",
    );
  const posted = f.posted.length;
  await f.say("SMEMBER", "who owns service-7?");
  const summaries = await sqlRows<{ body: string }>(
    f.db,
    "SELECT body FROM context_summary WHERE scope_id = ? AND body <> ''",
    [scopeId],
  );
  expect(summaries.length).toBeGreaterThan(0);
  expect(f.posted.length).toBe(posted + 1);
  await f.say("SMEMBER", "who owns service-9?");
  expect(Buffer.byteLength(lastPrompt(f))).toBeLessThan(4_000 * 2);
  expect(await f.sideEffects()).toEqual(NONE);
});
