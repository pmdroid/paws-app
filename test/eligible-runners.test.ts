import { MINIMUM_RUNNER_VERSION } from "../src/runner-protocol";
import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  bindAgentAccount,
  createAgentAccount,
  recordAccountObservation,
  consumeWorkspaceBootstrap,
  insertQueuedItem,
  putWorkspaceUser,
  syncWorkspaceMember,
  type Q,
} from "../src/db";
import {
  eligibleRunnersSteps,
  itemOwnerRunnerSetupNeedSteps,
  itemRepositoryRunnerSteps,
  RUNNER_ONLINE_MS,
  type EligibleRunnerReason,
  type EligibleRunnersInput,
} from "../src/runner-placement";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../src/workspace";
import { seed, seedCredential } from "./pglite-fixtures";
import { tempStore } from "./pglite";

type Member = { role: "member" | "admin"; active: boolean; teamIds: string[] };
type Runner = {
  owner: string;
  version?: string | null;
  isolation?: "none" | "issue_vm";
  status?: "active" | "paused" | "draining" | "revoked";
  seenAgoMs?: number;
  ready?: number;
  authExpired?: number;
  healthFailure?: string;
};

const MEMBERS: Record<string, Member> = {
  me: { role: "member", active: true, teamIds: ["team"] },
  lead: { role: "member", active: true, teamIds: ["team"] },
  colleague: { role: "member", active: true, teamIds: ["team"] },
  outsider: { role: "member", active: true, teamIds: ["other"] },
  "outside-admin": { role: "admin", active: true, teamIds: ["other"] },
  gone: { role: "member", active: false, teamIds: ["team"] },
};

async function workspace(runners: Record<string, Runner>) {
  const { db, close } = await tempStore();
  const now = Date.now();
  const founder = await putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "founder",
    name: "Founder",
    email: "founder@example.invalid",
  });
  const ws = await consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "org",
    name: "Test",
    userId: founder,
    tokenHash: workspaceTokenHash(await issueWorkspaceBootstrap(db, "org", now)),
    now,
  });
  const users: Record<string, string> = {};
  for (const [name, member] of Object.entries(MEMBERS)) {
    users[name] = await putWorkspaceUser(db, {
      id: workspaceId(),
      linearUserId: name,
      name,
      email: `${name}@example.invalid`,
    });
    await syncWorkspaceMember(db, {
      workspaceId: ws.id,
      userId: users[name]!,
      ...member,
      now,
    });
  }
  for (const [id, runner] of Object.entries(runners)) {
    await seed(
      db,
      (q) =>
        q.orm.insert(q.t.runner).values({
          id,
          workspaceId: ws.id,
          ownerUserId: users[runner.owner]!,
          name: id,
          status: runner.status ?? "active",
          createdAt: now,
          lastSeenAt: now - (runner.seenAgoMs ?? 0),
          revokedAt: runner.status === "revoked" ? now : null,
          isolation: runner.isolation ?? "none",
        }),
      (q) => q.orm.insert(q.t.runnerAgentPolicy).values({ runnerId: id, agent: "codex" }),
    );
    await seed(db, (q) =>
      q.orm.insert(q.t.runnerHostStatus).values({
        runnerId: id,
        runnerVersion:
          runner.version === undefined ? MINIMUM_RUNNER_VERSION.join(".") : runner.version,
        healthFailure: runner.healthFailure ?? null,
        reportedAt: now,
      }),
    );
    if (runner.ready !== 0 && runner.status !== "revoked") {
      const account = await createAgentAccount(db, {
        ownerUserId: users[runner.owner]!,
        workspaceId: ws.id,
        agent: "codex",
        label: id,
        now,
      });
      await seedCredential(db, account.id, "codex", now);
      const binding = await bindAgentAccount(db, {
        userId: users[runner.owner]!,
        workspaceId: ws.id,
        accountId: account.id,
        runnerId: id,
        now,
      });
      if (runner.authExpired === 1)
        await recordAccountObservation(db, {
          bindingId: binding.id,
          state: "auth_required",
          source: "result",
          sourceId: id,
          observedAt: now,
          now,
        });
    }
  }
  return {
    db,
    ws,
    users,
    now,
    check(input: Partial<EligibleRunnersInput> = {}) {
      const rest = Object.fromEntries(
        Object.entries(input).filter(([, value]) => value !== undefined),
      );
      return db.run((q) =>
        eligibleRunnersSteps(q, {
          workspaceId: ws.id,
          teamId: "team",
          ownerUserId: users.me!,
          agent: "codex",
          purpose: "work",
          now,
          ...rest,
        }),
      );
    },
    close,
  };
}

const CASES: {
  name: string;
  runner: Runner;
  purpose?: EligibleRunnersInput["purpose"];
  reason: EligibleRunnerReason;
}[] = [
  { name: "an older runner", runner: { owner: "me", version: "0.1.83" }, reason: "outdated" },
  {
    name: "a runner without a version",
    runner: { owner: "me", version: null },
    reason: "outdated",
  },
  {
    name: "a runner without a version while preparing",
    runner: { owner: "me", version: null },
    purpose: "prepare",
    reason: "own",
  },
  {
    name: "an enrolled runner that has not reported yet",
    runner: { owner: "me", version: null, seenAgoMs: RUNNER_ONLINE_MS },
    reason: "offline",
  },
  { name: "the delegator's own runner", runner: { owner: "me" }, reason: "own" },
  {
    name: "a project lead's runner without isolation",
    runner: { owner: "lead", isolation: "none" },
    reason: "not-yours",
  },
  {
    name: "another member's runner without isolation",
    runner: { owner: "colleague" },
    reason: "not-yours",
  },
  {
    name: "another member's issue VM runner",
    runner: { owner: "colleague", isolation: "issue_vm" },
    reason: "issue-vm",
  },
  {
    name: "the delegator's own issue VM runner",
    runner: { owner: "me", isolation: "issue_vm" },
    reason: "own",
  },
  {
    name: "another member's paused issue VM runner",
    runner: { owner: "colleague", isolation: "issue_vm", status: "paused" },
    reason: "paused",
  },
  {
    name: "another member's issue VM runner whose agent is not signed in",
    runner: { owner: "colleague", isolation: "issue_vm", ready: 0 },
    reason: "agent-not-signed-in",
  },
  {
    name: "another member's outdated issue VM runner",
    runner: { owner: "colleague", isolation: "issue_vm", version: "0.1.83" },
    reason: "outdated",
  },
  {
    name: "an own runner without a recent heartbeat",
    runner: { owner: "me", seenAgoMs: RUNNER_ONLINE_MS },
    reason: "offline",
  },
  { name: "a paused own runner", runner: { owner: "me", status: "paused" }, reason: "paused" },
  {
    name: "a draining own runner",
    runner: { owner: "me", status: "draining" },
    reason: "paused",
  },
  {
    name: "an own runner whose agent is not signed in",
    runner: { owner: "me", ready: 0 },
    reason: "agent-not-signed-in",
  },
  {
    name: "an own runner whose agent sign-in expired",
    runner: { owner: "me", authExpired: 1 },
    reason: "auth-expired",
  },
  {
    name: "an issue VM runner whose owner is outside the team and not an admin",
    runner: { owner: "outsider", isolation: "issue_vm" },
    reason: "owner-not-in-team",
  },
  {
    name: "an issue VM runner whose owner is an admin outside the team",
    runner: { owner: "outside-admin", isolation: "issue_vm" },
    reason: "issue-vm",
  },
  {
    name: "an issue VM runner whose owner is no longer active",
    runner: { owner: "gone", isolation: "issue_vm" },
    reason: "owner-inactive",
  },
  {
    name: "an own runner with no signed-in agent while preparing",
    runner: { owner: "me", ready: 0, authExpired: 1 },
    purpose: "prepare",
    reason: "own",
  },
  {
    name: "an own runner with no bound account for a helper",
    runner: { owner: "me", ready: 0 },
    purpose: "helper",
    reason: "agent-not-signed-in",
  },
];

for (const row of CASES)
  test(`eligibleRunners: ${row.name} is ${row.reason}`, async () => {
    const ws = await workspace({ runner: row.runner });
    try {
      const result = await ws.check({ purpose: row.purpose });
      expect(result.map(({ id, eligible, reason }) => ({ id, eligible, reason }))).toEqual([
        {
          id: "runner",
          eligible: row.reason === "own" || row.reason === "issue-vm",
          reason: row.reason,
        },
      ]);
    } finally {
      await ws.close();
    }
  });

test("eligibleRunners lists every unrevoked runner in the workspace in id order", async () => {
  const ws = await workspace({
    b: { owner: "colleague" },
    a: { owner: "me" },
    c: { owner: "lead", isolation: "issue_vm" },
    gone: { owner: "me", status: "revoked" },
  });
  try {
    expect((await ws.check()).map(({ id, reason }) => [id, reason])).toEqual([
      ["a", "own"],
      ["b", "not-yours"],
      ["c", "issue-vm"],
    ]);
  } finally {
    await ws.close();
  }
});

test("eligibleRunners reads only the database", async () => {
  const ws = await workspace({ mine: { owner: "me" } });
  const real = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    throw new Error("eligibleRunners must not reach the network");
  }) as unknown as typeof fetch;
  try {
    const result = await ws.check();
    expect(result).toBeArray();
    expect(requests).toBe(0);
  } finally {
    globalThis.fetch = real;
    await ws.close();
  }
});

test("a runner with an unacknowledged cancel stays online; capacity accounts for its cleanup", async () => {
  const space = await workspace({ box: { owner: "me" } });
  const now = Date.now();
  try {
    await seed(space.db, (q) =>
      q.orm.insert(q.t.runnerCommand).values({
        id: "live-cancel",
        runnerId: "box",
        kind: "cancel",
        envelope: "{}",
        expiresAt: now + 60_000,
      }),
    );
    expect((await space.check({ now })).map((runner) => runner.reason)).toEqual(["own"]);
  } finally {
    await space.close();
  }
});

test("a repository command goes to the item's last runner while it is eligible and current, then to another", async () => {
  const w = await workspace({ first: { owner: "me" }, last: { owner: "me", ready: 0 } });
  try {
    const { db, now } = w;
    const repositoryRunner = () =>
      db.run((q) => itemRepositoryRunnerSteps(q, { itemId: "item", now }));
    const version = (runnerVersion: string, runnerId?: string) => (q: Q) =>
      q.orm
        .update(q.t.runnerHostStatus)
        .set({ runnerVersion })
        .where(runnerId === undefined ? undefined : eq(q.t.runnerHostStatus.runnerId, runnerId));
    await seed(db, (q) =>
      q.orm.insert(q.t.linearSession).values({
        sessionId: "ses",
        organizationId: "org",
        teamId: "team",
        createdAt: now,
      }),
    );
    await insertQueuedItem(db, { id: "item", now, sessionKey: "ses" });
    await seed(
      db,
      (q) =>
        q.orm
          .update(q.t.workItem)
          .set({ ownerUserId: w.users.me! })
          .where(eq(q.t.workItem.id, "item")),
      (q) =>
        q.orm
          .insert(q.t.runnerHostStatus)
          .values(
            ["first", "last"].map((runnerId) => ({
              runnerId,
              runnerVersion: MINIMUM_RUNNER_VERSION.join("."),
              reportedAt: now,
            })),
          )
          .onConflictDoUpdate({
            target: q.t.runnerHostStatus.runnerId,
            set: { runnerVersion: MINIMUM_RUNNER_VERSION.join(".") },
          }),
      (q) =>
        q.orm.insert(q.t.run).values({
          id: "run",
          itemId: "item",
          kind: "implement",
          agent: "codex",
          status: "ended",
          createdAt: now,
          updatedAt: now,
        }),
      (q) =>
        q.orm.insert(q.t.runnerWork).values({
          runId: "run",
          runnerId: "last",
          workspaceId: w.ws.id,
          generation: 1,
          runnerFence: 0,
          commandId: "cmd",
          leaseUntil: now,
        }),
    );
    expect(await repositoryRunner()).toEqual({
      id: "last",
      workspaceId: w.ws.id,
    });
    await seed(db, version("0.1.83", "last"));
    expect((await repositoryRunner())?.id).toBe("first");
    await seed(db, version(MINIMUM_RUNNER_VERSION.join(".")), (q) =>
      q.orm
        .update(q.t.runner)
        .set({ lastSeenAt: now - RUNNER_ONLINE_MS })
        .where(eq(q.t.runner.id, "last")),
    );
    expect((await repositoryRunner())?.id).toBe("first");
    await seed(db, version("0.1.83", "first"));
    expect(await repositoryRunner()).toBeNull();
  } finally {
    await w.close();
  }
});

for (const [label, runner, reason] of [
  ["outdated", { owner: "me", version: "0.1.83" }, "outdated"],
  ["unhealthy", { owner: "me", healthFailure: "EACCES" }, "unhealthy"],
] as const)
  test(`an owner whose only runner is ${label} is not told to add a runner`, async () => {
    const w = await workspace({ old: runner });
    try {
      const { db, now } = w;
      await seed(db, (q) =>
        q.orm.insert(q.t.linearSession).values({
          sessionId: "ses",
          organizationId: "org",
          teamId: "team",
          createdAt: now,
        }),
      );
      await insertQueuedItem(db, { id: "item", now, sessionKey: "ses" });
      await seed(db, (q) =>
        q.orm
          .update(q.t.workItem)
          .set({ ownerUserId: w.users.me! })
          .where(eq(q.t.workItem.id, "item")),
      );
      expect(await w.check()).toMatchObject([
        { eligible: false, reason, ...(reason === "unhealthy" ? { healthFailure: "EACCES" } : {}) },
      ]);
      expect(
        await db.run((q) =>
          itemOwnerRunnerSetupNeedSteps(q, { itemId: "item", agent: "codex", now }),
        ),
      ).toBeNull();
    } finally {
      await w.close();
    }
  });
