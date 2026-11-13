import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import {
  legacyAgentBindingId,
  putWorkspaceUser,
  recordAccountObservation,
  recordLinearInstallation,
  recordRunnerCapacity,
  recordRunnerAgentUsage,
  runnerAgentUsage,
  syncWorkspaceMember,
  type Q,
} from "../src/db";
import { createRunnerWork } from "../src/runner-work";
import { createRunnerHealth } from "../src/runner-health";
import { createRunnerHelpers } from "../src/runner-helpers";
import { createRunnerLogin } from "../src/runner-login";
import { createRunnerHttp, type RunnerControl } from "../src/runner-control";
import { workspaceId, type WorkspacePrincipal } from "../src/workspace";
import { RunnerHealthResultSchema, type RunnerCommand } from "../src/runner-protocol";
import { seed } from "./dialects";
import { tempStore } from "./pglite";

const stores: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

type AgentPolicy = Partial<Q["t"]["runnerAgentPolicy"]["$inferInsert"]>;

async function fixture() {
  const store = await tempStore();
  stores.push(store);
  const { db } = store;
  let at = 1_800_000_000_000;
  const workspace = workspaceId();
  await seed(db, (q) =>
    q.orm.insert(q.t.workspace).values({
      id: workspace,
      linearOrganizationId: "sign-in-org",
      name: "Sign-in",
      createdAt: at,
    }),
  );
  const userId = await putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "sign-in-owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  await syncWorkspaceMember(db, {
    workspaceId: workspace,
    userId,
    role: "admin",
    active: true,
    teamIds: [],
    now: at,
  });
  const owner: WorkspacePrincipal = {
    workspaceId: workspace,
    userId,
    role: "admin",
    teamIds: [],
    authenticatedAt: at,
  };
  const work = createRunnerWork({
    store: db,
    keyId: "sign-in",
    privateKey: generateKeyPairSync("ed25519").privateKey,
    eventKey: Buffer.alloc(32, 7),
    now: () => at,
  });
  const health = createRunnerHealth({ store: db, work, now: () => at });
  const runner = async (
    status: "active" | "paused" | "draining" | "revoked" = "active",
    lastSeenAt: number | null = at,
  ) => {
    const id = workspaceId();
    await seed(
      db,
      (q) =>
        q.orm.insert(q.t.runner).values({
          id,
          workspaceId: workspace,
          ownerUserId: userId,
          name: `Runner ${status}`,
          status,
          createdAt: at,
          lastSeenAt,
          revokedAt: status === "revoked" ? at : null,
        }),
      (q) =>
        q.orm
          .insert(q.t.runnerHostStatus)
          .values({ runnerId: id, runnerVersion: "0.1.53", reportedAt: at }),
    );
    return id;
  };
  const version = (runnerId: string, runnerVersion: string) =>
    seed(db, (q) =>
      q.orm
        .update(q.t.runnerHostStatus)
        .set({ runnerVersion })
        .where(eq(q.t.runnerHostStatus.runnerId, runnerId)),
    );
  const checks = async (runnerId?: string) =>
    (
      await db.run((q) =>
        q.all(
          q.orm
            .select({ envelope: q.t.runnerCommand.envelope })
            .from(q.t.runnerCommand)
            .where(eq(q.t.runnerCommand.kind, "login_check"))
            .orderBy(asc(q.t.runnerCommand.ordinal)),
        ),
      )
    )
      .map(
        (row) =>
          JSON.parse(
            Buffer.from((row.envelope as { payload: string }).payload, "base64url").toString(),
          ) as Extract<RunnerCommand, { type: "login_check" }>,
      )
      .filter((command) => !runnerId || command.runnerId === runnerId);
  const answer = (
    command: { id: string; runnerId: string; agent: string },
    authenticated = true,
    limits?: { window: string; usedPercent: number; resetsAt: number | null }[],
  ) =>
    health.submit(command.runnerId, {
      executionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      commandId: command.id,
      role: "implementer",
      stopReason: "end_turn",
      timedOut: false,
      cancelled: false,
      authRequired: false,
      agentExited: true,
      login: {
        agent: command.agent as "claude",
        authenticated,
        method: authenticated ? "subscription" : "none",
      },
      ...(limits ? { agentLimits: limits } : {}),
    });
  const seen = (runnerId: string) =>
    seed(db, (q) =>
      q.orm.update(q.t.runner).set({ lastSeenAt: at }).where(eq(q.t.runner.id, runnerId)),
    );
  const setPolicy = (runnerId: string, agent: string, values: AgentPolicy) =>
    seed(db, (q) =>
      q.orm
        .insert(q.t.runnerAgentPolicy)
        .values({ runnerId, agent, ...values })
        .onConflictDoUpdate({
          target: [q.t.runnerAgentPolicy.runnerId, q.t.runnerAgentPolicy.agent],
          set: values,
        }),
    );
  const policy = async (runnerId: string, agent: string) =>
    await db.run((q) =>
      q.one(
        q.orm
          .select()
          .from(q.t.runnerAgentPolicy)
          .where(
            and(
              eq(q.t.runnerAgentPolicy.runnerId, runnerId),
              eq(q.t.runnerAgentPolicy.agent, agent),
            ),
          ),
      ),
    );
  const used = (runnerId: string, agent: string, usedAt = at) =>
    setPolicy(runnerId, agent, { lastUsedAt: usedAt });
  const helpers = createRunnerHelpers({
    store: db,
    keyId: "sign-in",
    privateKey: generateKeyPairSync("ed25519").privateKey,
    now: () => at,
  });
  const helper = async (runnerId: string, purpose: "classify" | "conversation" = "classify") => {
    const sessionId = crypto.randomUUID();
    await recordLinearInstallation(db, {
      organizationId: "sign-in-org",
      oauthClientId: "app",
      appUserId: "app-user",
      sessionId,
      teamId: "team",
      observedAtMs: at,
    });
    const { command } = await helpers.dispatch({
      runnerId,
      sessionId,
      purpose,
      profile: { agent: "claude", model: null },
      prompt: "Which repository does this belong to?",
      ...(purpose === "conversation"
        ? {
            conversation: {
              itemId: "item",
              runId: "run",
              resumeSessionId: `claude-${sessionId}`,
            },
          }
        : {}),
    });
    return command;
  };
  const delivered = async (runnerId: string) =>
    (await work.commands(runnerId)).map((envelope) => {
      const command = JSON.parse(Buffer.from(envelope.payload, "base64url").toString()) as {
        id: string;
        type: string;
      };
      return command;
    });
  return {
    db,
    owner,
    work,
    health,
    runner,
    version,
    setPolicy,
    policy,
    checks,
    answer,
    seen,
    used,
    helper,
    helpers,
    delivered,
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

test("background sign-in checks run once per agent per interval and never while one is in flight", async () => {
  const f = await fixture();
  const runnerId = await f.runner();
  await f.health.refresh();
  expect((await f.checks()).map((check) => check.agent)).toEqual([
    "claude",
    "codex",
    "grok",
    "opencode",
  ]);
  expect((await f.checks()).every((check) => check.memberId === undefined)).toBe(true);
  await f.health.refresh();
  expect(await f.checks()).toHaveLength(4);
  const [claude, codex] = await f.checks();
  f.advance(10_000);
  await f.answer(claude!);
  await f.answer(codex!, false);
  await f.used(runnerId, "codex");

  f.advance(3 * 60_000);
  await f.seen(runnerId);
  await f.health.refresh();
  expect(await f.checks()).toHaveLength(4);

  f.advance(2 * 60_000 - 5_000);
  await f.seen(runnerId);
  await f.health.refresh();
  expect((await f.checks()).slice(4).map((check) => check.agent)).toEqual(["grok", "opencode"]);

  f.advance(10_000);
  await f.seen(runnerId);
  await f.health.refresh();
  expect((await f.checks()).slice(6).map((check) => check.agent)).toEqual(["codex"]);
  expect(
    await f.db.run((q) =>
      q.all(q.orm.select().from(q.t.runnerCommand).where(eq(q.t.runnerCommand.kind, "probe"))),
    ),
  ).toEqual([]);

  const inFlight = (await f.checks()).length;
  await f.work.enqueue({
    id: crypto.randomUUID(),
    type: "login_check",
    runnerId,
    workspaceId: f.owner.workspaceId,
    agent: "claude",
    issuedAt: f.now(),
    expiresAt: f.now() + 20 * 60_000,
  });
  f.advance(6 * 60_000);
  await f.seen(runnerId);
  await f.health.refresh();
  expect((await f.checks()).slice(inFlight + 1).map((check) => check.agent)).toEqual([
    "codex",
    "grok",
    "opencode",
  ]);
});

test("four signed-in agents get at most one passing check each in 30 minutes", async () => {
  const f = await fixture();
  const runnerId = await f.runner();
  await f.health.refresh();
  for (const check of await f.checks()) await f.answer(check);
  for (let minute = 5; minute <= 30; minute += 5) {
    f.advance(5 * 60_000);
    await f.seen(runnerId);
    await f.health.refresh();
    expect(await f.checks()).toHaveLength(4);
  }
  f.advance(1);
  await f.seen(runnerId);
  await f.health.refresh();
  expect((await f.checks()).slice(4).map((check) => check.agent)).toEqual([
    "claude",
    "codex",
    "grok",
    "opencode",
  ]);
});

test("a pending helper goes out before a queued login check, which waits until the helper finishes", async () => {
  const f = await fixture();
  const runnerId = await f.runner();
  await f.health.refresh();
  expect((await f.delivered(runnerId)).map(({ type }) => type)).toEqual(["login_check"]);
  const [first] = await f.delivered(runnerId);
  await f.work.acknowledge(runnerId, first!.id);
  await f.answer({ id: first!.id, runnerId, agent: "claude" });

  const helper = await f.helper(runnerId);
  expect(await f.helpers.commands(runnerId)).toHaveLength(1);
  expect(await f.delivered(runnerId)).toEqual([]);

  await f.helpers.acknowledge(runnerId, helper.id);
  expect(await f.delivered(runnerId)).toEqual([]);

  await f.helpers.finish(helper.id);
  expect((await f.delivered(runnerId)).map(({ type }) => type)).toEqual(["login_check"]);
});

test("a helper that expired unserved, or a conversation in its own lane, holds no check back", async () => {
  const f = await fixture();
  const runnerId = await f.runner();
  await f.version(runnerId, "0.1.77");
  await recordRunnerCapacity(f.db, runnerId, 1, 1, 2);
  await f.health.refresh();
  await f.helper(runnerId, "conversation");
  expect((await f.delivered(runnerId)).map(({ type }) => type)).toEqual(["login_check"]);

  const g = await fixture();
  const other = await g.runner();
  await g.health.refresh();
  await g.helper(other);
  expect(await g.delivered(other)).toEqual([]);
  g.advance(60_001);
  expect((await g.delivered(other)).map(({ type }) => type)).toEqual(["login_check"]);
});

test("no check is queued while a helper waits for the lane", async () => {
  const f = await fixture();
  const runnerId = await f.runner();
  await f.helper(runnerId);
  await f.health.refresh();
  expect(await f.checks()).toHaveLength(0);
});

test("a signed-out agent, and one whose check failed, is still checked every 5 minutes", async () => {
  const f = await fixture();
  const runnerId = await f.runner();
  await f.health.refresh();
  const [claude, codex] = await f.checks();
  await f.answer(codex!, false);
  await f.answer(claude!);
  await f.used(runnerId, "codex");
  await f.used(runnerId, "claude");
  await f.setPolicy(runnerId, "claude", { ready: 0, authExpired: 1 });
  const count = async (agent: string) =>
    (await f.checks(runnerId)).filter((check) => check.agent === agent).length;
  for (let round = 1; round <= 3; round += 1) {
    f.advance(5 * 60_000 + 1);
    await f.seen(runnerId);
    await f.health.refresh();
    expect(await count("claude")).toBe(1 + round);
    expect(await count("codex")).toBe(1 + round);
    await f.answer(
      (await f.checks(runnerId)).findLast((check) => check.agent === "codex")!,
      false,
    );
  }
});

test("a signed-out agent not used for a day is left alone, and one signed in is still checked", async () => {
  const f = await fixture();
  const runnerId = await f.runner();
  await f.health.refresh();
  const [claude, codex] = await f.checks();
  await f.answer(claude!);
  await f.answer(codex!, false);
  await f.used(runnerId, "codex", f.now() - 24 * 60 * 60_000);
  f.advance(31 * 60_000);
  await f.seen(runnerId);
  await f.health.refresh();
  const later = (await f.checks()).slice(4).map((check) => check.agent);
  expect(later).toContain("claude");
  expect(later).not.toContain("codex");
});

test("paused, draining, revoked and unseen runners are skipped", async () => {
  const f = await fixture();
  const active = await f.runner();
  for (const status of ["paused", "draining", "revoked"] as const) await f.runner(status);
  await f.runner("active", null);
  await f.runner("active", f.now() - 2 * 60_000);
  await f.health.refresh();
  expect(new Set((await f.checks()).map((check) => check.runnerId))).toEqual(new Set([active]));
});

test("runner list reports signed in, signed out, checking, usage limit and unknown per agent", async () => {
  const f = await fixture();
  const runnerId = await f.runner();
  const statuses = async () =>
    Object.fromEntries(
      (await f.health.agents(f.owner, runnerId)).map(({ agent, ...rest }) => [agent, rest]),
    );
  expect(await statuses()).toEqual({
    claude: { status: "unknown", checkedAt: null },
    codex: { status: "unknown", checkedAt: null },
    grok: { status: "unknown", checkedAt: null },
    opencode: { status: "unknown", checkedAt: null },
  });
  await f.health.refresh();
  expect((await statuses()).claude!.status).toBe("checking");
  const [claude, codex] = await f.checks();
  await f.answer(claude!);
  await f.answer(codex!, false);
  expect(await statuses()).toEqual({
    claude: { status: "signed_in", checkedAt: f.now() },
    codex: { status: "signed_out", checkedAt: f.now() },
    grok: { status: "checking", checkedAt: null },
    opencode: { status: "checking", checkedAt: null },
  });
  const resetsAt = f.now() + 3_600_000;
  await f.setPolicy(runnerId, "claude", {
    quotaState: "exhausted",
    resetsAt,
    cooldownUntil: resetsAt,
  });
  expect((await statuses()).claude).toEqual({
    status: "usage_limit",
    checkedAt: f.now(),
    resetsAt,
  });
  f.advance(3_600_001);
  expect((await statuses()).claude!.status).toBe("signed_in");

  const http = createRunnerHttp(
    {
      list: () => [{ id: runnerId, name: "Runner active", status: "active" }],
      serverVersion: () => null,
      agentVersions: () => [],
    } as unknown as RunnerControl,
    { agents: (principal, id) => f.health.agents(principal, id) },
  );
  const response = await http.browser(
    new Request("https://paws.example.invalid/api/runners"),
    f.owner,
    [],
  );
  const body = (await response!.json()) as {
    runners: { agents: { agent: string; status: string }[] }[];
  };
  expect(body.runners[0]!.agents.map(({ agent, status }) => [agent, status])).toEqual([
    ["claude", "signed_in"],
    ["codex", "signed_out"],
    ["grok", "unknown"],
    ["opencode", "unknown"],
  ]);
});

test("a spent usage window cools the agent down unless the runner keeps it on extra usage", async () => {
  for (const extra of [0, 1]) {
    const f = await fixture();
    const runnerId = await f.runner();
    await f.setPolicy(runnerId, "claude", { extraUsage: extra });
    await f.health.refresh();
    const [claude] = await f.checks();
    const resetsAt = f.now() + 3_600_000;
    await f.answer(claude!, true, [
      { window: "5-hour", usedPercent: 100, resetsAt },
      { window: "Weekly", usedPercent: 46, resetsAt: null },
    ]);
    expect(await f.policy(runnerId, "claude")).toMatchObject(
      extra
        ? { quotaState: "spent_extra", cooldownUntil: 0 }
        : { quotaState: "exhausted", cooldownUntil: resetsAt },
    );
    const status = (await f.health.agents(f.owner, runnerId))[0]!;
    expect(status.status).toBe(extra ? "extra_usage" : "usage_limit");
    expect(status.extraUsage).toBe(extra ? true : undefined);
  }
});

test("the latest usage windows reach the runner list with when they were read", async () => {
  const f = await fixture();
  const runnerId = await f.runner();
  await f.health.refresh();
  const [claude] = await f.checks();
  const limits = [
    { window: "5-hour", usedPercent: 16, resetsAt: f.now() + 3_600_000 },
    { window: "Weekly", usedPercent: 3, resetsAt: null },
  ];
  await f.answer(claude!, true, limits);
  const status = async () => (await f.health.agents(f.owner, runnerId))[0]!;
  expect(await status()).toEqual({
    agent: "claude",
    status: "signed_in",
    checkedAt: f.now(),
    limits,
    limitsAt: f.now(),
  });
  const resetsAt = f.now() + 60_000;
  await f.setPolicy(runnerId, "claude", {
    quotaState: "exhausted",
    resetsAt,
    cooldownUntil: resetsAt,
  });
  expect(await status()).toEqual({
    agent: "claude",
    status: "usage_limit",
    checkedAt: f.now(),
    resetsAt,
    limits,
    limitsAt: f.now(),
  });
  const schema = RunnerHealthResultSchema.shape.agentLimits;
  expect(schema.safeParse(limits).success).toBe(true);
  expect(schema.safeParse([]).success).toBe(false);
  for (const bad of [
    { window: "5-hour", usedPercent: 101, resetsAt: null },
    { window: "", usedPercent: 5, resetsAt: null },
    { window: "5-hour", usedPercent: 5, resetsAt: 1.5 },
    { window: "5-hour", usedPercent: 5, resetsAt: null, balance: "855" },
  ])
    expect(schema.safeParse([bad]).success).toBe(false);
});

test("an older usage reading never replaces a newer one", async () => {
  const f = await fixture();
  const runnerId = await f.runner();
  const reading = (usedPercent: number) => [{ window: "Weekly", usedPercent, resetsAt: null }];
  const record = async (usedPercent: number, observedAt: number) =>
    await recordRunnerAgentUsage(f.db, {
      runnerId,
      agent: "codex",
      limits: reading(usedPercent),
      observedAt,
    });
  await record(40, 2_000);
  await record(10, 1_000);
  expect(await runnerAgentUsage(f.db, runnerId, "codex")).toEqual({
    limits: reading(40),
    observedAt: 2_000,
  });
  await record(55, 3_000);
  expect((await runnerAgentUsage(f.db, runnerId, "codex"))!.limits).toEqual(reading(55));
  expect(await runnerAgentUsage(f.db, runnerId, "claude")).toBeNull();
});

test("a completed sign-in queues one login check for that agent", async () => {
  const f = await fixture();
  const runnerId = await f.runner();
  const login = createRunnerLogin({
    store: f.db,
    work: f.work,
    now: f.now,
    onSignedIn: (signedIn) => f.health.afterSignIn(signedIn.runnerId, signedIn.agent),
  });
  const session = await login.start(f.owner, runnerId, "claude");
  expect(await f.checks()).toHaveLength(0);
  await login.exchange(runnerId, session.id, {
    state: "connected",
    terminal: "",
    authorization: null,
    inputId: null,
  });
  expect((await f.checks()).map(({ agent, memberId }) => [agent, memberId])).toEqual([
    ["claude", undefined],
  ]);
  expect(await f.health.afterSignIn(runnerId, "claude")).toBe(false);
  expect(
    (await f.health.agents(f.owner, runnerId)).map(({ agent, status }) => [agent, status]),
  ).toEqual([
    ["claude", "checking"],
    ["codex", "unknown"],
    ["grok", "unknown"],
    ["opencode", "unknown"],
  ]);
});

test("a sign-in goes to the runner before sign-in checks queued ahead of it", async () => {
  const f = await fixture();
  const runnerId = await f.runner();
  const login = createRunnerLogin({ store: f.db, work: f.work, now: f.now });
  for (const agent of ["codex", "grok"] as const)
    await f.work.enqueue({
      id: crypto.randomUUID(),
      type: "login_check",
      runnerId,
      workspaceId: f.owner.workspaceId,
      agent,
      issuedAt: f.now(),
      expiresAt: f.now() + 120_000,
    });
  const session = await login.start(f.owner, runnerId, "claude");
  const delivered = async () =>
    (await f.work.commands(runnerId)).map((envelope) => {
      const command = JSON.parse(Buffer.from(envelope.payload, "base64url").toString()) as {
        id: string;
        type: string;
        agent: string;
      };
      return { id: command.id, label: `${command.type} ${command.agent}` };
    });
  expect((await delivered()).map(({ label }) => label)).toEqual(["login claude"]);

  await f.work.acknowledge(runnerId, session.id);
  expect(await delivered()).toEqual([]);
  await login.exchange(runnerId, session.id, {
    state: "connected",
    terminal: "",
    authorization: null,
    inputId: null,
  });
  const [codex] = await delivered();
  expect(codex?.label).toBe("login_check codex");
  expect((await delivered()).map(({ label }) => label)).toEqual(["login_check codex"]);

  await f.work.acknowledge(runnerId, codex!.id);
  expect(await delivered()).toEqual([]);
  await f.answer({ id: codex!.id, runnerId, agent: "codex" });
  expect((await delivered()).map(({ label }) => label)).toEqual(["login_check grok"]);
});

test("a login check readies the runner's agent or marks it signed out", async () => {
  const f = await fixture();
  const runnerId = await f.runner();
  const policy = async () => {
    const row = await f.policy(runnerId, "grok");
    return row && { ready: row.ready, authExpired: row.authExpired };
  };
  await f.health.refresh();
  await f.answer((await f.checks(runnerId)).find((command) => command.agent === "grok")!);
  expect(await policy()).toEqual({ ready: 1, authExpired: 0 });
  f.advance(30 * 60_000 + 1);
  await f.seen(runnerId);
  await f.health.refresh();
  await f.answer(
    (await f.checks(runnerId)).findLast((command) => command.agent === "grok")!,
    false,
  );
  expect(await policy()).toEqual({ ready: 0, authExpired: 1 });
});

test("a login check issued before a newer sign-in failure cannot mark the agent ready", async () => {
  const f = await fixture();
  const runnerId = await f.runner();
  const policy = async () => {
    const row = await f.policy(runnerId, "claude");
    return row && { ready: row.ready, authExpired: row.authExpired };
  };
  await f.health.refresh();
  const late = (await f.checks(runnerId)).find((command) => command.agent === "claude")!;
  f.advance(10_000);
  await f.setPolicy(runnerId, "claude", { ready: 0, authExpired: 1 });
  await recordAccountObservation(f.db, {
    bindingId: legacyAgentBindingId(runnerId, "claude"),
    source: "result",
    sourceId: "failed-run",
    observedAt: f.now(),
    now: f.now(),
    state: "auth_required",
  });
  f.advance(10_000);
  await f.answer(late);
  expect(await policy()).toEqual({ ready: 0, authExpired: 1 });
  await f.used(runnerId, "claude");

  f.advance(5 * 60_000 + 1);
  await f.seen(runnerId);
  await f.health.refresh();
  await f.answer((await f.checks(runnerId)).findLast((command) => command.agent === "claude")!);
  expect(await policy()).toEqual({ ready: 1, authExpired: 0 });
});

test("a sign-in check's usage reading replaces a stale usage limit", async () => {
  const f = await fixture();
  const runnerId = await f.runner();
  const reset = f.now() + 3 * 86_400_000;
  await f.setPolicy(runnerId, "claude", {
    ready: 1,
    authExpired: 0,
    quotaState: "exhausted",
    resetsAt: reset,
    cooldownUntil: reset,
  });
  const policy = async () => {
    const row = await f.policy(runnerId, "claude");
    return (
      row && {
        quotaState: row.quotaState,
        resetsAt: row.resetsAt,
        cooldownUntil: row.cooldownUntil,
      }
    );
  };
  const claude = async () =>
    (await f.checks(runnerId)).findLast((command) => command.agent === "claude")!;
  await f.health.refresh();
  await f.answer(await claude(), true, [
    { window: "5-hour", usedPercent: 0, resetsAt: null },
    { window: "Weekly", usedPercent: 8, resetsAt: reset + 16 * 3_600_000 },
  ]);
  expect(await policy()).toEqual({ quotaState: "ok", resetsAt: null, cooldownUntil: 0 });

  f.advance(30 * 60_000 + 1);
  await f.seen(runnerId);
  await f.health.refresh();
  await f.answer(await claude(), true, [
    { window: "5-hour", usedPercent: 12, resetsAt: null },
    { window: "Weekly", usedPercent: 100, resetsAt: reset },
  ]);
  expect(await policy()).toEqual({
    quotaState: "exhausted",
    resetsAt: reset,
    cooldownUntil: reset,
  });

  f.advance(30 * 60_000 + 1);
  await f.seen(runnerId);
  await f.health.refresh();
  await f.answer(await claude());
  expect(await policy()).toEqual({
    quotaState: "exhausted",
    resetsAt: reset,
    cooldownUntil: reset,
  });
});

test("older runners keep their three login checks and reject OpenCode before dispatch", async () => {
  const f = await fixture();
  const runnerId = await f.runner();
  await f.version(runnerId, "0.1.52");
  await f.health.refresh();
  expect((await f.checks()).map((command) => command.agent)).toEqual(["claude", "codex", "grok"]);
  await expect(
    f.health.request(f.owner, runnerId, { type: "login_check", agent: "opencode" }),
  ).rejects.toThrow("OpenCode needs runner 0.1.53");
  expect(await f.checks()).toHaveLength(3);
  await f.version(runnerId, "0.1.53");
  await f.health.refresh();
  expect((await f.checks()).map((command) => command.agent)).toEqual([
    "claude",
    "codex",
    "grok",
    "opencode",
  ]);
});
