import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import {
  putWorkspaceUser,
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
import { createRunnerHttp, type RunnerControl } from "../src/runner-control";
import { workspaceId, type WorkspacePrincipal } from "../src/workspace";
import { RunnerHealthResultSchema, type RunnerCommand } from "../src/runner-protocol";
import { seed } from "./pglite-fixtures";
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
          .values({ runnerId: id, runnerVersion: "0.1.84", reportedAt: at }),
    );
    return id;
  };
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

test("an agent whose check failed is still checked every 5 minutes", async () => {
  const f = await fixture();
  const runnerId = await f.runner();
  await f.health.refresh();
  const [claude, codex] = await f.checks();
  await f.answer(codex!, false);
  await f.answer(claude!, false);
  await f.used(runnerId, "codex");
  await f.used(runnerId, "claude");
  const count = async (agent: string) =>
    (await f.checks(runnerId)).filter((check) => check.agent === agent).length;
  for (let round = 1; round <= 3; round += 1) {
    f.advance(5 * 60_000 + 1);
    await f.seen(runnerId);
    await f.health.refresh();
    expect(await count("claude")).toBe(1 + round);
    expect(await count("codex")).toBe(1 + round);
    for (const agent of ["claude", "codex"])
      await f.answer(
        (await f.checks(runnerId)).findLast((check) => check.agent === agent)!,
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

test("the runner list has no per-runner agent sign-in or usage", async () => {
  const f = await fixture();
  const runnerId = await f.runner();
  await f.health.refresh();
  const [claude] = await f.checks();
  await f.answer(claude!);
  const http = createRunnerHttp({
    list: () => [{ id: runnerId, name: "Runner active", status: "active" }],
    serverVersion: () => null,
    agentVersions: () => [],
  } as unknown as RunnerControl);
  const response = await http.browser(
    new Request("https://paws.example.invalid/api/runners"),
    f.owner,
    [],
  );
  const body = (await response!.json()) as { runners: Record<string, unknown>[] };
  expect(body.runners).toEqual([{ id: runnerId, name: "Runner active", status: "active" }]);
  expect("agents" in body.runners[0]!).toBe(false);
});

test("a spent usage window cools the agent down even with a stored per-runner extra-usage flag", async () => {
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
    expect(await f.policy(runnerId, "claude")).toMatchObject({
      quotaState: "exhausted",
      cooldownUntil: resetsAt,
    });
  }
});

test("the latest usage windows are stored with when they were read", async () => {
  const f = await fixture();
  const runnerId = await f.runner();
  await f.health.refresh();
  const [claude] = await f.checks();
  const limits = [
    { window: "5-hour", usedPercent: 16, resetsAt: f.now() + 3_600_000 },
    { window: "Weekly", usedPercent: 3, resetsAt: null },
  ];
  await f.answer(claude!, true, limits);
  expect(await runnerAgentUsage(f.db, runnerId, "claude")).toEqual({
    limits,
    observedAt: f.now(),
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

test("a sign-in check's usage reading replaces a stale usage limit", async () => {
  const f = await fixture();
  const runnerId = await f.runner();
  const reset = f.now() + 3 * 86_400_000;
  await f.setPolicy(runnerId, "claude", {
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

test("a sign-in check asked for after an auth error waits for the runner's answer", async () => {
  const f = await fixture();
  const runnerId = await f.runner();
  const signal = new AbortController().signal;
  for (const authenticated of [true, false]) {
    const pending = f.health.signedIn(runnerId, "claude", signal, 5);
    let command: Awaited<ReturnType<typeof f.checks>>[number] | undefined;
    while (!command) {
      await Bun.sleep(5);
      command = (await f.checks(runnerId)).at(authenticated ? 0 : 1);
    }
    f.advance(1_000);
    await f.answer(command, authenticated);
    expect(await pending).toBe(authenticated);
    f.advance(10 * 60_000);
  }
  expect(await f.health.signedIn(runnerId, "unknown-agent", signal)).toBe(false);
});
