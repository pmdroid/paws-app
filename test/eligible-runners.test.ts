import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  consumeWorkspaceBootstrap,
  migrate,
  openDatabase,
  putWorkspaceUser,
  syncWorkspaceMember,
} from "../src/db";
import {
  eligibleRunners,
  RUNNER_ONLINE_MS,
  type EligibleRunnerReason,
  type EligibleRunnersInput,
} from "../src/runner-placement";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../src/workspace";

type Member = { role: "member" | "admin"; active: boolean; teamIds: string[] };
type Runner = {
  owner: string;
  sharing?: number;
  status?: "active" | "paused" | "draining" | "revoked";
  seenAgoMs?: number;
  ready?: number;
  authExpired?: number;
};

const MEMBERS: Record<string, Member> = {
  me: { role: "member", active: true, teamIds: ["team"] },
  lead: { role: "member", active: true, teamIds: ["team"] },
  colleague: { role: "member", active: true, teamIds: ["team"] },
  outsider: { role: "member", active: true, teamIds: ["other"] },
  "outside-admin": { role: "admin", active: true, teamIds: ["other"] },
  gone: { role: "member", active: false, teamIds: ["team"] },
};

function workspace(runners: Record<string, Runner>) {
  const root = mkdtempSync(join(tmpdir(), "paws-eligible-"));
  const db = openDatabase(join(root, "paws.sqlite"));
  migrate(db);
  const now = Date.now();
  const founder = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "founder",
    name: "Founder",
    email: "founder@example.invalid",
  });
  const ws = consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "org",
    name: "Test",
    userId: founder,
    tokenHash: workspaceTokenHash(issueWorkspaceBootstrap(db, "org", now)),
    now,
  });
  const users: Record<string, string> = {};
  for (const [name, member] of Object.entries(MEMBERS)) {
    users[name] = putWorkspaceUser(db, {
      id: workspaceId(),
      linearUserId: name,
      name,
      email: `${name}@example.invalid`,
    });
    syncWorkspaceMember(db, { workspaceId: ws.id, userId: users[name]!, ...member, now });
  }
  for (const [id, runner] of Object.entries(runners)) {
    db.run(
      "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at,revoked_at) VALUES(?,?,?,?,?,?,?,?)",
      [
        id,
        ws.id,
        users[runner.owner]!,
        id,
        runner.status ?? "active",
        now,
        now - (runner.seenAgoMs ?? 0),
        runner.status === "revoked" ? now : null,
      ],
    );
    db.run("INSERT INTO runner_policy(runner_id,sharing) VALUES(?,?)", [id, runner.sharing ?? 0]);
    db.run(
      "INSERT INTO runner_agent_policy(runner_id,agent,ready,auth_expired) VALUES(?,'codex',?,?)",
      [id, runner.ready ?? 1, runner.authExpired ?? 0],
    );
  }
  return {
    db,
    users,
    check(input: Partial<EligibleRunnersInput> & { leads?: string[] } = {}) {
      const { leads = [], ...given } = input;
      const rest = Object.fromEntries(
        Object.entries(given).filter(([, value]) => value !== undefined),
      );
      return eligibleRunners(db, {
        workspaceId: ws.id,
        teamId: "team",
        ownerUserId: users.me!,
        leadUserIds: leads.map((name) => users[name]!),
        agent: "codex",
        purpose: "work",
        now,
        ...rest,
      });
    },
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const CASES: {
  name: string;
  runner: Runner;
  leads?: string[];
  purpose?: EligibleRunnersInput["purpose"];
  reason: EligibleRunnerReason;
}[] = [
  { name: "the delegator's own runner", runner: { owner: "me" }, reason: "own" },
  {
    name: "a project lead's shared runner",
    runner: { owner: "lead", sharing: 1 },
    leads: ["lead"],
    reason: "lead-shared",
  },
  {
    name: "a project lead's runner that is not shared",
    runner: { owner: "lead", sharing: 0 },
    leads: ["lead"],
    reason: "not-shared",
  },
  {
    name: "a shared runner when the issue has no Linear project",
    runner: { owner: "lead", sharing: 1 },
    reason: "no-project-lead",
  },
  {
    name: "a shared runner of someone who is not a project lead",
    runner: { owner: "colleague", sharing: 1 },
    leads: ["lead"],
    reason: "not-yours",
  },
  {
    name: "another member's unshared runner",
    runner: { owner: "colleague" },
    reason: "not-yours",
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
    name: "a lead's shared runner when the lead is outside the team and not an admin",
    runner: { owner: "outsider", sharing: 1 },
    leads: ["outsider"],
    reason: "owner-not-in-team",
  },
  {
    name: "a lead's shared runner when the lead is an admin outside the team",
    runner: { owner: "outside-admin", sharing: 1 },
    leads: ["outside-admin"],
    reason: "lead-shared",
  },
  {
    name: "a lead's shared runner when the lead is no longer active",
    runner: { owner: "gone", sharing: 1 },
    leads: ["gone"],
    reason: "owner-inactive",
  },
  {
    name: "an own runner with no signed-in agent while preparing",
    runner: { owner: "me", ready: 0, authExpired: 1 },
    purpose: "prepare",
    reason: "own",
  },
  {
    name: "an own runner with no ready agent for a helper",
    runner: { owner: "me", ready: 0 },
    purpose: "helper",
    reason: "own",
  },
];

for (const row of CASES)
  test(`eligibleRunners: ${row.name} is ${row.reason}`, () => {
    const ws = workspace({ runner: row.runner });
    try {
      const result = ws.check({ leads: row.leads, purpose: row.purpose });
      expect(result.map(({ id, eligible, reason }) => ({ id, eligible, reason }))).toEqual([
        {
          id: "runner",
          eligible: row.reason === "own" || row.reason === "lead-shared",
          reason: row.reason,
        },
      ]);
    } finally {
      ws.close();
    }
  });

test("eligibleRunners lists every unrevoked runner in the workspace in id order", () => {
  const ws = workspace({
    b: { owner: "colleague" },
    a: { owner: "me" },
    c: { owner: "lead", sharing: 1 },
    gone: { owner: "me", status: "revoked" },
  });
  try {
    expect(ws.check({ leads: ["lead"] }).map(({ id, reason }) => [id, reason])).toEqual([
      ["a", "own"],
      ["b", "not-yours"],
      ["c", "lead-shared"],
    ]);
  } finally {
    ws.close();
  }
});

test("eligibleRunners reports the work owner's runner as own even when it is shared and they lead", () => {
  const ws = workspace({ mine: { owner: "me", sharing: 1 } });
  try {
    expect(ws.check({ leads: ["me"] })[0]?.reason).toBe("own");
  } finally {
    ws.close();
  }
});

test("eligibleRunners reads only SQLite", () => {
  const ws = workspace({ mine: { owner: "me" } });
  const real = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    throw new Error("eligibleRunners must not reach the network");
  }) as unknown as typeof fetch;
  try {
    const result = ws.check();
    expect(result).toBeArray();
    expect(result).not.toBeInstanceOf(Promise);
    expect(requests).toBe(0);
  } finally {
    globalThis.fetch = real;
    ws.close();
  }
});

test("a runner with an unacknowledged cancel stays online; capacity accounts for its cleanup", () => {
  const space = workspace({ box: { owner: "me" } });
  const now = Date.now();
  try {
    space.db.run(
      "INSERT INTO runner_command(id,runner_id,kind,envelope,expires_at) VALUES(?,?,'cancel','{}',?)",
      ["live-cancel", "box", now + 60_000],
    );
    expect(space.check({ now }).map((runner) => runner.reason)).toEqual(["own"]);
  } finally {
    space.close();
  }
});
