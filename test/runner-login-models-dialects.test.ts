import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  agentModelSourcesSteps,
  bindingRunningCountSteps,
  cachedAgentModelsSteps,
  cancelPendingRunnerLoginsSteps,
  closeRunnerLoginSteps,
  finishAgentModelProbeSteps,
  insertAgentModelProbeSteps,
  insertRunnerLoginSteps,
  lastAgentModelProbeAtSteps,
  latestAgentRunnerLoginIdSteps,
  latestBindingRunnerLoginIdSteps,
  pendingAgentModelProbesSteps,
  pendingRunnerLoginCountSteps,
  pendingRunnerLoginIdSteps,
  runnerAgentOpenWorkCountSteps,
  runnerAgentPolicyStateSteps,
  runnerHasOpenWorkSteps,
  runnerHealthCommandOutstandingSteps,
  runnerLeaseCutoff,
  runnerLoginRowSteps,
  runnerNamedBindingsSteps,
  saveAgentModelCatalogSteps,
  setRunnerAgentSignedInSteps,
  storedAgentBindingIdSteps,
  updateRunnerLoginSteps,
  type Db,
  type Q,
} from "../src/db";
import { forEachDialect, json, seed, withoutForeignKeys, type DialectDb } from "./dialects";
import { seedRun, seedRunner, seedWork } from "./runner-rows";

const NOW = 1_800_000_000_000;
const OWNER = { runnerId: "box", userId: "owner", agent: "codex" };
const handles: DialectDb[] = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
});

async function opened(open: () => Promise<DialectDb>) {
  const handle = await open();
  handles.push(handle);
  await withoutForeignKeys(handle.db);
  await seedRunner(handle.db, "box", { lastSeenAt: NOW });
  return handle.db;
}

const login = (
  id: string,
  row: { agent?: string; bindingId?: string; expiresAt?: number } = {},
) => ({
  id,
  runnerId: "box",
  workspaceId: "acme",
  userId: "owner",
  agent: "codex",
  expiresAt: NOW + 1_000,
  updatedAt: NOW,
  bindingId: null,
  ...row,
});

function insertLogin(db: Db, ...logins: Parameters<typeof insertRunnerLoginSteps>[1][]) {
  return db.run(function* (q) {
    for (const row of logins) yield* insertRunnerLoginSteps(q, row);
  });
}

const command =
  (id: string, kind: string, expiresAt = NOW + 1_000) =>
  (q: Q) =>
    q.orm.insert(q.t.runnerCommand).values({
      id,
      runnerId: "box",
      kind,
      envelope: (q.dialect === "sqlite" ? "{}" : {}) as string,
      expiresAt,
    });

const helper =
  (id: string, row: { endedAt?: number; result?: unknown; expiresAt?: number }) => (q: Q) =>
    q.orm.insert(q.t.runnerHelper).values({
      id,
      runnerId: "box",
      workspaceId: "acme",
      sessionId: "session",
      sessionGeneration: 1,
      runnerFence: 0,
      envelope: (q.dialect === "sqlite" ? "{}" : {}) as string,
      expiresAt: NOW + 1_000,
      ...row,
    });

const account = (runId: string, bindingId: string) => (q: Q) =>
  q.orm.insert(q.t.runnerCommandAccount).values({
    commandId: runId,
    workspaceId: "acme",
    runnerId: "box",
    agent: "codex",
    accountId: "account",
    bindingId,
    named: 1,
    recordedAt: NOW,
  });

async function seedOwnerMember(db: Db, revokedAt: number | null = null) {
  await seed(db, (q) =>
    q.orm.insert(q.t.workspaceMember).values({
      workspaceId: "acme",
      userId: "owner",
      role: "owner",
      source: "linear",
      active: 1,
      checkedAt: 0,
      revokedAt,
    }),
  );
}

forEachDialect((open) => {
  test("a sign-in is stored as starting and reads back with its columns", async () => {
    const db = await opened(open);
    await insertLogin(db, login("a", { bindingId: "binding" }));
    expect(await db.run((q) => runnerLoginRowSteps(q, "a"))).toEqual({
      id: "a",
      runnerId: "box",
      workspaceId: "acme",
      userId: "owner",
      agent: "codex",
      state: "starting",
      expiresAt: NOW + 1_000,
      terminal: "",
      authorization: null,
      inputId: null,
      bindingId: "binding",
    });
    expect(await db.run((q) => runnerLoginRowSteps(q, "missing"))).toBeNull();
  });

  test("progress updates a sign-in and closing it clears what the person saw", async () => {
    const db = await opened(open);
    await insertLogin(db, login("a"));
    await db.run((q) =>
      updateRunnerLoginSteps(q, "a", {
        state: "waiting",
        terminal: "code",
        authorization: '{"url":"https://auth.openai.com"}',
        inputId: "input",
        updatedAt: NOW + 5,
      }),
    );
    expect(await db.run((q) => runnerLoginRowSteps(q, "a"))).toMatchObject({
      state: "waiting",
      terminal: "code",
      authorization: '{"url":"https://auth.openai.com"}',
      inputId: "input",
    });
    await db.run((q) => closeRunnerLoginSteps(q, "a", "expired"));
    expect(await db.run((q) => runnerLoginRowSteps(q, "a"))).toMatchObject({
      state: "expired",
      terminal: "",
      authorization: null,
      inputId: null,
    });
  });

  test("cancelling touches only pending sign-ins, one or all", async () => {
    const db = await opened(open);
    await insertLogin(db, login("a"), login("b"), login("done"));
    await db.run((q) => closeRunnerLoginSteps(q, "done", "expired"));
    await db.run((q) => cancelPendingRunnerLoginsSteps(q, "done"));
    expect((await db.run((q) => runnerLoginRowSteps(q, "done")))?.state).toBe("expired");
    await db.run((q) => cancelPendingRunnerLoginsSteps(q, "a"));
    expect((await db.run((q) => runnerLoginRowSteps(q, "a")))?.state).toBe("cancelled");
    expect((await db.run((q) => runnerLoginRowSteps(q, "b")))?.state).toBe("starting");
    await db.run((q) => cancelPendingRunnerLoginsSteps(q));
    expect((await db.run((q) => runnerLoginRowSteps(q, "b")))?.state).toBe("cancelled");
    expect((await db.run((q) => runnerLoginRowSteps(q, "done")))?.state).toBe("expired");
  });

  test("the newest sign-in is found per agent account and per binding", async () => {
    const db = await opened(open);
    await insertLogin(
      db,
      login("older", { expiresAt: NOW + 1 }),
      login("newer", { expiresAt: NOW + 2 }),
      login("named-old", { bindingId: "binding", expiresAt: NOW + 3 }),
      login("named-new", { bindingId: "binding", expiresAt: NOW + 4 }),
      login("claude", { agent: "claude", expiresAt: NOW + 5 }),
    );
    expect(await db.run((q) => latestAgentRunnerLoginIdSteps(q, OWNER))).toBe("newer");
    expect(
      await db.run((q) =>
        latestBindingRunnerLoginIdSteps(q, {
          runnerId: "box",
          userId: "owner",
          bindingId: "binding",
        }),
      ),
    ).toBe("named-new");
    expect(
      await db.run((q) => latestAgentRunnerLoginIdSteps(q, { ...OWNER, userId: "someone" })),
    ).toBeNull();
  });

  test("a pending sign-in is matched on its binding, its state and its expiry", async () => {
    const db = await opened(open);
    await insertLogin(db, login("own"), login("named", { bindingId: "binding" }));
    const find = (bindingId: string | null, at = NOW) =>
      db.run((q) => pendingRunnerLoginIdSteps(q, { ...OWNER, bindingId, at }));
    expect(await find(null)).toBe("own");
    expect(await find("binding")).toBe("named");
    expect(await find("other")).toBeNull();
    expect(await find(null, NOW + 1_000)).toBeNull();
    expect(await db.run((q) => pendingRunnerLoginCountSteps(q, "box", NOW))).toBe(2);
    await db.run((q) => closeRunnerLoginSteps(q, "own", "cancelled"));
    expect(await find(null)).toBeNull();
    expect(await db.run((q) => pendingRunnerLoginCountSteps(q, "box", NOW))).toBe(1);
    expect(await db.run((q) => pendingRunnerLoginCountSteps(q, "box", NOW + 1_000))).toBe(0);
  });

  test("a health command stops occupying the lane once answered, expired or its sign-in ended", async () => {
    const db = await opened(open);
    const outstanding = (at = NOW) =>
      db.run((q) => runnerHealthCommandOutstandingSteps(q, "box", at));
    expect(await outstanding()).toBe(false);
    await seed(db, command("run", "run"), command("probe", "probe"));
    expect(await outstanding()).toBe(true);
    expect(await outstanding(NOW + 1_000)).toBe(false);
    await seed(db, (q) =>
      q.orm
        .insert(q.t.runnerHealthResult)
        .values({ commandId: "probe", runnerId: "box", resultJson: "{}", receivedAt: NOW }),
    );
    expect(await outstanding()).toBe(false);
    await seed(db, command("sign-in", "login"));
    await insertLogin(db, login("sign-in"));
    expect(await outstanding()).toBe(true);
    await db.run((q) => closeRunnerLoginSteps(q, "sign-in", "cancelled"));
    expect(await outstanding()).toBe(false);
  });

  test("model sources need a ready, signed-in agent and a usable owner", async () => {
    const db = await opened(open);
    await seedOwnerMember(db);
    await seed(
      db,
      (q) =>
        q.orm.insert(q.t.runnerAgentPolicy).values({ runnerId: "box", agent: "codex", ready: 1 }),
      (q) =>
        q.orm
          .insert(q.t.runnerAgentPolicy)
          .values({ runnerId: "box", agent: "claude", ready: 1, authExpired: 1 }),
      (q) =>
        q.orm
          .insert(q.t.runnerAgentPolicy)
          .values({ runnerId: "box", agent: "grok", ready: 1, cooldownUntil: NOW + 1 }),
    );
    const codex = {
      runnerId: "box",
      workspaceId: "acme",
      userId: "owner",
      agent: "codex" as const,
    };
    expect(await db.run((q) => agentModelSourcesSteps(q, NOW))).toEqual([codex]);
    const later = await db.run((q) => agentModelSourcesSteps(q, NOW + 1));
    expect(later.map((source) => source.agent).sort()).toEqual(["codex", "grok"]);
    await db.run(function* (q) {
      yield* q.exec(q.orm.update(q.t.workspaceMember).set({ revokedAt: NOW }));
    });
    expect(await db.run((q) => agentModelSourcesSteps(q, NOW))).toEqual([]);
  });

  test("a catalog entry round-trips as JSON text and is replaced on conflict", async () => {
    const db = await opened(open);
    const entry = { ...OWNER, model: "gpt", resultJson: '{"a":1}', updatedAt: NOW };
    await db.run(function* (q) {
      yield* saveAgentModelCatalogSteps(q, entry);
      yield* saveAgentModelCatalogSteps(q, { ...entry, model: "", updatedAt: NOW + 2 });
    });
    const first = await db.run((q) => cachedAgentModelsSteps(q, OWNER));
    expect(first.map((row) => row.model)).toEqual(["", "gpt"]);
    expect(JSON.parse(first[1]!.resultJson)).toEqual({ a: 1 });
    await db.run((q) =>
      saveAgentModelCatalogSteps(q, { ...entry, resultJson: '{"a":2}', updatedAt: NOW + 5 }),
    );
    const second = await db.run((q) => cachedAgentModelsSteps(q, OWNER));
    expect(second.map((row) => [row.model, row.updatedAt])).toEqual([
      ["gpt", NOW + 5],
      ["", NOW + 2],
    ]);
    expect(JSON.parse(second[0]!.resultJson)).toEqual({ a: 2 });
  });

  test("a probe is pending with its result until finished, and its time is remembered", async () => {
    const db = await opened(open);
    await seed(db, command("probe", "probe"));
    await db.run((q) =>
      insertAgentModelProbeSteps(q, { ...OWNER, commandId: "probe", model: "", requestedAt: NOW }),
    );
    const pending = () => db.run((q) => pendingAgentModelProbesSteps(q));
    expect(await pending()).toEqual([
      {
        commandId: "probe",
        runnerId: "box",
        userId: "owner",
        agent: "codex",
        model: "",
        resultJson: null,
        expiresAt: NOW + 1_000,
      },
    ]);
    await seed(db, (q) =>
      q.orm
        .insert(q.t.runnerHealthResult)
        .values({ commandId: "probe", runnerId: "box", resultJson: '{"ok":1}', receivedAt: NOW }),
    );
    expect((await pending())[0]?.resultJson).toBe('{"ok":1}');
    await db.run((q) => finishAgentModelProbeSteps(q, "probe", NOW + 1));
    expect(await pending()).toEqual([]);
    await seed(db, command("probe-2", "probe"));
    await db.run((q) =>
      insertAgentModelProbeSteps(q, {
        ...OWNER,
        commandId: "probe-2",
        model: "gpt",
        requestedAt: NOW + 7,
      }),
    );
    const last = (model?: string) => db.run((q) => lastAgentModelProbeAtSteps(q, OWNER, model));
    expect(await last()).toBe(NOW + 7);
    expect(await last("")).toBe(NOW);
    expect(await last("gpt")).toBe(NOW + 7);
    expect(await last("unknown")).toBe(0);
  });

  test("a binding is found by id and named bindings skip legacy and removed ones", async () => {
    const db = await opened(open);
    const binding =
      (id: string, accountId: string, row: object = {}) =>
      (q: Q) =>
        q.orm.insert(q.t.agentAccountBinding).values({
          id,
          workspaceId: "acme",
          accountId,
          agent: "codex",
          runnerId: "box",
          quotaScope: "unknown",
          createdAt: NOW,
          ...row,
        });
    const agentAccount =
      (id: string, label: string, row: object = {}) =>
      (q: Q) =>
        q.orm.insert(q.t.agentAccount).values({
          id,
          workspaceId: "acme",
          agent: "codex",
          label,
          createdAt: NOW,
          updatedAt: NOW,
          ...row,
        });
    await seed(
      db,
      agentAccount("A", "first"),
      agentAccount("B", "second", { createdAt: NOW + 1, enabled: 0 }),
      agentAccount("gone", "gone", { removedAt: NOW }),
      agentAccount("legacy", "legacy"),
      agentAccount("dropped", "dropped"),
      binding("b-later", "B"),
      binding("b-first", "A"),
      binding("b-legacy", "legacy", { legacy: 1 }),
      binding("b-removed", "dropped", { removedAt: NOW }),
      binding("b-gone-account", "gone"),
    );
    expect(await db.run((q) => storedAgentBindingIdSteps(q, "b-legacy"))).toBe("b-legacy");
    expect(await db.run((q) => storedAgentBindingIdSteps(q, "missing"))).toBeNull();
    expect(await db.run((q) => runnerNamedBindingsSteps(q, "box", "acme"))).toEqual([
      { bindingId: "b-first", accountId: "A", agent: "codex", label: "first", enabled: 1 },
      { bindingId: "b-later", accountId: "B", agent: "codex", label: "second", enabled: 0 },
    ]);
    expect(await db.run((q) => runnerNamedBindingsSteps(q, "box", "other"))).toEqual([]);
  });

  test("work and helpers count against a binding only while they are live", async () => {
    const db = await opened(open);
    const leased = runnerLeaseCutoff(NOW) + 1;
    await seedRun(db, "live", "item-1");
    await seedRun(db, "stale", "item-2");
    await seedWork(db, "live", "box", { commandId: "live", leaseUntil: leased });
    await seedWork(db, "stale", "box", { commandId: "stale", leaseUntil: leased - 1 });
    await seed(
      db,
      (q) =>
        q.orm.insert(q.t.agentAccountBinding).values({
          id: "binding",
          workspaceId: "acme",
          accountId: "account",
          agent: "codex",
          runnerId: "box",
          quotaScope: "unknown",
          createdAt: NOW,
        }),
      helper("helper-live", {}),
      helper("helper-ended", { endedAt: NOW }),
      (q) => helper("helper-answered", { result: json(db, { ok: true }) })(q),
      helper("helper-expired", { expiresAt: NOW }),
      account("live", "binding"),
      account("stale", "binding"),
      account("helper-live", "binding"),
      account("helper-ended", "binding"),
      account("helper-answered", "binding"),
      account("helper-expired", "binding"),
    );
    expect(await db.run((q) => bindingRunningCountSteps(q, "binding", NOW))).toBe(2);
    expect(await db.run((q) => bindingRunningCountSteps(q, "other", NOW))).toBe(0);
  });

  test("open work counts per agent within the lease grace", async () => {
    const db = await opened(open);
    const leased = runnerLeaseCutoff(NOW) + 1;
    const count = (agent: string, at = NOW) =>
      db.run((q) => runnerAgentOpenWorkCountSteps(q, "box", agent, at));
    await seedRun(db, "live", "item-1");
    await seedRun(db, "ended", "item-2");
    await seedWork(db, "live", "box", { commandId: "live", leaseUntil: leased });
    await seedWork(db, "ended", "box", { commandId: "ended", leaseUntil: leased, endedAt: NOW });
    expect(await count("codex")).toBe(1);
    expect(await count("claude")).toBe(0);
    expect(await count("codex", NOW + 1)).toBe(0);
  });

  test("a runner has open work while either its work or a helper is live", async () => {
    const db = await opened(open);
    const leased = runnerLeaseCutoff(NOW) + 1;
    const busy = (at = NOW) => db.run((q) => runnerHasOpenWorkSteps(q, "box", at));
    expect(await busy()).toBe(false);
    await seedRun(db, "live", "item-1");
    await seedWork(db, "live", "box", { commandId: "live", leaseUntil: leased });
    expect(await busy()).toBe(true);
    await db.run(function* (q) {
      yield* q.exec(q.orm.update(q.t.runnerWork).set({ endedAt: NOW }));
    });
    expect(await busy()).toBe(false);
    await seed(db, helper("helper", {}));
    expect(await busy()).toBe(true);
    expect(await busy(NOW + 1_000)).toBe(false);
    await db.run(function* (q) {
      const { runnerHelper } = q.t;
      yield* q.exec(
        q.orm.update(runnerHelper).set({ endedAt: NOW }).where(eq(runnerHelper.id, "helper")),
      );
    });
    expect(await busy()).toBe(false);
  });

  test("signing in or out writes the agent's policy and keeps its other columns", async () => {
    const db = await opened(open);
    const state = () => db.run((q) => runnerAgentPolicyStateSteps(q, "box", "codex"));
    expect(await state()).toBeNull();
    await db.run((q) => setRunnerAgentSignedInSteps(q, "box", "codex", false));
    expect(await state()).toEqual({
      ready: 0,
      authExpired: 1,
      extraUsage: 0,
      quotaState: "ok",
      resetsAt: null,
      cooldownUntil: 0,
    });
    await db.run(function* (q) {
      yield* q.exec(q.orm.update(q.t.runnerAgentPolicy).set({ extraUsage: 1, cooldownUntil: 9 }));
    });
    await db.run((q) => setRunnerAgentSignedInSteps(q, "box", "codex", true));
    expect(await state()).toMatchObject({
      ready: 1,
      authExpired: 0,
      extraUsage: 1,
      cooldownUntil: 9,
    });
  });
});
