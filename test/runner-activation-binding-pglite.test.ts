import { afterEach, expect, test } from "bun:test";
import {
  createAgentAccountSteps,
  listAgentBindingsSteps,
  setAgentAccountEnabledSteps,
  updateRunnerStatusSteps,
  type Db,
} from "../src/db";
import { describePglite, seed, withoutForeignKeys, type PgliteTestDb } from "./pglite-fixtures";
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
}

async function account(
  db: Db,
  agent: "claude" | "codex" | "grok",
  options: { signedIn: boolean; owner?: string },
) {
  const created = await db.transaction((q) =>
    createAgentAccountSteps(q, {
      workspaceId: "acme",
      ownerUserId: options.owner ?? "owner",
      agent,
      label: agent,
      now: NOW,
    }),
  );
  if (options.signedIn)
    await seed(db, (q) =>
      q.orm.insert(q.t.agentAccountCredential).values({
        accountId: created.id,
        agent,
        ciphertext: "sealed",
        version: 1,
        updatedAt: NOW,
      }),
    );
  return created.id;
}

const activate = (db: Db, runnerId: string, at = NOW + 1) =>
  db.transaction((q) =>
    updateRunnerStatusSteps(q, {
      runnerId,
      workspaceId: "acme",
      userId: "owner",
      status: "active",
      now: at,
    }),
  );

const boundRunners = async (db: Db, accountId: string) =>
  (await db.run((q) => listAgentBindingsSteps(q, "acme", accountId)))
    .map((binding) => binding.runnerId)
    .sort();

describePglite((connect) => {
  test("an account signed in before its runner was active is bound when the runner is resumed", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await workspace(db);
    await seedRunner(db, "R1", { status: "paused" });
    const claude = await account(db, "claude", { signedIn: true });
    const codex = await account(db, "codex", { signedIn: true });
    expect(await boundRunners(db, claude)).toEqual([]);

    await activate(db, "R1");

    expect(await boundRunners(db, claude)).toEqual(["R1"]);
    expect(await boundRunners(db, codex)).toEqual(["R1"]);
  });

  test("resuming again keeps one binding per runner and account", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await workspace(db);
    await seedRunner(db, "R1", { status: "paused" });
    const claude = await account(db, "claude", { signedIn: true });

    await activate(db, "R1");
    await activate(db, "R1", NOW + 2);

    expect(await boundRunners(db, claude)).toEqual(["R1"]);
  });

  test("signed-out, disabled and other members' accounts are not bound", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await workspace(db);
    await seedRunner(db, "R1", { status: "paused" });
    const signedOut = await account(db, "claude", { signedIn: false });
    const disabled = await account(db, "codex", { signedIn: true });
    await db.transaction((q) =>
      setAgentAccountEnabledSteps(q, {
        workspaceId: "acme",
        accountId: disabled,
        enabled: false,
        now: NOW,
      }),
    );
    const someoneElse = await account(db, "grok", { signedIn: true, owner: "other" });

    await activate(db, "R1");

    expect(await boundRunners(db, signedOut)).toEqual([]);
    expect(await boundRunners(db, disabled)).toEqual([]);
    expect(await boundRunners(db, someoneElse)).toEqual([]);
  });
});
