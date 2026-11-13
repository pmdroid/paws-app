import { expect, test } from "bun:test";
import { accountAgentEnv } from "../src/acp";
import {
  AgentAccountError,
  admitAgentAccounts,
  bindAgentAccount,
  bindLinearSessionTask,
  consumeWorkspaceBootstrap,
  createAgentAccount,
  ensureLegacyAgentBinding,
  insertQueuedItem,
  legacyAgentAccountId,
  legacyAgentBindingId,
  listAgentAccounts,
  listAgentBindings,
  putWorkspaceUser,
  recordCommandAccount,
  recordLinearInstallation,
  recordRunnerAccountCapability,
} from "../src/db";
import { runnerAccountHome } from "../src/runner-execution";
import {
  RunnerAccountCapabilitySchema,
  RunnerAccountSchema,
  runnerAccountAgentUnsupported,
  runnerAccountEchoed,
  type RunnerCommand,
} from "../src/runner-protocol";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../src/workspace";
import { eq, inArray } from "drizzle-orm";
import { seed } from "./dialects";
import { tempStore } from "./pglite";

const SECRET = "sk-ant-oat01-PAS1021-planted-secret";
const HOUR = 3_600_000;

async function fixture() {
  const { db, close } = await tempStore();
  let clock = Date.now();
  const owner = await putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const workspace = await consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "org",
    name: "Test",
    userId: owner,
    tokenHash: workspaceTokenHash(await issueWorkspaceBootstrap(db, "org", clock)),
    now: clock,
  });
  await recordLinearInstallation(db, {
    organizationId: "org",
    oauthClientId: "app-client",
    appUserId: "app",
    sessionId: "session",
    teamId: "team",
    observedAtMs: clock,
  });
  const item = await insertQueuedItem(db, { id: "item", now: clock, sessionKey: "session" });
  await bindLinearSessionTask(db, "session", item.delegationId, { actorId: "owner" });
  await seed(db, (q) =>
    q.orm.update(q.t.workItem).set({ ownerUserId: owner }).where(eq(q.t.workItem.id, item.id)),
  );
  for (const id of ["R1", "R2"])
    await seed(
      db,
      (q) =>
        q.orm.insert(q.t.runner).values({
          id,
          workspaceId: workspace.id,
          ownerUserId: owner,
          name: id,
          status: "active",
          createdAt: clock,
          lastSeenAt: clock,
        }),
      (q) =>
        q.orm.insert(q.t.runnerAgentPolicy).values({ runnerId: id, agent: "claude", ready: 1 }),
      (q) =>
        q.orm
          .insert(q.t.runnerHostStatus)
          .values({ runnerId: id, runnerVersion: "0.1.61", reportedAt: clock }),
    );
  const named = async (label: string) =>
    (
      await createAgentAccount(db, {
        workspaceId: workspace.id,
        agent: "claude",
        label,
        now: clock,
      })
    ).id;
  const accounts = {
    a: await named("A"),
    b: await named("B"),
    legacy: legacyAgentAccountId(workspace.id, "claude"),
  };
  const bind = async (accountId: string, runnerId: string) =>
    (
      await bindAgentAccount(db, {
        workspaceId: workspace.id,
        accountId,
        runnerId,
        now: clock,
      })
    ).id;
  const bindings = {
    a1: await bind(accounts.a, "R1"),
    a2: await bind(accounts.a, "R2"),
    b1: await bind(accounts.b, "R1"),
  };
  const report = async (runnerId: string, ids: string[]) =>
    await recordRunnerAccountCapability(
      db,
      runnerId,
      { protocol: 1, bindings: ids.map((bindingId) => ({ bindingId, agent: "claude" })) },
      clock,
    );
  await report("R1", [bindings.a1, bindings.b1]);
  await report("R2", [bindings.a2]);
  return {
    db,
    close,
    workspaceId: workspace.id,
    accounts,
    bindings,
    now: () => clock,
  };
}

async function code(run: () => unknown) {
  try {
    await run();
  } catch (error) {
    if (error instanceof AgentAccountError) return error.code;
    throw error;
  }
  return null;
}

test("wrong-account use: a command, result or heartbeat that mixes identities is refused", async () => {
  const f = await fixture();
  const command = (
    id: string,
    runnerId: string,
    account: { accountId: string; bindingId: string },
  ) =>
    ({
      id,
      runnerId,
      workspaceId: f.workspaceId,
      issuedAt: f.now(),
      expiresAt: f.now() + HOUR,
      type: "probe",
      profile: { agent: "claude", model: null },
      account,
    }) as RunnerCommand;
  expect(
    await code(
      async () =>
        await recordCommandAccount(
          f.db,
          command("x1", "R1", { accountId: f.accounts.a, bindingId: f.bindings.b1 }),
          f.now(),
        ),
    ),
  ).toBe("binding_mismatch");
  expect(
    await code(
      async () =>
        await recordCommandAccount(
          f.db,
          command("x2", "R1", { accountId: f.accounts.a, bindingId: f.bindings.a2 }),
          f.now(),
        ),
    ),
  ).toBe("binding_mismatch");
  expect(
    await f.db.run((q) =>
      q.all(
        q.orm
          .select({ id: q.t.runnerCommandAccount.commandId })
          .from(q.t.runnerCommandAccount)
          .where(inArray(q.t.runnerCommandAccount.commandId, ["x1", "x2"])),
      ),
    ),
  ).toEqual([]);

  const a = { accountId: f.accounts.a, bindingId: f.bindings.a1 };
  const b = { accountId: f.accounts.b, bindingId: f.bindings.b1 };
  expect(runnerAccountEchoed({ account: a }, { account: b })).toBe(false);
  expect(runnerAccountEchoed({ account: a }, {})).toBe(false);
  expect(runnerAccountEchoed({}, { account: a })).toBe(false);

  expect(RunnerAccountSchema.safeParse({ ...a, token: SECRET }).success).toBe(false);
  expect(RunnerAccountSchema.safeParse({ ...a, bindingId: "../R2" }).success).toBe(false);
  expect(
    RunnerAccountSchema.safeParse({
      accountId: f.accounts.legacy,
      bindingId: legacyAgentBindingId("R1", "claude"),
    }).success,
  ).toBe(false);
  expect(
    RunnerAccountCapabilitySchema.safeParse({
      protocol: 1,
      bindings: [{ bindingId: f.bindings.a1, agent: "claude", home: "/x" }],
    }).success,
  ).toBe(false);
  await f.close();
});

test("every advertised adapter isolates a binding's config, sessions and caches in its own home", () => {
  const agentHome = "/var/lib/paws-agent";
  const homes = ["01JBINDINGA000000000000000", "01JBINDINGB000000000000000"].map((bindingId) =>
    runnerAccountHome(agentHome, { accountId: "01JACCOUNTA000000000000000", bindingId }),
  );
  expect(runnerAccountHome(agentHome)).toBe(agentHome);
  const [first, second] = homes.map((home) => accountAgentEnv(home));
  for (const [key, value] of Object.entries(first!)) {
    expect(value.startsWith(`${homes[0]}`)).toBe(true);
    expect(second![key]!.startsWith(`${homes[1]}`)).toBe(true);
  }
  expect(Object.keys(first!).sort()).toEqual(
    [
      "CLAUDE_CONFIG_DIR",
      "CODEX_HOME",
      "HOME",
      "XDG_CACHE_HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
    ].sort(),
  );
  expect(Object.keys(first!)).not.toContain("XAI_API_KEY");
  expect(runnerAccountAgentUnsupported("gemini" as never)).not.toBeNull();
});

test("a runner's default sign-in is a legacy account beside named ones and is admitted by default", async () => {
  const f = await fixture();
  const legacy = await ensureLegacyAgentBinding(f.db, "R1", "claude", f.now());
  await ensureLegacyAgentBinding(f.db, "R1", "claude", f.now());
  await ensureLegacyAgentBinding(f.db, "R2", "codex", f.now());
  expect(legacy).toMatchObject({
    id: legacyAgentBindingId("R1", "claude"),
    accountId: f.accounts.legacy,
    quotaScope: "unknown",
    legacy: true,
  });
  expect((await listAgentAccounts(f.db, f.workspaceId)).map((row) => row.id).sort()).toEqual(
    [
      f.accounts.legacy,
      legacyAgentAccountId(f.workspaceId, "codex"),
      f.accounts.a,
      f.accounts.b,
    ].sort(),
  );
  expect(
    (await listAgentAccounts(f.db, f.workspaceId)).find((row) => row.id === f.accounts.legacy),
  ).toMatchObject({ legacy: true, enabled: true });
  expect(
    (await listAgentBindings(f.db, f.workspaceId)).filter((row) => row.legacy).map((row) => row.id),
  ).toEqual(
    expect.arrayContaining([
      legacyAgentBindingId("R1", "claude"),
      legacyAgentBindingId("R2", "codex"),
    ]),
  );
  expect(await admitAgentAccounts(f.db, f.workspaceId, "claude")).toEqual({
    agent: "claude",
    eligible: [f.accounts.legacy],
    skipped: [],
  });
  await f.close();
});
