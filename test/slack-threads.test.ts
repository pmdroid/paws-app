import { afterEach, expect, test } from "bun:test";
import { createHash, createHmac, generateKeyPairSync } from "node:crypto";
import { rmSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import {
  bindWorkItemRepositorySteps,
  consumeWorkspaceBootstrap,
  enqueueOutboxOnceSteps,
  ensureLinearSessionSteps,
  listOutboxSteps,
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
  slackHandoffSteps,
  slackReplyAllowedSteps,
  slackTaskUpdateSteps,
} from "../src/slack";
import { createFakeTracker, followUpSessionOwner } from "../src/linear";
import { deliverLinearOutbox } from "../src/loop";
import { openQuestion } from "../src/questions";
import { createRunnerHelpers } from "../src/runner-helpers";
import {
  createFakeContextAccess,
  ingestContext,
  invalidateContext,
  type ContextNamespace,
} from "../src/project-context";
import { createSlackReplies } from "../src/runner-backend";
import { createFakeSnapshotReader, type FakeSnapshotReader } from "../src/github";
import { createRunnerPlacement } from "../src/runner-placement";
import { MINIMUM_RUNNER_VERSION, SLACK_REPLY_RUNNER_VERSION } from "../src/runner-protocol";
import { replaceScopedCredentialSteps } from "../src/credentials";
import { pawsPaths } from "../src/config";
import { tempHome } from "./helpers";
import { sqlRows, sqlRun, tempStore } from "./pglite";
import { insertWorkItemSteps, signInFixtureRunner } from "./pglite-fixtures";

const ORIGIN = "https://paws.example";
const BOT = "UPAWS";
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

type Fail = "rate" | "down" | "refused" | "lost" | "scope";

async function fixture(
  setup: {
    memory?: Parameters<typeof createSlackThreads>[0]["memory"];
    source?: FakeSnapshotReader;
  } = {},
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
  const channel: Record<string, unknown> = {};
  const members: { id: string; is_restricted?: boolean; is_ultra_restricted?: boolean }[] = [
    { id: "SADMIN" },
    { id: "SMEMBER" },
    { id: BOT },
  ];
  const full = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    team_id: "T0ONE",
    is_bot: false,
    is_restricted: false,
    is_ultra_restricted: false,
    ...extra,
  });
  const directory = {
    users: [
      full("SADMIN"),
      full("SMEMBER"),
      full("SOTHER"),
      full("SGONE", { deleted: true }),
      full(BOT, { is_bot: true }),
      full("USLACKBOT"),
    ] as Record<string, unknown>[],
    page: 200,
    endless: false,
    lookups: [] as string[],
    full,
  };
  const paged = (items: unknown[], body: Record<string, unknown>) => {
    const from = Number(body.cursor ?? 0);
    const to = from + Math.min(directory.page, Number(body.limit));
    const next = directory.endless || to < items.length ? String(to) : "";
    return { ok: true, members: items.slice(from, to), response_metadata: { next_cursor: next } };
  };
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
      const flags = {
        is_shared: external,
        is_ext_shared: external,
        is_org_shared: false,
        is_pending_ext_shared: false,
      };
      const info = { id: body.channel, is_channel: true, is_private: false, ...flags, ...channel };
      return Response.json({ ok: true, channel: info });
    }
    if (method === "conversations.members" || method === "users.list") {
      directory.lookups.push(method);
      const list = method === "users.list" ? directory.users : members.map((member) => member.id);
      return Response.json(paged(list, body));
    }
    if (method === "users.info") {
      const user = members.find((member) => member.id === body.user);
      const flags = { is_restricted: false, is_ultra_restricted: false };
      return Response.json({ ok: true, user: { ...flags, ...user } });
    }
    posted.push({ method, body });
    if (fail === "lost") throw new Error("socket hang up");
    return Response.json({ ok: true, ts: `1800000000.${String(posted.length).padStart(6, "0")}` });
  };
  const prompts: { userId: string; prompt: string }[] = [];
  const answers: string[] = [];
  type Filed = { key: string; teamId: string; title: string; description: string };
  const eng = { id: "team-eng", key: "ENG", name: "Engineering", private: false };
  const linear = {
    connected: true,
    teams: new Map([["ENG", eng]]),
    issues: new Map<string, unknown>(),
    calls: [] as { id: string }[],
    fail: undefined as "lost" | "refused" | undefined,
  };
  const hash = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 16);
  const work = () =>
    linear.connected
      ? {
          team: async (key: string) =>
            linear.teams.has(key) ? { ...linear.teams.get(key)! } : null,
          issueId: hash,
          file: async ({ key, ...request }: Filed) => {
            const [id, fail] = [hash(key), linear.fail];
            linear.calls.push({ id, ...request });
            linear.fail = undefined;
            if (fail === "refused") throw new Error("Linear refused the request");
            if (!linear.issues.has(id)) linear.issues.set(id, { id, ...request });
            if (fail === "lost") throw new Error("socket hang up");
            return { id, identifier: "ENG-1", url: "https://linear.app/acme/issue/ENG-1" };
          },
        }
      : null;
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
          text: answers.shift() ?? `answer ${prompts.length}`,
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
      work,
      ...(setup.memory ? { memory: setup.memory } : {}),
      ...(setup.source ? { source: setup.source } : {}),
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
  const tokenHash = workspaceTokenHash(await issueWorkspaceBootstrap(db, "ORG1", now));
  const boot = { id: "W1", organizationId: "ORG1", name: "W1", userId: "ua", tokenHash, now };
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
    options: { team?: string; app?: string; signature?: string; at?: number; value?: string } & {
      action?: string;
    } = {},
  ) {
    const container = { type: "message", message_ts: message.ts, channel_id: "C0ONE" };
    const payload = {
      type: "block_actions",
      team: { id: options.team ?? "T0ONE" },
      api_app_id: options.app ?? "A1",
      user: { id: slackUser },
      channel: { id: "C0ONE" },
      container,
      ...(options.action ? {} : { message: { ts: message.ts, thread_ts: message.threadTs } }),
      actions: [
        {
          action_id: options.action ?? "paws_stop",
          value: options.value ?? "stop",
          action_ts: `${++ts}.000200`,
        },
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
    channel,
    members,
    directory,
    cookies,
    csrf,
    posted,
    failNext,
    hooks,
    prompts,
    answers,
    linear,
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
    organizationId: "ORG1",
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
    organizationId: "ORG1",
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

const lastPrompt = (f: { prompts: { prompt: string }[] }) => f.prompts.at(-1)?.prompt ?? "";

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
  for (let index = 40; index < 60; index++)
    await plant(
      f,
      namespace,
      `fact ${index}: service-${index} is owned by team-${index % 5}`,
      "reported_fact",
    );
  await f.say("SMEMBER", "who owns service-9?");
  expect(Buffer.byteLength(lastPrompt(f))).toBeLessThan(4_000 * 2);
  expect(f.posted.length).toBe(posted + 2);
  expect((await f.replies()).map((row) => row.status)).not.toContain("dropped");
  expect(await f.sideEffects()).toEqual(NONE);
});

test("a memory change while Paws checks the channel before sending withholds the reply", async () => {
  const f = await linked(["um", "SMEMBER"]);
  await f.say("SMEMBER", "remember canary-late: queues run on SQS");
  const id = RECORD.exec(f.notice())![1]!;
  await f.deliver(f.mention("SMEMBER", "what runs our queues?"));
  await f.runJobs();
  expect(lastPrompt(f)).toContain("canary-late");
  f.hooks.onInfo = async () => {
    await f.deliver(f.mention("SADMIN", `forget ${id}`));
    await f.runJobs();
  };
  await f.settle();
  expect(f.posts("chat.postMessage")).toEqual([]);
  expect((await f.replies())[0]).toMatchObject({ status: "dropped", externalId: "withheld" });
});

test("a long thread carries each memory dependency once", async () => {
  const f = await linked(["um", "SMEMBER"]);
  await f.say("SMEMBER", "remember canary-chain: the API is in Go");
  const root = f.mention("SMEMBER", "what is the API written in?");
  await f.deliver(root);
  await f.settle();
  for (let turn = 0; turn < 8; turn++)
    await f.say("SMEMBER", `follow-up ${turn} about the API`, { thread_ts: root.ts });
  const rows = await f.replies();
  expect(rows).toHaveLength(9);
  for (const row of rows) {
    const refs = (row.payload as { contexts?: { key: string; version: number }[] }).contexts ?? [];
    const ids = refs.map((ref) => `${ref.key}@${ref.version}`);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeLessThanOrEqual(rows.length);
  }
});

const MAIN = "a".repeat(40);
const V1 = "b".repeat(40);
const OSS = "c".repeat(40);
const NEXT = "d".repeat(40);

async function withSource(disclosed: string[] = ["acme/app", "acme/oss"]) {
  const reader = createFakeSnapshotReader({
    "acme/app": {
      visibility: "private",
      defaultRef: "main",
      refs: { main: MAIN, v1: V1 },
      files: {
        [MAIN]: {
          "src/billing.ts":
            'export const plan = "canary-main";\nconst key = "ghp_abcdefghijklmnopqrstuvwxyz";',
          "src/other.ts": "canary-unrelated",
          ".env": "SECRET=canary-env",
          "README.md": "The app.",
        },
        [V1]: { "src/billing.ts": "canary-v1" },
        [NEXT]: { "src/billing.ts": "canary-next" },
      },
    },
    "acme/oss": {
      visibility: "public",
      defaultRef: "main",
      refs: { main: OSS },
      files: { [OSS]: { "lib/billing.js": "canary-oss" } },
    },
  });
  const f = await linkedWith({ source: reader }, ["um", "SMEMBER"]);
  for (const repository of ["acme/app", "acme/oss"])
    await sqlRun(
      f.db,
      "INSERT INTO workspace_repository(workspace_id, repository, team_id) VALUES('W1', ?, 'tA')",
      [repository],
    );
  const teams = (teamIds: string[]) =>
    syncWorkspaceMember(f.db, {
      workspaceId: "W1",
      userId: "um",
      role: "member",
      active: true,
      teamIds,
      now: f.now(),
    });
  await teams(["tA"]);
  for (const repository of disclosed)
    expect((await disclose(f, "ua", repository, "workspace")).status).toBe(200);
  const thread = async (slackUser: string, attach: string) => {
    const root = f.mention(slackUser, attach);
    await f.deliver(root);
    await f.settle();
    return root.ts;
  };
  return { ...f, reader, teams, thread };
}

const sourcesOf = (row: { payload: unknown }) => (row.payload as { sources?: unknown }).sources;

test("an attached repository answers from read-only source, records its commit, and needs no slot or issue", async () => {
  const f = await withSource();
  await f.say("SMEMBER", "channel repo acme/app");
  expect(f.notice()).toContain("Only a Paws workspace admin");
  await f.say("SADMIN", "channel repo acme/app");
  expect(f.notice()).toContain("This channel's repository is now `acme/app`");
  expect(await f.audit("slack.channel_repository")).toEqual([
    { user_id: "ua", subject: "slack:T0ONE:C0ONE:acme/app" },
  ]);
  await f.say("SMEMBER", "how does billing work?");
  const prompt = lastPrompt(f);
  expect(prompt).toContain(`acme/app at commit ${MAIN} (main)`);
  expect(prompt).toContain("canary-main");
  expect(prompt).toContain("line withheld");
  expect(prompt).not.toContain("ghp_");
  expect(prompt).not.toContain("canary-env");
  expect(prompt).not.toContain("canary-unrelated");
  expect(String(f.posts("chat.postMessage").at(-1)!.body.text)).toBe(
    "answer 1\n_Read from `acme/app` at `aaaaaaaaaaaa` (main)._",
  );
  expect(sourcesOf((await f.replies()).at(-1)!)).toEqual([
    { repository: "acme/app", ref: "main", commit: MAIN },
  ]);
  const pinned = await f.thread("SMEMBER", "repo acme/app v1");
  expect(f.notice()).toContain("This thread now reads `acme/app` at `v1`");
  await f.say("SMEMBER", "and billing here?", { thread_ts: pinned });
  expect(lastPrompt(f)).toContain("canary-v1");
  f.reader.repositories["acme/app"]!.refs.v1 = NEXT;
  f.reader.repositories["acme/app"]!.refs.main = NEXT;
  const sha = await f.thread("SMEMBER", `repo acme/app ${V1}`);
  await f.say("SMEMBER", "billing again?", { thread_ts: sha });
  expect(lastPrompt(f)).toContain("canary-v1");
  await f.say("SMEMBER", "billing on main now?");
  expect(lastPrompt(f)).toContain("canary-next");
  expect(f.prompts.map((turn) => turn.userId)).toEqual(["um", "um", "um", "um"]);
  expect(await f.sideEffects()).toEqual(NONE);
});

test("source needs the requester's current access and a covered audience, before reading and again before posting", async () => {
  const f = await withSource(["acme/oss"]);
  await f.teams([]);
  await f.say("SMEMBER", "repo acme/app");
  expect(f.notice()).toContain("can't attach that repository");
  await f.teams(["tA"]);
  const own = await f.thread("SMEMBER", "repo acme/app");
  await f.say("SMEMBER", "how does billing work?", { thread_ts: own });
  expect(f.notice()).toMatch(SOURCE_WITHHELD);
  expect(f.reader.calls.filter((call) => call.method !== "resolve")).toEqual([]);
  expect(f.prompts).toEqual([]);
  const open = await f.thread("SMEMBER", "repo acme/oss");
  await f.say("SMEMBER", "how does billing work?", { thread_ts: open });
  expect(lastPrompt(f)).toContain("canary-oss");
  await f.teams([]);
  await f.say("SMEMBER", "billing again?", { thread_ts: open });
  expect(f.notice()).toContain("can't read this thread's repository for you");
  await f.say("SMEMBER", "repo off", { thread_ts: open });
  await f.say("SMEMBER", "what did you say before?", { thread_ts: open });
  expect(lastPrompt(f)).not.toContain("answer 1");
  expect(lastPrompt(f)).not.toContain("canary-oss");
  expect(lastPrompt(f)).toContain("No repository");

  for (const change of ["access", "disclosure", "running"] as const) {
    const g = await withSource();
    const ts = await g.thread("SMEMBER", "repo acme/app");
    if (change === "running") {
      g.runner.hold = true;
      await g.deliver(g.mention("SMEMBER", "billing?", { thread_ts: ts }));
      const pending = g.settle();
      while (!(await g.db.run((q) => q.all(q.orm.select().from(q.t.runnerHelper)))).length)
        await Bun.sleep(2);
      await g.teams([]);
      g.runner.hold = false;
      await pending;
      expect(g.notice()).toContain("changed while Paws was answering");
      expect(await g.replies()).toEqual([]);
      continue;
    }
    await g.deliver(g.mention("SMEMBER", "billing?", { thread_ts: ts }));
    await g.runJobs();
    expect(await g.replies()).toHaveLength(1);
    if (change === "access") await g.teams([]);
    if (change === "disclosure") await disclose(g, "ua", "acme/app", "none");
    await g.settle();
    expect(g.posts("chat.postMessage")).toEqual([]);
    expect((await g.replies())[0]).toMatchObject({ status: "dropped", externalId: "withheld" });
  }
});

test("source reads are bounded and cached per member, installation and commit", async () => {
  const f = await withSource();
  const files = f.reader.repositories["acme/app"]!.files[MAIN]!;
  for (let index = 0; index < 40; index++) files[`src/billing-${index}.ts`] = "x\n".repeat(5_000);
  files["src/billing-huge.ts"] = "y".repeat(100_000);
  await f.say("SADMIN", "channel repo acme/app");
  await f.say("SMEMBER", "billing?");
  await f.say("SMEMBER", "billing again?");
  const prompt = lastPrompt(f);
  expect(Buffer.byteLength(prompt)).toBeLessThan(32_000);
  expect(prompt.match(/^--- /gm)?.length).toBeLessThanOrEqual(4);
  const reads = (who: string) => f.reader.calls.filter((call) => call.method === who);
  expect(reads("read").map((call) => call.target)).not.toContain("src/billing-huge.ts");
  expect(reads("files")).toHaveLength(1);
  const blobs = reads("read").length;
  await f.say("SADMIN", "billing?");
  expect(reads("files")).toHaveLength(2);
  expect(reads("read").length).toBeGreaterThan(blobs);
  await f.reconnect();
  expect(await f.sideEffects()).toEqual(NONE);
});

test("an earlier sourced answer carries its repository into follow-ups and leaves them once access or disclosure ends", async () => {
  const f = await withSource();
  await f.say("SADMIN", "channel repo acme/app");
  const root = f.mention("SMEMBER", "how does billing work?");
  await f.deliver(root);
  await f.settle();
  await f.say("SMEMBER", "repo off", { thread_ts: root.ts });
  await f.say("SMEMBER", "summarise that", { thread_ts: root.ts });
  expect(lastPrompt(f)).toContain("[Paws]: answer 1");
  const follow = (await f.replies()).at(-1)!;
  expect(sourcesOf(follow)).toEqual([{ repository: "acme/app", ref: "main", commit: MAIN }]);
  await f.deliver(f.mention("SMEMBER", "and once more", { thread_ts: root.ts }));
  await f.runJobs();
  expect(sourcesOf((await f.replies()).at(-1)!)).toHaveLength(1);
  await f.teams([]);
  await f.settle();
  expect((await f.replies()).at(-1)).toMatchObject({ status: "dropped", externalId: "withheld" });
  await f.teams(["tA"]);
  await disclose(f, "ua", "acme/app", "none");
  await f.say("SMEMBER", "repeat the billing answer", { thread_ts: root.ts });
  const prompt = lastPrompt(f);
  expect(prompt).not.toContain("[Paws]: answer");
  expect(prompt).not.toContain("acme/app");
  expect(sourcesOf((await f.replies()).at(-1)!)).toBeUndefined();
});

test("binary files count against the four-file read limit", async () => {
  const f = await withSource();
  const files = f.reader.repositories["acme/app"]!.files[MAIN]!;
  for (let index = 0; index < 200; index++) files[`assets/billing-${index}.bin`] = "\u0000bin";
  await f.say("SADMIN", "channel repo acme/app");
  await f.say("SMEMBER", "billing?");
  expect(f.reader.calls.filter((call) => call.method === "read").length).toBeLessThanOrEqual(4);
});

const SOURCE_WITHHELD = /couldn't confirm that everyone who can read this channel/;

async function sourceFixture(policy: "none" | "workspace" = "workspace") {
  const f = await withSource(policy === "workspace" ? ["Acme/App"] : []);
  await f.say("SADMIN", "channel repo acme/app");
  f.posted.length = 0;
  return f;
}

async function disclose(
  f: Awaited<ReturnType<typeof fixture>>,
  user: "ua" | "um",
  repository: string,
  level: string,
) {
  const links = createSlackLinks({ store: f.db, home: f.home, origin: ORIGIN });
  const response = (await links(
    new Request(`${ORIGIN}/api/workspaces/slack/disclosure`, {
      method: "PUT",
      headers: { origin: ORIGIN, cookie: f.cookies[user]!, "x-paws-csrf": f.csrf[user]! },
      body: JSON.stringify({ repository, level }),
    }),
  ))!;
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function leaked(f: Awaited<ReturnType<typeof fixture>>) {
  return f.posted.filter((post) => /canary-main|acme\/app/i.test(JSON.stringify(post.body)));
}

test("a source answer reaches a public internal channel only when its repository's policy allows it", async () => {
  const f = await sourceFixture("none");
  await f.say("SMEMBER", "how does billing work?");
  expect(f.posts("chat.postMessage")).toEqual([]);
  expect(f.notice()).toMatch(SOURCE_WITHHELD);
  expect(f.posts("chat.postEphemeral").at(-1)!.body).toMatchObject({
    user: "SMEMBER",
    thread_ts: expect.any(String),
  });
  expect(f.prompts).toEqual([]);
  expect(f.reader.calls).toEqual([]);
  expect(leaked(f)).toEqual([]);
  expect(f.posts("conversations.open")).toEqual([]);
  expect(await f.sideEffects()).toEqual(NONE);

  expect((await disclose(f, "um", "acme/app", "workspace")).status).toBe(403);
  expect((await disclose(f, "ua", "not a repo", "workspace")).status).toBe(400);
  expect((await disclose(f, "ua", "acme/app", "everyone")).status).toBe(400);
  expect((await disclose(f, "ua", "acme/app", "workspace")).body).toEqual({
    repositories: { "acme/app": "workspace" },
  });
  expect(await f.audit("slack.disclosure_changed")).toEqual([
    { user_id: "ua", subject: "acme/app:workspace" },
  ]);
  f.posted.length = 0;
  await f.say("SMEMBER", "and billing now?");
  expect(f.posts("chat.postMessage").map((post) => post.body.text)).toEqual([
    expect.stringContaining("acme/app"),
  ]);
  expect(f.posts("chat.postEphemeral")).toEqual([]);
});

test("guests, an incomplete member list or a missing scope withhold a source answer", async () => {
  for (const change of ["guest", "single-channel guest", "large", "scope"] as const) {
    const f = await sourceFixture();
    if (change === "guest") f.members.push({ id: "SGUEST", is_restricted: true });
    if (change === "single-channel guest")
      f.members.push({ id: "SGUEST", is_ultra_restricted: true });
    if (change === "large") for (let i = 0; i < 120; i++) f.members.push({ id: `SPEOPLE${i}` });
    if (change === "scope") f.failNext["conversations.members"] = "scope";
    await f.say("SMEMBER", `billing question with ${change}`);
    expect(f.posts("chat.postMessage")).toEqual([]);
    expect(f.notice()).toMatch(SOURCE_WITHHELD);
    expect(f.prompts).toEqual([]);
    expect(leaked(f)).toEqual([]);
  }
});

test("a channel that turns private, Enterprise-shared or Slack Connect before delivery gets no source canary", async () => {
  const kinds = {
    private: { is_private: true },
    enterprise: { is_shared: true, is_org_shared: true },
    connect: { is_shared: true, is_ext_shared: true },
    pending: { is_pending_ext_shared: true },
    unknown: { is_org_shared: undefined },
    "pending unknown": { is_pending_ext_shared: undefined },
    ...SHARED_METADATA,
  } as const;
  for (const [kind, flags] of Object.entries(kinds)) {
    const f = await sourceFixture();
    await f.deliver(f.mention("SMEMBER", `billing question in ${kind}`));
    await f.runJobs();
    expect(await f.replies()).toHaveLength(1);
    expect(lastPrompt(f)).toContain("canary-main");
    Object.assign(f.channel, flags);
    await f.settle();
    expect(f.posts("chat.postMessage")).toEqual([]);
    expect((await f.replies())[0]).toMatchObject({ status: "dropped", externalId: "withheld" });
    expect(f.notice()).toMatch(SOURCE_WITHHELD);
    expect(leaked(f)).toEqual([]);
    expect(f.posts("conversations.open")).toEqual([]);
  }
});

test("each delivery retry checks the audience and the policy again", async () => {
  const f = await sourceFixture();
  f.failNext["chat.postMessage"] = "rate";
  await f.say("SMEMBER", "billing question, first try rate limited");
  expect((await f.replies())[0]).toMatchObject({ status: "pending" });
  f.members.push({ id: "SGUEST", is_restricted: true });
  f.advance(60_000);
  await f.settle();
  expect(f.posts("chat.postMessage")).toEqual([]);
  expect((await f.replies())[0]).toMatchObject({ status: "dropped", externalId: "withheld" });
  expect(f.notice()).toMatch(SOURCE_WITHHELD);

  const g = await sourceFixture();
  await g.deliver(g.mention("SMEMBER", "billing question while the policy changes"));
  await g.runJobs();
  g.hooks.onInfo = () => disclose(g, "ua", "acme/app", "none");
  await g.settle();
  expect(g.posts("chat.postMessage")).toEqual([]);
  expect(leaked(g)).toEqual([]);
  expect(g.notice()).toMatch(SOURCE_WITHHELD);
});

test("a follow-up that reuses an earlier source answer is gated by its repository's disclosure", async () => {
  const f = await sourceFixture();
  const root = f.mention("SMEMBER", "how does billing work?");
  await f.deliver(root);
  await f.settle();
  expect(f.posts("chat.postMessage").map((post) => post.body.text)).toEqual([
    expect.stringContaining("acme/app"),
  ]);
  await f.say("SMEMBER", "repo off", { thread_ts: root.ts });

  await f.deliver(f.mention("SMEMBER", "summarize that again", { thread_ts: root.ts }));
  await f.runJobs();
  expect(lastPrompt(f)).toContain("acme/app");
  expect(sourcesOf((await f.replies()).at(-1)!)).toEqual([
    { repository: "acme/app", ref: "main", commit: MAIN },
  ]);
  await disclose(f, "ua", "acme/app", "none");
  f.posted.length = 0;
  await f.settle();
  expect(f.posts("chat.postMessage")).toEqual([]);
  expect(f.notice()).toMatch(SOURCE_WITHHELD);
  expect(leaked(f)).toEqual([]);

  f.posted.length = 0;
  await f.say("SMEMBER", "repeat the billing answer", { thread_ts: root.ts });
  expect(lastPrompt(f)).not.toContain("acme/app");
  expect(f.posts("chat.postMessage")).toHaveLength(1);
  expect(leaked(f)).toEqual([]);
  expect(sourcesOf((await f.replies()).at(-1)!)).toBeUndefined();

  await disclose(f, "ua", "acme/app", "workspace");
  f.members.push({ id: "SGUEST", is_restricted: true });
  f.posted.length = 0;
  await f.say("SMEMBER", "one last time", { thread_ts: root.ts });
  expect(lastPrompt(f)).not.toContain("acme/app");
  expect(leaked(f)).toEqual([]);
});

test("each repository's disclosure is its own record, so concurrent changes never undo each other", async () => {
  const f = await sourceFixture();
  await Promise.all([
    disclose(f, "ua", "acme/app", "none"),
    disclose(f, "ua", "acme/other", "workspace"),
  ]);
  expect((await disclose(f, "ua", "acme/third", "workspace")).body).toEqual({
    repositories: { "acme/other": "workspace", "acme/third": "workspace" },
  });
  await f.say("SMEMBER", "billing after the revoke");
  expect(f.posts("chat.postMessage")).toEqual([]);
  expect(f.prompts).toEqual([]);
  expect(leaked(f)).toEqual([]);
});

const BRIEF_TITLE = "Retry failed uploads";
const BRIEF = JSON.stringify({
  title: BRIEF_TITLE,
  scope: "Retry an upload that fails with a server error.",
  acceptance: ["A 503 upload is retried up to three times"],
});
const CANARY = "CANARY-7f3a-private";

async function working() {
  const f = await linked(["um", "SMEMBER"]);
  const member = { workspaceId: "W1", userId: "um", role: "member" as const, active: true };
  await syncWorkspaceMember(f.db, { ...member, teamIds: ["team-eng"], now: f.now() });
  return f;
}

function draftOf(f: Awaited<ReturnType<typeof fixture>>) {
  const post = f.posts("chat.postEphemeral").at(-1)!;
  const blocks = post.body.blocks as { elements?: { action_id: string; value: string }[] }[];
  return { post, id: blocks[1]!.elements![0]!.value };
}

test("a start drafts a minimal brief only its member sees, and Create files one delegated issue for the thread", async () => {
  const f = await working();
  const root = f.mention("SMEMBER", `uploads fail sometimes; my token is ${CANARY}`);
  await f.deliver(root);
  await f.settle();
  f.answers.push(`Here it is: ${BRIEF}`);
  await f.say("SMEMBER", "start ENG", { thread_ts: root.ts });
  expect(f.prompts.at(-1)!.prompt).toContain(CANARY);
  const { post, id } = draftOf(f);
  expect(post.body).toMatchObject({ user: "SMEMBER", thread_ts: root.ts });
  expect(String(post.body.text)).toContain("Retry failed uploads");
  expect(String(post.body.text)).toContain("every member of your Linear workspace");
  expect(f.posts("chat.postMessage")).toHaveLength(1);
  const message = { ts: "1800000000.000999", threadTs: root.ts };
  const create = { action: "paws_file", value: id };
  await f.click("SADMIN", message, create);
  await f.settle();
  expect(f.linear.issues.size).toBe(0);
  await Promise.all([f.click("SMEMBER", message, create), f.click("SMEMBER", message, create)]);
  await f.settle();
  const [issueId, issue] = [...f.linear.issues.entries()][0]!;
  const description = `Retry an upload that fails with a server error.\n\n## Acceptance criteria\n\n- [ ] A 503 upload is retried up to three times`;
  expect(issue).toEqual({ id: issueId, teamId: "team-eng", title: BRIEF_TITLE, description });
  const outgoing = JSON.stringify(f.linear.calls);
  for (const secret of [CANARY, "uploads fail", "C0ONE", "T0ONE", "SMEMBER", root.ts, "slack"])
    expect(outgoing).not.toContain(secret);
  expect(f.notice()).toContain("ENG-1");
  await f.click("SMEMBER", message, create);
  await f.say("SMEMBER", "start ENG", { thread_ts: root.ts });
  expect(f.notice()).toContain("This thread's work is <https://linear.app/acme/issue/ENG-1|ENG-1>");
  expect(f.linear.calls).toHaveLength(1);
  const brief = (creatorId: string) => ({
    readBriefIssue: async (key: string) => ({ issue: { issueId: key }, parent: null, creatorId }),
  });
  const owner = (tracker: object, target = issueId) =>
    followUpSessionOwner(f.db, tracker as never, target, "ORG1", "app-user");
  expect(await owner(brief("app-user"))).toBe("um");
  expect(await owner(brief("app-user"), "other-issue")).toBeNull();
  expect(await owner(brief("someone"))).toBeNull();
  expect(await f.sideEffects()).toEqual(NONE);
});

test("an unconfirmed or refused filing reconciles to the thread's one issue when the member starts again", async () => {
  const f = await working();
  const root = f.mention("SMEMBER", "uploads fail");
  await f.deliver(root);
  f.answers.push("ignored", BRIEF);
  await f.settle();
  await f.say("SMEMBER", "start ENG", { thread_ts: root.ts });
  const message = { ts: "1800000000.000999", threadTs: root.ts };
  const id = draftOf(f).id;
  f.linear.fail = "lost";
  await f.click("SMEMBER", message, { action: "paws_file", value: id });
  await f.settle();
  const turns = f.prompts.length;
  f.linear.teams.get("ENG")!.private = true;
  await f.say("SMEMBER", "start ENG", { thread_ts: root.ts });
  expect(draftOf(f).id).toBe(id);
  expect(f.notice()).toContain("private Linear team ENG");
  await f.click("SMEMBER", message, { action: "paws_discard", value: id });
  const later = { ...message, ts: "1800000000.000997" };
  await f.click("SMEMBER", later, { action: "paws_file", value: id }).then(f.settle);
  expect(f.linear.calls).toHaveLength(1);
  await f.say("SMEMBER", "start ENG", { thread_ts: root.ts });
  const renewed = draftOf(f).id;
  f.linear.fail = "refused";
  await f.click(
    "SMEMBER",
    { ...later, ts: "1800000000.000998" },
    { action: "paws_file", value: renewed },
  );
  await f.settle();
  await f.say("SMEMBER", "start ENG", { thread_ts: root.ts });
  expect(f.prompts).toHaveLength(turns);
  expect(f.posts("chat.postEphemeral").map((post) => String(post.body.text))).toContainEqual(
    expect.stringContaining("Linear didn't confirm the issue (socket hang up)"),
  );
  expect(f.notice()).toContain("This thread's work is <https://linear.app/acme/issue/ENG-1|ENG-1>");
  const filings = f.linear.calls;
  expect(new Set(filings.map((call) => JSON.stringify(call))).size).toBe(1);
  expect(filings).toHaveLength(3);
  expect(f.linear.issues.size).toBe(1);
});

test("a start without a team, Linear, membership or a usable draft files nothing, and stale, discarded or changed drafts do nothing", async () => {
  const f = await working();
  const root = f.mention("SMEMBER", "uploads fail");
  await f.deliver(root);
  await f.settle();
  const turns = f.prompts.length;
  const start = (who: string, text = "start ENG") => f.say(who, text, { thread_ts: root.ts });
  await start("SMEMBER", "start");
  expect(f.notice()).toContain("Name the Linear team");
  await start("SMEMBER", "start NOPE");
  expect(f.notice()).toContain("can't find that Linear team");
  await start("SADMIN");
  expect(f.notice()).toContain("aren't a member of that Linear team");
  f.linear.connected = false;
  await start("SMEMBER");
  expect(f.notice()).toContain("isn't connected to Linear");
  f.linear.connected = true;
  expect(f.prompts).toHaveLength(turns);
  const long = JSON.stringify({ title: "Long", scope: "x".repeat(3_000), acceptance: ["Done"] });
  for (const answer of ["Sure, I'll get right on it.", long]) {
    f.answers.push(answer);
    await start("SMEMBER");
    expect(f.notice()).toContain("couldn't draft a short enough issue");
  }
  const message = { ts: "1800000000.000999", threadTs: root.ts };
  const click = (action: string, value: string) =>
    f.click("SMEMBER", message, { action, value }).then(f.settle);
  f.answers.push(BRIEF);
  await start("SMEMBER");
  const second = draftOf(f).id;
  await click("paws_discard", second);
  expect(f.notice()).toContain("Discarded");
  await click("paws_file", second);
  f.answers.push(BRIEF);
  await start("SMEMBER");
  const fourth = draftOf(f);
  f.advance(61 * 60_000);
  await click("paws_file", fourth.id);
  expect(f.notice()).toContain("no longer current");
  f.answers.push(BRIEF);
  await start("SMEMBER");
  const fifth = draftOf(f).id;
  await f.revoke("um");
  await click("paws_file", fifth);
  expect(f.linear.issues.size).toBe(0);
  expect(f.linear.calls).toEqual([]);
  expect(await f.sideEffects()).toEqual(NONE);
});

const SHARED_METADATA = {
  "a pending external invitation": { pending_connected_team_ids: ["T0EXT"] },
  "a pending share": { pending_shared: ["T0EXT"] },
  "another connected team": { connected_team_ids: ["T0EXT"] },
  "another workspace in the share list": { shared_team_ids: ["T0ONE", "T0TWO"] },
  "another workspace's channel": { context_team_id: "T0TWO" },
} as const;

test("sharing metadata beyond the boolean flags stops a policy-allowed source answer before any read", async () => {
  for (const [name, fields] of Object.entries(SHARED_METADATA)) {
    const f = await sourceFixture();
    Object.assign(f.channel, fields);
    await f.say("SMEMBER", `billing question with ${name}`);
    expect([name, f.prompts.length]).toEqual([name, 0]);
    expect(f.reader.calls.filter((call) => call.method !== "resolve")).toEqual([]);
    expect(f.posts("chat.postMessage")).toEqual([]);
    expect(leaked(f)).toEqual([]);
  }
});

async function withAudience() {
  const f = await withSource([]);
  f.directory.users = f.directory.users.filter((user) => user.id !== "SOTHER");
  const base = { users: [...f.directory.users], members: [...f.members] };
  const reset = async () => {
    f.directory.users = [...base.users];
    f.members.splice(0, f.members.length, ...base.members);
    for (const key of Object.keys(f.channel)) delete f.channel[key];
    f.directory.page = 200;
    f.directory.endless = false;
    f.advance(1);
    await syncWorkspaceMember(f.db, {
      workspaceId: "W1",
      userId: "ua",
      role: "admin",
      active: true,
      teamIds: [],
      now: f.now(),
    });
  };
  const outsider = () => f.directory.users.push(f.directory.full("SOTHER"));
  const ts = await f.thread("SMEMBER", "repo acme/app");
  const fileReads = () => f.reader.calls.filter((call) => call.method !== "resolve").length;
  const ask = async (text: string) => {
    const before = { prompts: f.prompts.length, reads: fileReads() };
    await f.say("SMEMBER", text, { thread_ts: ts });
    const answered = f.prompts.length > before.prompts;
    if (!answered) expect(fileReads()).toBe(before.reads);
    return answered;
  };
  return { ...f, reset, outsider, ts, ask };
}

test("without a disclosure policy, source answers only when every verified reader of the channel is linked and can read it", async () => {
  const f = await withAudience();
  expect(await f.ask("billing first?")).toBe(true);
  expect(lastPrompt(f)).toContain("canary-main");
  expect(f.directory.lookups).toContain("conversations.members");
  expect(f.directory.lookups).toContain("users.list");
  f.outsider();
  expect((await disclose(f, "ua", "acme/app", "workspace")).status).toBe(200);
  expect(await f.ask("billing under the disclosure policy?")).toBe(true);
  expect((await disclose(f, "ua", "acme/app", "none")).status).toBe(200);
  await f.reset();
  const { full } = f.directory;
  const guest = (id: string, flags: Record<string, unknown>) => {
    f.directory.users.push(full(id, flags));
    f.members.push({ id, ...flags });
  };
  const unverified: Record<string, () => unknown> = {
    "an unlinked full member outside the channel": () => f.outsider(),
    "a guest in the channel": () => guest("SGUEST", { is_restricted: true }),
    "a single-channel guest in the channel": () => guest("SGUEST", { is_ultra_restricted: true }),
    "a user whose guest status Slack doesn't say": () =>
      f.directory.users.push({ id: "SNEW", team_id: "T0ONE", is_bot: false }),
    "a Slack Connect member": () => guest("SEXT", { team_id: "T0EXT" }),
    "a channel member missing from the directory": () => f.members.push({ id: "SGHOST" }),
    "an Enterprise share with another workspace": () =>
      Object.assign(f.channel, { shared_team_ids: ["T0ONE", "T0TWO"] }),
    "a pending external invitation": () =>
      Object.assign(f.channel, { pending_connected_team_ids: ["T0EXT"] }),
    "another app's bot in the channel": () => guest("SBOT", { is_bot: true }),
    "an unlinked member on a later page": () => {
      f.directory.page = 1;
      f.outsider();
    },
    "membership that never ends": () => (f.directory.endless = true),
    "a directory Paws may not read": () => (f.failNext["users.list"] = "scope"),
    "a linked reader whose Paws membership ended": () => f.revoke("ua"),
  };
  for (const [name, change] of Object.entries(unverified)) {
    await change();
    const answered = await f.ask(`billing with ${name}?`);
    expect([name, answered]).toEqual([name, false]);
    expect(f.notice()).toMatch(SOURCE_WITHHELD);
    expect(
      f.posts("chat.postMessage").filter((post) => /canary/.test(JSON.stringify(post))),
    ).toEqual([]);
    await f.reset();
  }
  const verified: Record<string, () => void> = {
    "a guest outside the channel": () =>
      void f.directory.users.push(full("SGUEST", { is_restricted: true })),
    "a deactivated account": () => void f.directory.users.push(full("SOLD", { deleted: true })),
    "linked readers across many pages": () => void (f.directory.page = 1),
  };
  for (const [name, change] of Object.entries(verified)) {
    change();
    expect([name, await f.ask(`billing with ${name}?`)]).toEqual([name, true]);
    expect(lastPrompt(f)).toContain("canary-main");
    await f.reset();
  }
  expect(await f.sideEffects()).toEqual(NONE);
});

test("verified readership is checked again at queueing, at delivery, on retry and for earlier answers", async () => {
  const f = await withAudience();
  f.runner.hold = true;
  await f.deliver(f.mention("SMEMBER", "billing in flight?", { thread_ts: f.ts }));
  const pending = f.settle();
  while (!(await f.db.run((q) => q.all(q.orm.select().from(q.t.runnerHelper)))).length)
    await Bun.sleep(2);
  f.outsider();
  f.runner.hold = false;
  await pending;
  expect(f.notice()).toMatch(SOURCE_WITHHELD);
  expect(await f.replies()).toEqual([]);
  await f.reset();

  await f.deliver(f.mention("SMEMBER", "billing queued?", { thread_ts: f.ts }));
  await f.runJobs();
  expect(await f.replies()).toHaveLength(1);
  f.outsider();
  await f.settle();
  expect((await f.replies()).at(-1)).toMatchObject({ status: "dropped", externalId: "withheld" });
  expect(f.notice()).toMatch(SOURCE_WITHHELD);
  await f.reset();

  f.failNext["chat.postMessage"] = "rate";
  await f.say("SMEMBER", "billing retried?", { thread_ts: f.ts });
  expect((await f.replies()).at(-1)!.status).toBe("pending");
  f.outsider();
  f.advance(60_000);
  await f.settle();
  expect((await f.replies()).at(-1)).toMatchObject({ status: "dropped", externalId: "withheld" });
  expect(f.posts("chat.postMessage")).toEqual([]);
  await f.reset();

  await f.deliver(f.mention("SMEMBER", "billing mid-check?", { thread_ts: f.ts }));
  await f.runJobs();
  f.hooks.onInfo = async () => void f.outsider();
  await f.settle();
  expect((await f.replies()).at(-1)).toMatchObject({ status: "dropped", externalId: "withheld" });
  expect(f.posts("chat.postMessage")).toEqual([]);
  await f.reset();

  expect(await f.ask("billing, sent this time?")).toBe(true);
  expect(f.posts("chat.postMessage")).toHaveLength(1);
  f.outsider();
  await f.say("SMEMBER", "repo off", { thread_ts: f.ts });
  await f.say("SMEMBER", "summarise that", { thread_ts: f.ts });
  const prompt = lastPrompt(f);
  expect(prompt).toContain("No repository");
  expect(prompt).not.toContain("[Paws]: answer");
  expect(prompt).not.toContain("acme/app");
});

test("a start with changes revises the member's current draft, not another member's", async () => {
  const f = await working();
  await syncWorkspaceMember(f.db, {
    workspaceId: "W1",
    userId: "ua",
    role: "admin",
    active: true,
    teamIds: ["team-eng"],
    now: f.now(),
  });
  const root = f.mention("SMEMBER", "uploads fail");
  await f.deliver(root);
  await f.settle();
  const start = (who: string, text: string) => f.say(who, text, { thread_ts: root.ts });
  f.answers.push(BRIEF);
  await start("SMEMBER", "start ENG");
  expect(f.prompts.at(-1)!.prompt).not.toContain("already has this draft");
  const first = draftOf(f).id;
  const revised = JSON.stringify({ ...JSON.parse(BRIEF), title: "Retry uploads twice" });
  f.answers.push(revised);
  await start("SMEMBER", "start ENG: only two retries");
  const prompt = f.prompts.at(-1)!.prompt;
  expect(prompt).toContain("already has this draft");
  expect(prompt).toContain(BRIEF_TITLE);
  expect(prompt).toContain("only two retries");
  const second = draftOf(f);
  expect(second.id).not.toBe(first);
  expect(String(second.post.body.text)).toContain("Retry uploads twice");
  f.answers.push(BRIEF);
  await start("SADMIN", "start ENG: something else");
  expect(f.prompts.at(-1)!.prompt).not.toContain("Retry uploads twice");
});

test("a filed thread hands its context only to its own run, and gets questions, progress and the PR in the thread", async () => {
  const f = await working();
  const root = f.mention("SMEMBER", `uploads fail; see ${CANARY}`);
  await f.deliver(root);
  await f.settle();
  f.answers.push(BRIEF);
  await f.say("SMEMBER", "start ENG", { thread_ts: root.ts });
  const message = { ts: "1800000000.000999", threadTs: root.ts };
  await f.click("SMEMBER", message, { action: "paws_file", value: draftOf(f).id });
  await f.settle();
  const [issueId] = [...f.linear.issues.keys()];
  expect(JSON.stringify(f.linear.calls)).not.toContain(CANARY);
  await f.db.run(function* (q) {
    yield* ensureLinearSessionSteps(q, { sessionId: "S1", issueId, organizationId: "ORG1" });
    yield* ensureLinearSessionSteps(q, { sessionId: "S2", issueId, organizationId: "ORG2" });
    for (const id of ["item-1", "item-2"]) {
      yield* insertWorkItemSteps(q, id);
      const issue = id === "item-1" ? issueId! : "sub-issue";
      const set = { linearIssueId: issue, linearIdentifier: "ENG-1", sessionKey: "S1" };
      yield* q.exec(q.orm.update(q.t.workItem).set(set).where(eq(q.t.workItem.id, id)));
    }
  });
  const handoff = await f.db.run((q) => slackHandoffSteps(q, "S1"));
  expect(handoff).toContain(CANARY);
  expect(handoff).toContain("private to Paws");
  expect(await f.db.run((q) => slackHandoffSteps(q, "S2"))).toBe("");
  const tracker = createFakeTracker();
  const send = async (op: string, key: string, payload: Record<string, unknown>) => {
    const row = { target: "linear" as const, op, orderingKey: "S1", idempotencyKey: key };
    const body = payload.questionId ? payload : { itemId: "item-1", ...payload };
    const now = f.now();
    await f.db.transaction((q) => enqueueOutboxOnceSteps(q, { ...row, payload: body, now }));
    const stored = (await f.db.run((q) => listOutboxSteps(q, "S1"))).at(-1)!;
    await deliverLinearOutbox(stored, tracker, async () => {}, undefined, f.db);
    await f.settle();
  };
  f.posted.length = 0;
  await send("elicitation", "question:q1", { sessionId: "S1", body: "Which bucket?" });
  expect(f.posts("chat.postMessage")).toHaveLength(0);
  expect(f.notice()).toContain("didn't post it in this thread");
  expect(f.notice()).not.toContain("Which bucket?");
  await f.db.transaction((q) =>
    bindWorkItemRepositorySteps(q, "item-1", {
      owner: "acme",
      repo: "app",
      remoteUrl: "https://github.com/acme/app.git",
    }),
  );
  expect((await disclose(f, "ua", "acme/app", "workspace")).status).toBe(200);
  await f.db.transaction((q) =>
    bindWorkItemRepositorySteps(q, "item-2", {
      owner: "acme",
      repo: "secret",
      remoteUrl: "https://github.com/acme/secret.git",
    }),
  );
  await send("activity", "update:item-2:1", {
    sessionId: "S1",
    itemId: "item-2",
    kind: "thought",
    body: "Secret sibling",
  });
  expect(f.posts("chat.postMessage")).toHaveLength(0);
  const asked = await openQuestion(f.db, { itemId: "item-1", sessionId: "S1", body: "Which?" });
  const question = { sessionId: "S1", questionId: asked.id, body: "Which region?" };
  await send("elicitation", "question:q2", question);
  await send("activity", "update:item-1:1", {
    sessionId: "S1",
    kind: "thought",
    body: "Tests pass",
  });
  await send("activity", "tool:item-1:1", { sessionId: "S1", kind: "thought", body: "Reading" });
  await send("activity", "pull-request-ready:item-1:1", {
    sessionId: "S1",
    kind: "response",
    body: "Opened https://github.com/acme/app/pull/9",
  });
  await send("activity", "update:item-1:1", {
    sessionId: "S1",
    kind: "thought",
    body: "Tests pass",
  });
  const posts = f.posts("chat.postMessage");
  expect(posts.map((post) => post.body.thread_ts)).toEqual([root.ts, root.ts, root.ts]);
  const texts = posts.map((post) => String(post.body.text));
  expect(texts[0]).toContain("Paws asks on <https://linear.app/acme/issue/ENG-1|ENG-1>");
  expect(texts[0]).toContain("Which region?");
  expect(texts[1]).toContain("Tests pass");
  expect(texts[2]).toContain("pull/9");
  expect(JSON.stringify(f.posted)).not.toMatch(new RegExp(`${CANARY}|Secret sibling`));
  await f.db.transaction((q) =>
    slackTaskUpdateSteps(
      q,
      { sessionId: "S1", itemId: "item-1", key: "k", kind: "update", text: "Queued" },
      0,
    ),
  );
  await f.say("SMEMBER", "unlink", { thread_ts: root.ts });
  await send("activity", "reply:item-1:2", { sessionId: "S1", kind: "response", body: "Later" });
  expect(f.posts("chat.postMessage")).toHaveLength(3);
  expect(JSON.stringify(f.posted)).not.toMatch(/Queued|Later/);
  await f.reconnect();
  await send("activity", "merged:item-1:1", { sessionId: "S1", kind: "response", body: "Merged" });
  expect(f.posts("chat.postMessage")).toHaveLength(3);
});
