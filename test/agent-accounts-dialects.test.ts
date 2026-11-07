import { afterEach, expect, test } from "bun:test";
import {
  AgentAccountError,
  accountSlotsInUseSteps,
  admitAgentAccountsSteps,
  agentAccountConcurrencySteps,
  bindAgentAccountSteps,
  commandAccountSteps,
  createAgentAccountSteps,
  ensureLegacyAgentBindingSteps,
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
  type Db,
  type Q,
} from "../src/db";
import type { RunnerCommand } from "../src/runner-protocol";
import { forEachDialect, json, seed, withoutForeignKeys, type DialectDb } from "./dialects";
import { seedRunner } from "./runner-rows";

const NOW = 1_800_000_000_000;
const open: DialectDb[] = [];
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

forEachDialect((connect) => {
  test("accounts are created, renamed, disabled, limited, listed, admitted and removed", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await workspace(db);
    const create = (label: string, now = NOW) =>
      db.transaction((q) =>
        createAgentAccountSteps(q, { workspaceId: "acme", agent: "claude", label, now }),
      );

    const a = await create(" Work ");
    expect(a).toEqual({
      id: a.id,
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

    await db.transaction((q) => ensureLegacyAgentBindingSteps(q, "R1", "claude", NOW + 5));
    const legacy = "legacy_claude_acme";
    expect((await db.run((q) => listAgentAccountsSteps(q, "acme"))).map((row) => row.id)).toEqual([
      legacy,
      a.id,
      b.id,
    ]);
    expect(await db.run((q) => admitAgentAccountsSteps(q, "acme", "claude"))).toEqual({
      agent: "claude",
      eligible: [legacy],
      skipped: [],
    });
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
      createAgentAccountSteps(q, { workspaceId: "acme", agent: "codex", label: "A", now: NOW }),
    );
    const bind = (runnerId: string, now = NOW) =>
      db.transaction((q) =>
        bindAgentAccountSteps(q, { workspaceId: "acme", accountId: a.id, runnerId, now }),
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
    const legacy = await db.transaction((q) =>
      ensureLegacyAgentBindingSteps(q, "R1", "codex", NOW),
    );
    expect(legacy).toMatchObject({ id: "legacy_codex_R1", legacy: true, quotaScope: "unknown" });
    expect(
      await db.transaction((q) => ensureLegacyAgentBindingSteps(q, "R1", "codex", NOW + 9)),
    ).toEqual(legacy);

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

  test("a command records its account once the runner reports the binding", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await workspace(db);
    const record = (command: RunnerCommand) =>
      db.transaction((q) => recordCommandAccountSteps(q, command, NOW));
    expect(await record(probe("C1"))).toEqual({
      commandId: "C1",
      workspaceId: "acme",
      runnerId: "R1",
      agent: "claude",
      accountId: "legacy_claude_acme",
      bindingId: "legacy_claude_R1",
      named: false,
      recordedAt: NOW,
    });

    const a = await db.transaction((q) =>
      createAgentAccountSteps(q, { workspaceId: "acme", agent: "claude", label: "A", now: NOW }),
    );
    const bound = await db.transaction((q) =>
      bindAgentAccountSteps(q, { workspaceId: "acme", accountId: a.id, runnerId: "R1", now: NOW }),
    );
    const named = { accountId: a.id, bindingId: bound.id };
    const unsupported = () =>
      db.run((q) => runnerAccountUnsupportedSteps(q, "R1", bound.id, "claude"));
    expect(await unsupported()).toMatch(/need runner/);
    await seed(db, (q) =>
      q.orm
        .insert(q.t.runnerHostStatus)
        .values({ runnerId: "R1", runnerVersion: "0.1.61", reportedAt: NOW }),
    );
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
