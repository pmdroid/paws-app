import { afterEach, expect, test } from "bun:test";
import {
  AgentAccountError,
  accountSlotsInUseSteps,
  agentAccountConcurrencySteps,
  bindAgentAccountSteps,
  commandAccountSteps,
  createAgentAccountSteps,
  getAgentAccountSteps,
  getAgentBindingSteps,
  listAgentAccountsSteps,
  listAgentBindingsSteps,
  liveAccountBindingSteps,
  recordCommandAccountSteps,
  recordRunnerAccountCapabilitySteps,
  removeAgentAccountSteps,
  removeAgentBindingSteps,
  renameAgentAccountSteps,
  runnerAccountUnsupportedSteps,
  setAgentAccountConcurrencySteps,
  setAgentAccountEnabledSteps,
  writeAgentAuthSteps,
  type Db,
  type Q,
} from "../src/db";
import type { RunnerCommand } from "../src/runner-protocol";
import {
  describePglite,
  json,
  seed,
  withoutForeignKeys,
  type PgliteTestDb,
} from "./pglite-fixtures";
import { seedRunner } from "./runner-rows";

const NOW = 1_800_000_000_000;
const open: PgliteTestDb[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
});

async function workspace(db: Db) {
  await withoutForeignKeys(db);
  await seed(db, (q) =>
    q.orm
      .insert(q.t.workspace)
      .values({ id: "acme", linearOrganizationId: "org", name: "acme", createdAt: NOW }),
  );
  await seedRunner(db, "R1");
  await seedRunner(db, "R2");
  await seedRunner(db, "R3", { revokedAt: NOW });
}

async function legacyBinding(db: Db, runnerId: string, agent: "claude" | "codex", at: number) {
  const accountId = `legacy_${agent}_acme`;
  const id = `legacy_${agent}_${runnerId}`;
  await seed(
    db,
    (q) =>
      q.orm
        .insert(q.t.agentAccount)
        .values({
          id: accountId,
          workspaceId: "acme",
          agent,
          label: `${agent} default sign-in`,
          legacy: 1,
          enabled: 1,
          createdAt: at,
          updatedAt: at,
        })
        .onConflictDoNothing(),
    (q) =>
      q.orm.insert(q.t.agentAccountBinding).values({
        id,
        workspaceId: "acme",
        accountId,
        agent,
        runnerId,
        legacy: 1,
        quotaScope: "unknown",
        createdAt: at,
      }),
  );
  return db.run((q) => getAgentBindingSteps(q, "acme", id));
}

async function code(run: Promise<unknown>) {
  try {
    await run;
  } catch (error) {
    if (error instanceof AgentAccountError) return error.code;
    throw error;
  }
  return null;
}

const probe = (id: string, account?: { accountId: string; bindingId: string }): RunnerCommand => ({
  id,
  runnerId: "R1",
  workspaceId: "acme",
  issuedAt: NOW,
  expiresAt: NOW + 60_000,
  type: "probe",
  profile: { agent: "claude", model: null },
  ...(account ? { account } : {}),
});

describePglite((connect) => {
  test("binding requires the account owner and their runner", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await workspace(db);
    await seedRunner(db, "OTHER", { ownerUserId: "other" });
    const a = await db.transaction((q) =>
      createAgentAccountSteps(q, {
        workspaceId: "acme",
        ownerUserId: "owner",
        agent: "claude",
        label: "Mine",
        now: NOW,
      }),
    );
    expect(a.ownerUserId).toBe("owner");
    const bind = (userId: string, runnerId: string) =>
      db.transaction((q) =>
        bindAgentAccountSteps(q, {
          workspaceId: "acme",
          userId,
          accountId: a.id,
          runnerId,
          now: NOW,
        }),
      );
    expect(await code(bind("other", "R1"))).toBe("not-your-account");
    expect(await code(bind("owner", "OTHER"))).toBe("not-your-runner");
    expect((await bind("owner", "R1")).runnerId).toBe("R1");
  });

  test("accounts are created, renamed, disabled, limited, listed, admitted and removed", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await workspace(db);
    const create = (label: string, now = NOW) =>
      db.transaction((q) =>
        createAgentAccountSteps(q, {
          ownerUserId: "owner",
          workspaceId: "acme",
          agent: "claude",
          label,
          now,
        }),
      );

    const a = await create(" Work ");
    expect(a).toEqual({
      id: a.id,
      ownerUserId: "owner",
      workspaceId: "acme",
      agent: "claude",
      label: "Work",
      legacy: false,
      enabled: true,
      createdAt: NOW,
      updatedAt: NOW,
      removedAt: null,
    });
    expect(await code(create("WORK"))).toBe("duplicate");
    expect(
      await code(
        db.transaction((q) =>
          createAgentAccountSteps(q, {
            ownerUserId: "owner",
            workspaceId: "nope",
            agent: "claude",
            label: "X",
            now: NOW,
          }),
        ),
      ),
    ).toBe("not_found");
    const b = await create("Home", NOW + 1);
    expect(
      await code(
        db.transaction((q) =>
          renameAgentAccountSteps(q, {
            workspaceId: "acme",
            accountId: b.id,
            label: "work",
            now: NOW,
          }),
        ),
      ),
    ).toBe("duplicate");
    expect(
      await db.transaction((q) =>
        renameAgentAccountSteps(q, {
          workspaceId: "acme",
          accountId: a.id,
          label: "WORK",
          now: NOW + 2,
        }),
      ),
    ).toMatchObject({ label: "WORK", updatedAt: NOW + 2 });
    expect(
      await db.transaction((q) =>
        setAgentAccountEnabledSteps(q, {
          workspaceId: "acme",
          accountId: b.id,
          enabled: false,
          now: NOW + 3,
        }),
      ),
    ).toMatchObject({ enabled: false, updatedAt: NOW + 3 });
    expect(
      await db.transaction((q) =>
        setAgentAccountConcurrencySteps(q, {
          workspaceId: "acme",
          accountId: a.id,
          concurrency: 3,
          now: NOW,
        }),
      ),
    ).toBe(3);
    expect(await db.run((q) => agentAccountConcurrencySteps(q, a.id))).toBe(3);
    expect(await db.run((q) => agentAccountConcurrencySteps(q, b.id))).toBeNull();
    expect(await code(db.run((q) => getAgentAccountSteps(q, "other", a.id)))).toBe(
      "foreign_workspace",
    );

    await legacyBinding(db, "R1", "claude", NOW + 5);
    const legacy = "legacy_claude_acme";
    expect((await db.run((q) => listAgentAccountsSteps(q, "acme"))).map((row) => row.id)).toEqual([
      legacy,
      a.id,
      b.id,
    ]);
    expect(
      await code(
        db.transaction((q) =>
          removeAgentAccountSteps(q, { workspaceId: "acme", accountId: legacy, now: NOW }),
        ),
      ),
    ).toBe("legacy");
    expect(
      await db.transaction((q) =>
        removeAgentAccountSteps(q, { workspaceId: "acme", accountId: b.id, now: NOW + 6 }),
      ),
    ).toMatchObject({ enabled: false, removedAt: NOW + 6 });
    expect(
      await code(
        db.transaction((q) =>
          renameAgentAccountSteps(q, {
            workspaceId: "acme",
            accountId: b.id,
            label: "Z",
            now: NOW,
          }),
        ),
      ),
    ).toBe("removed");
  });

  test("bindings are made, listed, found live and removed with their account", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await workspace(db);
    const a = await db.transaction((q) =>
      createAgentAccountSteps(q, {
        ownerUserId: "owner",
        workspaceId: "acme",
        agent: "codex",
        label: "A",
        now: NOW,
      }),
    );
    const bind = (runnerId: string, now = NOW) =>
      db.transaction((q) =>
        bindAgentAccountSteps(q, {
          userId: "owner",
          workspaceId: "acme",
          accountId: a.id,
          runnerId,
          now,
        }),
      );
    const r1 = await bind("R1");
    expect(r1).toEqual({
      id: r1.id,
      workspaceId: "acme",
      accountId: a.id,
      agent: "codex",
      runnerId: "R1",
      legacy: false,
      quotaScope: "account",
      createdAt: NOW,
      removedAt: null,
    });
    expect(await code(bind("R1"))).toBe("duplicate");
    expect(await code(bind("R3"))).toBe("removed");
    expect(await code(bind("missing"))).toBe("not_found");
    const r2 = await bind("R2", NOW + 1);
    const legacy = await legacyBinding(db, "R1", "codex", NOW);
    expect(legacy).toMatchObject({ id: "legacy_codex_R1", legacy: true, quotaScope: "unknown" });

    expect((await db.run((q) => listAgentBindingsSteps(q, "acme", a.id))).map((b) => b.id)).toEqual(
      [r1.id, r2.id],
    );
    expect(await db.run((q) => listAgentBindingsSteps(q, "acme"))).toHaveLength(3);
    expect(await code(db.run((q) => listAgentBindingsSteps(q, "acme", "missing")))).toBe(
      "not_found",
    );
    expect(await db.run((q) => getAgentBindingSteps(q, "acme", r1.id))).toEqual(r1);
    expect(await db.run((q) => liveAccountBindingSteps(q, "R1", a.id))).toEqual(r1);

    expect(
      await db.transaction((q) =>
        removeAgentBindingSteps(q, { workspaceId: "acme", bindingId: r1.id, now: NOW + 2 }),
      ),
    ).toMatchObject({ removedAt: NOW + 2 });
    expect(
      await db.transaction((q) =>
        removeAgentBindingSteps(q, { workspaceId: "acme", bindingId: r1.id, now: NOW + 3 }),
      ),
    ).toMatchObject({ removedAt: NOW + 2 });
    expect(await db.run((q) => liveAccountBindingSteps(q, "R1", a.id))).toBeNull();
    expect(
      await code(
        db.transaction((q) =>
          removeAgentBindingSteps(q, { workspaceId: "acme", bindingId: legacy.id, now: NOW }),
        ),
      ),
    ).toBe("legacy");
    await db.transaction((q) =>
      removeAgentAccountSteps(q, { workspaceId: "acme", accountId: a.id, now: NOW + 4 }),
    );
    expect(await db.run((q) => getAgentBindingSteps(q, "acme", r2.id))).toMatchObject({
      removedAt: NOW + 4,
    });
  });

  test("a command without an account records none, and a named one records once the runner reports the binding", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await workspace(db);
    const record = (command: RunnerCommand) =>
      db.transaction((q) => recordCommandAccountSteps(q, command, NOW));
    expect(await record(probe("C1"))).toBeNull();
    expect(await db.run((q) => commandAccountSteps(q, "C1"))).toBeNull();

    const a = await db.transaction((q) =>
      createAgentAccountSteps(q, {
        ownerUserId: "owner",
        workspaceId: "acme",
        agent: "claude",
        label: "A",
        now: NOW,
      }),
    );
    const bound = await db.transaction((q) =>
      bindAgentAccountSteps(q, {
        userId: "owner",
        workspaceId: "acme",
        accountId: a.id,
        runnerId: "R1",
        now: NOW,
      }),
    );
    const named = { accountId: a.id, bindingId: bound.id };
    const unsupported = () =>
      db.run((q) => runnerAccountUnsupportedSteps(q, "R1", bound.id, "claude"));
    expect(await unsupported()).toBe("The runner has not reported agent account support");
    const report = (bindings: { bindingId: string; agent: "claude" | "codex" }[] | undefined) =>
      db.run((q) =>
        recordRunnerAccountCapabilitySteps(q, "R1", bindings && { protocol: 1, bindings }, NOW),
      );
    await report([{ bindingId: bound.id, agent: "codex" }]);
    expect(await unsupported()).toBe("The runner has not reported this account binding");
    await report([{ bindingId: bound.id, agent: "claude" }]);
    expect(await unsupported()).toBeNull();
    expect(await code(record(probe("N1", { ...named, accountId: "other" })))).toBe(
      "binding_mismatch",
    );
    await record(probe("N2", named));
    expect(await db.run((q) => commandAccountSteps(q, "N2"))).toMatchObject({
      accountId: a.id,
      bindingId: bound.id,
      named: true,
    });
    expect(await db.run((q) => commandAccountSteps(q, "unknown"))).toBeNull();
    await report(undefined);
    expect(await unsupported()).toBe("The runner has not reported agent account support");
  });

  test("a control-plane account needs no reported binding on a runner that takes access credentials", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await workspace(db);
    const account = (label: string) =>
      db.transaction((q) =>
        createAgentAccountSteps(q, {
          ownerUserId: "owner",
          workspaceId: "acme",
          agent: "codex",
          label,
          now: NOW,
        }),
      );
    const bind = (accountId: string) =>
      db.transaction((q) =>
        bindAgentAccountSteps(q, {
          userId: "owner",
          workspaceId: "acme",
          accountId,
          runnerId: "R1",
          now: NOW,
        }),
      );
    const central = await account("Central");
    const local = await account("Local");
    await db.transaction((q) =>
      writeAgentAuthSteps(q, central.id, JSON.stringify({ state: "signed-in" })),
    );
    const centralBinding = await bind(central.id);
    const localBinding = await bind(local.id);
    await seed(db, (q) =>
      q.orm
        .insert(q.t.runnerHostStatus)
        .values({ runnerId: "R1", runnerVersion: "0.1.84", reportedAt: NOW }),
    );
    await db.run((q) =>
      recordRunnerAccountCapabilitySteps(q, "R1", { protocol: 1, bindings: [] }, NOW),
    );
    const unsupported = (bindingId: string) =>
      db.run((q) => runnerAccountUnsupportedSteps(q, "R1", bindingId, "codex"));
    expect(await unsupported(centralBinding.id)).toBeNull();
    const pasted = await account("Pasted");
    await seed(db, (q) =>
      q.orm.insert(q.t.agentAccountCredential).values({
        accountId: pasted.id,
        agent: "codex",
        ciphertext: "sealed",
        version: 1,
        updatedAt: NOW,
        runnerId: null,
      }),
    );
    expect(await unsupported((await bind(pasted.id)).id)).toBeNull();
    expect(await unsupported(localBinding.id)).toBe(
      "The runner has not reported this account binding",
    );
  });

  test("an account's slots count open commands and unreleased retro dispatches", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await workspace(db);
    const commandAccount = (commandId: string) => (q: Q) =>
      q.orm.insert(q.t.runnerCommandAccount).values({
        commandId,
        workspaceId: "acme",
        runnerId: "R1",
        agent: "claude",
        accountId: "A",
        bindingId: "binding",
        named: 1,
        recordedAt: NOW,
      });
    await seed(
      db,
      (q) =>
        q.orm.insert(q.t.agentAccount).values({
          id: "A",
          workspaceId: "acme",
          agent: "claude",
          label: "A",
          createdAt: NOW,
          updatedAt: NOW,
        }),
      (q) =>
        q.orm.insert(q.t.agentAccountBinding).values({
          id: "binding",
          workspaceId: "acme",
          accountId: "A",
          agent: "claude",
          runnerId: "R1",
          quotaScope: "account",
          createdAt: NOW,
        }),
      commandAccount("open"),
      commandAccount("ended"),
      commandAccount("retro"),
      (q) =>
        q.orm.insert(q.t.runnerCommand).values(
          ["open", "ended"].map((id) => ({
            id,
            runnerId: "R1",
            kind: "probe",
            envelope: json(db, {}),
            expiresAt: NOW + 1000,
          })),
        ),
      (q) =>
        q.orm.insert(q.t.runnerExecutionUsage).values(
          ["open", "ended"].map((commandId) => ({
            commandId,
            runnerId: "R1",
            ownerUserId: "owner",
            role: "implementer",
            purpose: "work",
            startedAt: NOW,
            endedAt: commandId === "ended" ? NOW : null,
          })),
        ),
      (q) =>
        q.orm.insert(q.t.retroDispatch).values({
          commandId: "retro",
          retroId: "retro",
          attempt: 1,
          workspaceId: "acme",
          runnerId: "R1",
          runnerFence: 1,
          command: json(db, {}),
          envelope: json(db, {}),
          createdAt: NOW,
          issuedAt: NOW,
          expiresAt: NOW + 1000,
        }),
    );
    const slots = (at: number, except: string | null = null) =>
      db.run((q) => accountSlotsInUseSteps(q, "A", at, except));
    expect(await slots(NOW)).toBe(2);
    expect(await slots(NOW, "open")).toBe(1);
    expect(await slots(NOW, "retro")).toBe(1);
    expect(await slots(NOW + 1000)).toBe(1);
  });
});
