import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  ACCOUNT_RESET_SLACK_MS,
  accountAttemptsInFlightSteps,
  bindingAccountHealthSteps,
  legacyBindingAccountHealthSteps,
  recordAccountObservationSteps,
  resumeAccountHealthNowSteps,
  type AccountObservation,
  type Db,
} from "../src/db";
import { forEachDialect, json, seed, withoutForeignKeys, type DialectDb } from "./dialects";
import { seedRunner } from "./runner-rows";

const NOW = 1_800_000_000_000;
const open: DialectDb[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
});

async function accounts(db: Db) {
  await withoutForeignKeys(db);
  await seedRunner(db, "R1");
  await seedRunner(db, "R2");
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
      q.orm.insert(q.t.agentAccountBinding).values(
        ["R1", "R2"].map((runnerId) => ({
          id: `A-${runnerId}`,
          workspaceId: "acme",
          accountId: "A",
          agent: "claude",
          runnerId,
          quotaScope: "account",
          createdAt: NOW,
        })),
      ),
  );
}

const observe = (db: Db, observation: AccountObservation) =>
  db.transaction((q) => recordAccountObservationSteps(q, observation));

forEachDialect((connect) => {
  test("an observation applies once, a stale one is refused, and a removed binding is not cleared", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await accounts(db);
    const exhausted = {
      bindingId: "A-R1",
      source: "result",
      observedAt: NOW,
      now: NOW,
      state: "exhausted",
      resetsAt: NOW + 1000,
    } as const;

    expect(await observe(db, { ...exhausted, sourceId: "s1" })).toEqual({ quota: "applied" });
    expect(await observe(db, { ...exhausted, sourceId: "s1" })).toEqual({ quota: "duplicate" });
    const ok = { ...exhausted, state: "ok", clears: ["quota"] } as const;
    expect(await observe(db, { ...ok, sourceId: "s2" })).toEqual({ quota: "stale" });
    expect(await db.run((q) => bindingAccountHealthSteps(q, "A-R2"))).toEqual([
      {
        kind: "quota",
        scope: "account",
        scopeId: "A",
        model: "",
        workspaceId: "acme",
        agent: "claude",
        state: "exhausted",
        source: "result",
        sourceId: "s1",
        bindingId: "A-R1",
        runnerId: "R1",
        observedAt: NOW,
        resetsAt: NOW + 1000,
        nextCheckAt: NOW + 1000 + ACCOUNT_RESET_SLACK_MS,
        failures: 1,
        updatedAt: NOW,
      },
    ]);

    await db.run((q) => resumeAccountHealthNowSteps(q, "claude", "R2", NOW + 5));
    expect((await db.run((q) => bindingAccountHealthSteps(q, "A-R1")))[0]?.nextCheckAt).toBe(
      NOW + 1000 + ACCOUNT_RESET_SLACK_MS,
    );
    await db.run((q) => resumeAccountHealthNowSteps(q, "claude", null, NOW + 5));
    expect((await db.run((q) => bindingAccountHealthSteps(q, "A-R1")))[0]?.nextCheckAt).toBe(
      NOW + 5,
    );

    await db.run(function* (q) {
      yield* q.exec(
        q.orm.update(q.t.agentAccount).set({ enabled: 0 }).where(eq(q.t.agentAccount.id, "A")),
      );
    });
    expect(
      await observe(db, { ...ok, sourceId: "s3", observedAt: NOW + 10, now: NOW + 10 }),
    ).toEqual({ quota: "removed" });
    expect(await db.run((q) => bindingAccountHealthSteps(q, "missing"))).toEqual([]);
  });

  test("a runner without a default binding reads its workspace's provider health", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await accounts(db);
    await observe(db, {
      bindingId: "A-R1",
      source: "result",
      sourceId: "s1",
      observedAt: NOW,
      now: NOW,
      state: "restricted",
    });
    const health = await db.run((q) => legacyBindingAccountHealthSteps(q, "R2", "claude"));
    expect(health.map((row) => [row.kind, row.scopeId, row.state])).toEqual([
      ["provider", "acme:claude", "restricted"],
    ]);
    expect(await db.run((q) => legacyBindingAccountHealthSteps(q, "R2", "codex"))).toEqual([]);
  });

  test("attempts in flight count open usage and retro dispatches on the account or binding", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await accounts(db);
    const command = (commandId: string, bindingId: string) =>
      seed(db, (q) =>
        q.orm.insert(q.t.runnerCommandAccount).values({
          commandId,
          workspaceId: "acme",
          runnerId: bindingId.slice(2),
          agent: "claude",
          accountId: "A",
          bindingId,
          named: 1,
          recordedAt: NOW,
        }),
      );
    const usage = (commandId: string, startedAt: number, endedAt: number | null = null) =>
      seed(db, (q) =>
        q.orm.insert(q.t.runnerExecutionUsage).values({
          commandId,
          runnerId: "R1",
          ownerUserId: "owner",
          role: "implementer",
          purpose: "work",
          startedAt,
          endedAt,
        }),
      );
    await command("u1", "A-R1");
    await usage("u1", NOW);
    await command("u2", "A-R1");
    await usage("u2", NOW, NOW + 1);
    await command("u3", "A-R1");
    await usage("u3", NOW - 1);
    await command("d1", "A-R2");
    await seed(db, (q) =>
      q.orm.insert(q.t.retroDispatch).values({
        commandId: "d1",
        retroId: "retro",
        attempt: 1,
        workspaceId: "acme",
        runnerId: "R2",
        runnerFence: 0,
        command: json(db, {}),
        envelope: json(db, {}),
        createdAt: NOW,
        issuedAt: NOW,
        expiresAt: NOW + 1,
      }),
    );

    const count = (bindingId: string, scope: "account" | "binding") =>
      db.run((q) => accountAttemptsInFlightSteps(q, bindingId, NOW, scope));
    expect(await count("A-R1", "account")).toBe(2);
    expect(await count("A-R1", "binding")).toBe(1);
    expect(await count("A-R2", "binding")).toBe(1);
    expect(await count("missing", "account")).toBe(0);
  });
});
