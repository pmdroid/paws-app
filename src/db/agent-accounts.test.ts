import { afterEach, expect, test } from "bun:test";
import type { RunnerCommand } from "../runner-protocol";
import { seed as insert } from "../../test/dialects";
import { tempStore } from "../../test/pglite";
import {
  AgentAccountError,
  bindAgentAccount,
  commandAccount,
  createAgentAccount,
  listAgentBindings,
  recordCommandAccount,
  recordRunnerAccountCapability,
  removeAgentAccount,
  removeAgentBinding,
  renameAgentAccount,
  setAgentAccountEnabled,
  type Db,
  type Q,
} from "./index";

const NOW = 1_800_000_000_000;

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
});

function seed(db: Db, workspace: string, runners: string[]) {
  const user = `user-${workspace}`;
  return insert(
    db,
    (q) =>
      q.orm.insert(q.t.workspace).values({
        id: workspace,
        linearOrganizationId: `org-${workspace}`,
        name: workspace,
        createdAt: NOW,
      }),
    (q) =>
      q.orm
        .insert(q.t.workspaceUser)
        .values({
          id: user,
          linearUserId: `linear-${workspace}`,
          name: "Owner",
          email: `${workspace}@example.test`,
        })
        .onConflictDoNothing(),
    (q) =>
      q.orm.insert(q.t.workspaceMember).values({
        workspaceId: workspace,
        userId: user,
        role: "admin",
        source: "manual",
        active: 1,
        checkedAt: NOW,
      }),
    ...runners.map(
      (runner) => (q: Q) =>
        q.orm.insert(q.t.runner).values({
          id: runner,
          workspaceId: workspace,
          ownerUserId: user,
          name: runner,
          status: "active",
          createdAt: NOW,
        }),
    ),
  );
}

async function fresh() {
  const { db, close } = await tempStore();
  closes.push(close);
  await seed(db, "W1", ["R1", "R2"]);
  await seed(db, "W2", ["R3"]);
  return db;
}

const refused = (message: string) => ({ cause: { message: expect.stringContaining(message) } });

const hostStatus = (db: Db, runnerVersion: string) =>
  insert(db, (q) =>
    q.orm
      .insert(q.t.runnerHostStatus)
      .values({ runnerId: "R1", runnerVersion, reportedAt: NOW })
      .onConflictDoUpdate({ target: q.t.runnerHostStatus.runnerId, set: { runnerVersion } }),
  );

async function code(run: () => unknown) {
  try {
    await run();
  } catch (error) {
    if (error instanceof AgentAccountError) return error.code;
    throw error;
  }
  return null;
}

const base = { issuedAt: NOW, expiresAt: NOW + 60_000 };
const loginCheck = (
  id: string,
  runnerId: string,
  workspaceId: string,
  account?: { accountId: string; bindingId: string },
): RunnerCommand => ({
  ...base,
  id,
  runnerId,
  workspaceId,
  type: "login_check",
  agent: "claude",
  ...(account ? { account } : {}),
});
const probe = (
  id: string,
  runnerId: string,
  workspaceId: string,
  account?: { accountId: string; bindingId: string },
): RunnerCommand => ({
  ...base,
  id,
  runnerId,
  workspaceId,
  type: "probe",
  profile: { agent: "claude", model: null },
  ...(account ? { account } : {}),
});

test("one account has several bindings and rejects duplicates and foreign workspaces", async () => {
  const db = await fresh();
  const a = await createAgentAccount(db, {
    workspaceId: "W1",
    agent: "claude",
    label: "Team",
    now: NOW,
  });
  expect(
    await code(
      async () =>
        await createAgentAccount(db, {
          workspaceId: "W1",
          agent: "claude",
          label: " team ",
          now: NOW,
        }),
    ),
  ).toBe("duplicate");
  expect(
    (
      await createAgentAccount(db, {
        workspaceId: "W1",
        agent: "codex",
        label: "Team",
        now: NOW,
      })
    ).agent,
  ).toBe("codex");
  expect(
    await code(
      async () =>
        await createAgentAccount(db, {
          workspaceId: "W1",
          agent: "claude",
          label: "",
          now: NOW,
        }),
    ),
  ).toBe("invalid");
  expect(
    await code(
      async () =>
        await createAgentAccount(db, {
          workspaceId: "nope",
          agent: "claude",
          label: "X",
          now: NOW,
        }),
    ),
  ).toBe("not_found");

  const first = await bindAgentAccount(db, {
    workspaceId: "W1",
    accountId: a.id,
    runnerId: "R1",
    now: NOW,
  });
  const second = await bindAgentAccount(db, {
    workspaceId: "W1",
    accountId: a.id,
    runnerId: "R2",
    now: NOW + 1,
  });
  expect([first.quotaScope, second.quotaScope]).toEqual(["account", "account"]);
  expect((await listAgentBindings(db, "W1", a.id)).map((binding) => binding.runnerId)).toEqual([
    "R1",
    "R2",
  ]);
  expect(
    await code(
      async () =>
        await bindAgentAccount(db, {
          workspaceId: "W1",
          accountId: a.id,
          runnerId: "R1",
          now: NOW,
        }),
    ),
  ).toBe("duplicate");
  expect(
    await code(
      async () =>
        await bindAgentAccount(db, {
          workspaceId: "W1",
          accountId: a.id,
          runnerId: "R3",
          now: NOW,
        }),
    ),
  ).toBe("foreign_workspace");
  expect(
    await code(
      async () =>
        await bindAgentAccount(db, {
          workspaceId: "W2",
          accountId: a.id,
          runnerId: "R3",
          now: NOW,
        }),
    ),
  ).toBe("foreign_workspace");
  expect(await code(async () => await listAgentBindings(db, "W2", a.id))).toBe("foreign_workspace");
  expect(
    await code(
      async () =>
        await renameAgentAccount(db, {
          workspaceId: "W2",
          accountId: a.id,
          label: "X",
          now: NOW,
        }),
    ),
  ).toBe("foreign_workspace");

  await removeAgentBinding(db, { workspaceId: "W1", bindingId: first.id, now: NOW + 1 });
  expect(
    (
      await bindAgentAccount(db, {
        workspaceId: "W1",
        accountId: a.id,
        runnerId: "R1",
        now: NOW + 2,
      })
    ).removedAt,
  ).toBeNull();
});

test("the schema keeps each binding to one workspace, account and agent", async () => {
  const db = await fresh();
  const a = await createAgentAccount(db, {
    workspaceId: "W1",
    agent: "claude",
    label: "A",
    now: NOW,
  });
  const bind = (
    workspace: string,
    agent: string,
    runner: string,
    legacy = 0,
    quotaScope = "account",
  ) =>
    insert(db, (q) =>
      q.orm.insert(q.t.agentAccountBinding).values({
        id: `B-${workspace}-${agent}-${runner}`,
        workspaceId: workspace,
        accountId: a.id,
        agent,
        runnerId: runner,
        legacy,
        quotaScope,
        createdAt: NOW,
      }),
    );
  await expect(bind("W1", "codex", "R1")).rejects.toMatchObject(refused("foreign key"));
  await expect(bind("W2", "claude", "R3")).rejects.toMatchObject(refused("foreign key"));
  await expect(bind("W1", "claude", "R1", 1, "account")).rejects.toMatchObject(
    refused("check constraint"),
  );
  await expect(bind("W1", "claude", "missing")).rejects.toMatchObject(refused("foreign key"));
  await bind("W1", "claude", "R1");
  expect((await listAgentBindings(db, "W1", a.id)).map((row) => row.id)).toEqual([
    "B-W1-claude-R1",
  ]);
});

test("commands without an account record the runner's legacy identity", async () => {
  const db = await fresh();
  expect(await recordCommandAccount(db, loginCheck("C1", "R1", "W1"), NOW)).toEqual({
    commandId: "C1",
    workspaceId: "W1",
    runnerId: "R1",
    agent: "claude",
    accountId: "legacy_claude_W1",
    bindingId: "legacy_claude_R1",
    named: false,
    recordedAt: NOW,
  });
  await recordCommandAccount(db, probe("C2", "R2", "W1"), NOW);
  expect(await commandAccount(db, "C2")).toMatchObject({
    bindingId: "legacy_claude_R2",
    named: false,
  });
  expect(await commandAccount(db, "unknown")).toBeNull();
  expect(
    await recordCommandAccount(
      db,
      {
        ...base,
        id: "C3",
        runnerId: "R1",
        workspaceId: "W1",
        type: "cancel",
        runId: "run",
        generation: 1,
      },
      NOW,
    ),
  ).toBeNull();
  expect(await code(async () => await recordCommandAccount(db, probe("C4", "R3", "W1"), NOW))).toBe(
    "foreign_workspace",
  );
  await expect(recordCommandAccount(db, probe("C1", "R1", "W1"), NOW)).rejects.toMatchObject(
    refused("duplicate key"),
  );
});

test("a named account is refused unless the runner reports the binding", async () => {
  const db = await fresh();
  const a = await createAgentAccount(db, {
    workspaceId: "W1",
    agent: "claude",
    label: "A",
    now: NOW,
  });
  const bound = await bindAgentAccount(db, {
    workspaceId: "W1",
    accountId: a.id,
    runnerId: "R1",
    now: NOW,
  });
  const named = { accountId: a.id, bindingId: bound.id };
  const attempt = (id: string, account = named, runner = "R1", workspace = "W1") =>
    code(async () => await recordCommandAccount(db, probe(id, runner, workspace, account), NOW));
  expect(await attempt("N1")).toBe("runner_unsupported");
  await hostStatus(db, "0.1.59");
  expect(await attempt("N2")).toBe("runner_unsupported");
  await hostStatus(db, "0.1.61");
  expect(await attempt("N3")).toBe("runner_unsupported");
  await recordRunnerAccountCapability(db, "R1", { protocol: 1, bindings: [] }, NOW);
  expect(await attempt("N4")).toBe("runner_unsupported");
  await recordRunnerAccountCapability(
    db,
    "R1",
    { protocol: 1, bindings: [{ bindingId: bound.id, agent: "codex" }] },
    NOW,
  );
  expect(await attempt("N5")).toBe("runner_unsupported");
  await recordRunnerAccountCapability(
    db,
    "R1",
    { protocol: 1, bindings: [{ bindingId: bound.id, agent: "claude" }] },
    NOW,
  );
  expect(await attempt("N6")).toBeNull();
  expect(await commandAccount(db, "N6")).toMatchObject({
    accountId: a.id,
    bindingId: bound.id,
    named: true,
  });
  expect(await attempt("N7", { ...named, accountId: "OTHER" })).toBe("binding_mismatch");
  expect(await attempt("N8", named, "R2")).toBe("binding_mismatch");
  expect(await attempt("N9", named, "R3", "W2")).toBe("foreign_workspace");
  expect(await attempt("N10", { ...named, bindingId: "MISSING" })).toBe("not_found");

  await recordRunnerAccountCapability(db, "R1", undefined, NOW);
  expect(await attempt("N11")).toBe("runner_unsupported");
});

test("identity stays attached after an account is disabled or removed", async () => {
  const db = await fresh();
  const a = await createAgentAccount(db, {
    workspaceId: "W1",
    agent: "claude",
    label: "A",
    now: NOW,
  });
  const bound = await bindAgentAccount(db, {
    workspaceId: "W1",
    accountId: a.id,
    runnerId: "R1",
    now: NOW,
  });
  await hostStatus(db, "0.1.61");
  await recordRunnerAccountCapability(
    db,
    "R1",
    { protocol: 1, bindings: [{ bindingId: bound.id, agent: "claude" }] },
    NOW,
  );
  const named = { accountId: a.id, bindingId: bound.id };
  await recordCommandAccount(db, probe("BEFORE", "R1", "W1", named), NOW);

  await setAgentAccountEnabled(db, {
    workspaceId: "W1",
    accountId: a.id,
    enabled: false,
    now: NOW,
  });
  expect(
    await code(async () => await recordCommandAccount(db, probe("OFF", "R1", "W1", named), NOW)),
  ).toBe("disabled");
  expect((await recordCommandAccount(db, loginCheck("CHECK", "R1", "W1", named), NOW))?.named).toBe(
    true,
  );

  await removeAgentAccount(db, { workspaceId: "W1", accountId: a.id, now: NOW + 1 });
  expect(
    await code(async () => await recordCommandAccount(db, probe("GONE", "R1", "W1", named), NOW)),
  ).toBe("removed");
  expect((await listAgentBindings(db, "W1", a.id))[0]?.removedAt).toBe(NOW + 1);
  expect(await commandAccount(db, "BEFORE")).toMatchObject({
    accountId: a.id,
    bindingId: bound.id,
  });
  expect(
    await code(
      async () =>
        await setAgentAccountEnabled(db, {
          workspaceId: "W1",
          accountId: a.id,
          enabled: true,
          now: NOW,
        }),
    ),
  ).toBe("removed");
  expect(
    (
      await createAgentAccount(db, {
        workspaceId: "W1",
        agent: "claude",
        label: "A",
        now: NOW + 2,
      })
    ).label,
  ).toBe("A");

  await recordCommandAccount(db, loginCheck("LEGACY_CHECK", "R2", "W1"), NOW);
  await setAgentAccountEnabled(db, {
    workspaceId: "W1",
    accountId: "legacy_claude_W1",
    enabled: false,
    now: NOW,
  });
  expect(
    await code(async () => await recordCommandAccount(db, probe("LEGACY", "R2", "W1"), NOW)),
  ).toBe("disabled");
  expect(
    await code(
      async () =>
        await removeAgentAccount(db, {
          workspaceId: "W1",
          accountId: "legacy_claude_W1",
          now: NOW,
        }),
    ),
  ).toBe("legacy");
  expect(
    await code(
      async () =>
        await bindAgentAccount(db, {
          workspaceId: "W1",
          accountId: "legacy_claude_W1",
          runnerId: "R1",
          now: NOW,
        }),
    ),
  ).toBe("legacy");
});
