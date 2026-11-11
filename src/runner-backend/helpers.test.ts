import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  advanceLinearSessionGeneration,
  beginImplementRun,
  bindAgentAccount,
  createAgentAccount,
  recordRunnerAccountCapability,
  consumeWorkspaceBootstrap,
  insertQueuedItem,
  migrate,
  usagePause,
  openDatabase,
  putWorkspaceUser,
  recordLinearInstallation,
  recordRunnerCapacity,
  sqliteDb,
  syncSteps,
} from "../db";
import { RunnerSlotsBusyError, UserFacingError } from "../core";
import { DEFAULT_RUN_TIMEOUT_MS, recoverAcpConversation, type RunAgentOptions } from "../acp";
import { createRunnerHelpers } from "../runner-helpers";
import { workspaceId, workspaceTokenHash, issueWorkspaceBootstrap } from "../workspace";
import { createRemoteSessionAgentRunner } from "./helpers";
import {
  RetryableRunnerError,
  runWithFailover,
  USAGE_LIMIT_RESUME_SLACK_MS,
  UsageLimitPause,
} from "./failover";
import { createRunnerPlacement, quotaSignal, type RunnerPlacement } from "../runner-placement";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

async function fixture(
  placement?: (
    db: Awaited<ReturnType<typeof openDatabase>>,
    now: () => number,
  ) => RunnerPlacement | Promise<RunnerPlacement>,
) {
  const root = mkdtempSync(join(tmpdir(), "paws-helper-backend-"));
  const db = openDatabase(join(root, "paws.db"));
  migrate(db);
  let now = Date.now();
  const userId = await putWorkspaceUser(sqliteDb(db), {
    id: workspaceId(),
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const workspace = await consumeWorkspaceBootstrap(sqliteDb(db), {
    id: workspaceId(),
    organizationId: "org",
    name: "Fixture",
    userId,
    tokenHash: workspaceTokenHash(await issueWorkspaceBootstrap(db, "org", now)),
    now,
  });
  db.run(
    "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES(?,?,?,'Fixture','active',?,?)",
    ["runner", workspace.id, userId, now, now],
  );
  await recordLinearInstallation(sqliteDb(db), {
    organizationId: "org",
    oauthClientId: "app",
    appUserId: "app-user",
    sessionId: "session",
    teamId: "team",
    observedAtMs: now,
  });
  const helpers = createRunnerHelpers({
    store: sqliteDb(db),
    keyId: "fixture",
    privateKey: generateKeyPairSync("ed25519").privateKey,
    now: () => now,
  });
  const journaled: string[] = [];
  const backend = createRemoteSessionAgentRunner({
    store: sqliteDb(db),
    helpers,
    now: () => now,
    pollIntervalMs: 1,
    placement: await placement?.(db, () => now),
    journal: (line) => journaled.push(line),
  });
  const input: RunAgentOptions = {
    itemId: "not-an-item",
    runId: "not-a-run",
    worktreePath: root,
    pawsRoot: root,
    role: "implementer",
    profile: { agent: "codex", model: null },
    prompt: "Classify this request",
    readOnly: true,
    checkpoint: false,
  };
  async function current() {
    const row = db
      .query<{ id: string }, []>("SELECT id FROM runner_helper ORDER BY rowid DESC")
      .get();
    if (!row) throw new Error("Expected dispatched helper");
    return (await helpers.current(row.id)).command;
  }
  /** Waits for the backend to read the store and dispatch its helper. */
  async function dispatched() {
    for (let tick = 0; tick < 100; tick++) {
      if (db.query("SELECT 1 FROM runner_helper WHERE ended_at IS NULL").get()) break;
      await Bun.sleep(0);
    }
    return current();
  }
  async function reply(text = '{"mode":"answer"}') {
    const command = await current();
    await helpers.submit(command.runnerId, {
      executionId: "01J00000000000000000000000",
      commandId: command.id,
      role: "implementer",
      stopReason: "end_turn",
      cancelled: false,
      timedOut: false,
      authRequired: false,
      agentExited: true,
      text,
    });
  }
  cleanup.push(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    db,
    backend,
    input,
    helpers,
    current,
    dispatched,
    reply,
    journaled,
    advance: (ms: number) => (now += ms),
  };
}

test.each(["classify", "select_repository"] as const)(
  "session backend dispatches %s before item/repository selection and restores its result",
  async (purpose) => {
    const f = await fixture();
    let text = "";
    const pending = f.backend.forSession(
      "session",
      purpose,
    )({
      ...f.input,
      onEvent(event) {
        if (
          event.type === "session_update" &&
          event.update.sessionUpdate === "agent_message_chunk" &&
          event.update.content.type === "text"
        )
          text += event.update.content.text;
      },
    });
    await f.dispatched();
    expect((await f.current()).purpose).toBe(purpose);
    expect((await f.current()).prompt).toBe(f.input.prompt);
    expect(f.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM work_item").get()!.n).toBe(0);
    await f.reply();
    const result = await pending;
    expect(text).toBe('{"mode":"answer"}');
    expect(await recoverAcpConversation(result.transcriptPath!)).toEqual([
      { kind: "response", body: text },
    ]);
    expect(
      f.db.query<{ ended: number }, []>("SELECT ended_at AS ended FROM runner_helper").get()!.ended,
    ).toBeGreaterThan(0);
  },
);

test("session replacement fences a pending helper and releases its canonical assignment", async () => {
  const f = await fixture();
  const pending = f.backend.forSession("session", "classify")(f.input);
  await f.dispatched();
  await advanceLinearSessionGeneration(sqliteDb(f.db), "session");
  await expect(pending).rejects.toThrow(/authority changed/);
  expect(
    f.db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runner_helper WHERE ended_at IS NULL")
      .get()!.n,
  ).toBe(0);
});

test("cancelling a helper fences later output without invoking a local agent", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const pending = f.backend.forSession(
    "session",
    "classify",
  )({ ...f.input, signal: controller.signal });
  const command = await f.dispatched();
  controller.abort();
  await expect(pending).rejects.toThrow();
  await expect(f.helpers.current(command.id)).rejects.toThrow(/unavailable/);
});

test("a replacement during the event callback cannot return stale classification", async () => {
  const f = await fixture();
  let events = 0;
  const pending = f.backend.forSession(
    "session",
    "classify",
  )({
    ...f.input,
    async onEvent() {
      events++;
      await advanceLinearSessionGeneration(sqliteDb(f.db), "session");
    },
  });
  await f.dispatched();
  await f.reply();
  await expect(pending).rejects.toThrow(/authority changed/);
  expect(events).toBe(1);
});

test("no active runner fails closed and a deadline cannot retain capacity", async () => {
  const f = await fixture();
  f.db.run("UPDATE runner SET status='paused'");
  await expect(f.backend.forSession("session", "classify")(f.input)).rejects.toThrow(
    /No paired runner can run/,
  );
  f.db.run("UPDATE runner SET status='active'");
  const pending = f.backend.forSession("session", "classify")(f.input);
  await f.helpers.acknowledge("runner", (await f.dispatched()).id);
  f.advance(60_000);
  await expect(pending).rejects.toThrow(/timed out/);
  expect(
    f.db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runner_helper WHERE ended_at IS NULL")
      .get()!.n,
  ).toBe(0);
});

async function fillRunner(f: Awaited<ReturnType<typeof fixture>>) {
  insertQueuedItem(f.db, { id: "busy", now: Date.now(), sessionKey: "busy-session" });
  const { run } = await beginImplementRun(sqliteDb(f.db), "busy", Date.now());
  f.db.run(
    "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until) SELECT ?,id,workspace_id,1,0,'busy',? FROM runner WHERE id='runner'",
    [run.id, Date.now() + 3_600_000],
  );
}

test("a helper waits while task work fills the runner and starts once a slot frees", async () => {
  const f = await fixture();
  await fillRunner(f);
  let settled = false;
  const pending = f.backend.forSession("session", "classify")(f.input);
  void pending.then(
    () => (settled = true),
    () => (settled = true),
  );
  await Bun.sleep(30);
  expect(settled).toBe(false);
  f.db.run("UPDATE runner_work SET ended_at=?,teardown_confirmed_at=? WHERE command_id='busy'", [
    Date.now(),
    Date.now(),
  ]);
  for (let attempt = 0; attempt < 200; attempt++) {
    if (settled || f.db.query("SELECT 1 FROM runner_helper").get()) break;
    await Bun.sleep(2);
  }
  expect((await f.current()).runnerId).toBe("runner");
  await f.helpers.acknowledge("runner", (await f.current()).id);
  f.advance(60_000);
  await expect(pending).rejects.toThrow(/timed out/);
});

test("a helper still blocked by task work at its deadline reports the runner slots as busy", async () => {
  const f = await fixture();
  await fillRunner(f);
  const pending = f.backend.forSession("session", "classify")(f.input);
  await Bun.sleep(10);
  // The runner stays online for the whole wait; only its slots are taken.
  f.db.run("UPDATE runner SET last_seen_at=last_seen_at+60000");
  f.advance(60_000);
  await expect(pending).rejects.toBeInstanceOf(RunnerSlotsBusyError);
});

const HELPER_SLOT_TAKEN = "helper already running or no free capacity";

test("a helper slot still busy at the deadline is a wait, not a failure", async () => {
  const f = await fixture(() => ({
    async candidates(input) {
      input.onRejected?.("runner", HELPER_SLOT_TAKEN);
      return [];
    },
    startedSteps: () =>
      syncSteps(() => {
        throw new Error("Must not dispatch");
      }),
    finishedSteps: () =>
      syncSteps(() => {
        return { retryable: false };
      }),
  }));
  const pending = f.backend.forSession("session", "classify")(f.input);
  await Bun.sleep(10);
  f.advance(60_000);
  await expect(pending).rejects.toBeInstanceOf(RunnerSlotsBusyError);
});

test("a helper that times out while other starts queue on its slot is a wait", async () => {
  let held = false;
  const f = await fixture(() => ({
    async candidates(input) {
      if (held) {
        input.onRejected?.("runner", HELPER_SLOT_TAKEN);
        return [];
      }
      held = true;
      return [{ id: "runner", workspaceId: "workspace" }];
    },
    startedSteps: () => syncSteps(() => {}),
    finishedSteps: () =>
      syncSteps(() => {
        return { retryable: false };
      }),
  }));
  const holder = f.backend.forSession("session", "classify")(f.input);
  await Bun.sleep(10);
  f.advance(1);
  const queued = f.backend.forSession("session", "classify")(f.input);
  await Bun.sleep(10);
  f.advance(60_000);
  const outcomes = await Promise.allSettled([holder, queued]);
  for (const outcome of outcomes) {
    expect(outcome.status).toBe("rejected");
    expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(RunnerSlotsBusyError);
  }
});

test.each([
  ["agent-not-signed-in", "agent not signed in"],
  ["auth-expired", "auth expired"],
  ["revoked", "revoked"],
])("a runner refused for %s fails at once and names the cause", async (reason, named) => {
  const f = await fixture(() => ({
    async candidates(input) {
      input.onRejected?.("runner", reason);
      return [];
    },
    startedSteps: () =>
      syncSteps(() => {
        throw new Error("Must not dispatch");
      }),
    finishedSteps: () =>
      syncSteps(() => {
        return { retryable: false };
      }),
  }));
  const error = await f.backend
    .forSession(
      "session",
      "classify",
    )(f.input)
    .catch((caught: unknown) => caught);
  expect(error).not.toBeInstanceOf(RunnerSlotsBusyError);
  expect((error as Error).message).toContain(`No paired runner can run codex`);
  expect((error as Error).message).toContain(named);
});

test("session helpers reject executable-work and file/tool contracts before dispatch", async () => {
  const f = await fixture();
  for (const override of [
    { readOnly: false },
    { role: "reviewer" as const },
    { prepareOnly: true },
    { prepareInputFiles: async () => ({ prompt: "x", inputFiles: [] }) },
  ])
    await expect(
      f.backend.forSession("session", "classify")({ ...f.input, ...override }),
    ).rejects.toThrow(/read-only prompt/);
  expect(f.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runner_helper").get()!.n).toBe(0);
});

test("Placement selects a real helper host and records admission and outcome atomically", async () => {
  const calls: string[] = [];
  const f = await fixture((db, now) => ({
    async candidates(input) {
      expect(input.sessionId).toBe("session");
      expect(input.purpose).toBe("helper");
      expect(input.profile).toEqual({ agent: "codex", model: null });
      calls.push("candidates");
      const runner = db
        .query<{ workspaceId: string; userId: string }, []>(
          "SELECT workspace_id AS workspaceId,owner_user_id AS userId FROM runner LIMIT 1",
        )
        .get()!;
      db.run(
        "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES('selected',?,?,'Selected','active',?,?)",
        [runner.workspaceId, runner.userId, now(), now()],
      );
      return [{ id: "selected", workspaceId: runner.workspaceId }];
    },
    startedSteps: (_q, input) =>
      syncSteps(() => {
        expect(db.inTransaction).toBe(true);
        expect(input.runnerId).toBe("selected");
        expect(
          db.query("SELECT 1 FROM runner_helper WHERE id=?").get(input.commandId),
        ).not.toBeNull();
        calls.push("started");
      }),
    finishedSteps: (_q, input) =>
      syncSteps(() => {
        expect(db.inTransaction).toBe(true);
        expect(input.result?.agentExited).toBe(true);
        calls.push("finished");
        return { retryable: false };
      }),
  }));
  const pending = f.backend.forSession("session", "classify")(f.input);
  for (let attempt = 0; attempt < 1000 && calls.length < 2; attempt++) await Bun.sleep(1);
  expect(calls.length).toBe(2);
  expect((await f.current()).runnerId).toBe("selected");
  await f.reply();
  await pending;
  expect(calls).toEqual(["candidates", "started", "finished"]);
});

test("Rejected placement admission rolls back the signed helper command", async () => {
  const f = await fixture((db) => ({
    async candidates() {
      return [
        {
          id: "runner",
          workspaceId: db.query<{ id: string }, []>("SELECT id FROM workspace").get()!.id,
        },
      ];
    },
    startedSteps: () =>
      syncSteps(() => {
        throw new Error("Shared host authorization changed");
      }),
    finishedSteps: () =>
      syncSteps(() => {
        return { retryable: false };
      }),
  }));
  await expect(f.backend.forSession("session", "classify")(f.input)).rejects.toThrow(
    /No paired runner can run/,
  );
  expect(f.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runner_helper").get()!.n).toBe(0);
});

test("An empty placement decision cannot fall back to another paired host", async () => {
  const f = await fixture(() => ({
    async candidates() {
      return [];
    },
    startedSteps: () =>
      syncSteps(() => {
        throw new Error("Must not dispatch");
      }),
    finishedSteps: () =>
      syncSteps(() => {
        return { retryable: false };
      }),
  }));
  await expect(f.backend.forSession("session", "classify")(f.input)).rejects.toThrow(
    /No paired runner can run/,
  );
  expect(f.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runner_helper").get()!.n).toBe(0);
});

test("Three real helper assignments fail over after expired authentication and observed quota", async () => {
  const attempts: string[] = [];
  const f = await fixture((db, now) => ({
    async candidates(request) {
      const owner = db
        .query<{ workspaceId: string; userId: string }, []>(
          "SELECT workspace_id AS workspaceId,owner_user_id AS userId FROM runner LIMIT 1",
        )
        .get()!;
      for (const id of ["second", "third"])
        db.run(
          "INSERT OR IGNORE INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES(?,?,?,?,'active',?,?)",
          [id, owner.workspaceId, owner.userId, id, now(), now()],
        );
      return ["runner", "second", "third"]
        .filter((id) => !request.excludeRunnerIds?.includes(id))
        .map((id) => ({ id, workspaceId: owner.workspaceId }));
    },
    startedSteps: (_q, request) =>
      syncSteps(() => {
        expect(db.inTransaction).toBe(true);
        attempts.push(request.runnerId);
      }),
    finishedSteps: (_q, observation) =>
      syncSteps(() => {
        return {
          retryable:
            Boolean(observation.result?.authRequired) ||
            quotaSignal(observation.result?.errorMessage ?? "", now())?.state === "exhausted",
        };
      }),
  }));
  const pending = f.backend.forSession("session", "classify")(f.input);
  const waitAttempt = async (count: number) => {
    for (let index = 0; index < 1000 && attempts.length < count; index++) await Bun.sleep(1);
    expect(attempts.length).toBe(count);
    return f.current();
  };
  const first = await waitAttempt(1);
  const submit = (
    command: Awaited<ReturnType<typeof f.current>>,
    authRequired: boolean,
    errorMessage?: string,
  ) =>
    f.helpers.submit(command.runnerId, {
      executionId: workspaceId(),
      commandId: command.id,
      role: "implementer",
      stopReason: "error",
      cancelled: false,
      timedOut: false,
      authRequired,
      agentExited: true,
      text: "",
      ...(errorMessage ? { errorMessage } : {}),
    });
  await submit(first, true, "Agent login expired");
  const second = await waitAttempt(2);
  expect(second.id).not.toBe(first.id);
  expect(second.prompt).toContain("fresh agent session");
  expect(
    f.db
      .query<{ ended: number }, [string]>("SELECT ended_at AS ended FROM runner_helper WHERE id=?")
      .get(first.id)!.ended,
  ).toBeGreaterThan(0);
  await submit(second, false, "You've hit your session limit. Retry-After: 120");
  const third = await waitAttempt(3);
  expect(third.id).not.toBe(second.id);
  await f.reply();
  const result = await pending;
  expect(result.stopReason).toBe("end_turn");
  expect(attempts).toEqual(["runner", "second", "third"]);
  expect(
    f.db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM runner_helper WHERE ended_at IS NOT NULL",
      )
      .get()!.n,
  ).toBe(3);
  expect(f.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM work_item").get()!.n).toBe(0);
});

test("Human continuation time does not exhaust the remote execution retry budget", async () => {
  let attempts = 0;
  const result = await runWithFailover(
    {
      ...(await fixture()).input,
      timeoutMs: 100,
      askTeam: {
        async ask() {
          await Bun.sleep(150);
          return { answer: "Keep the existing artifact" };
        },
      },
    },
    async (input) => {
      if (++attempts === 1) throw new RetryableRunnerError("first", "Interrupted", undefined, true);
      if (attempts === 2) throw new RetryableRunnerError("second", "Quota exhausted");
      expect(input.prompt).toContain("Keep the existing artifact");
      expect(input.timeoutMs).toBeGreaterThan(0);
      return {
        role: "implementer",
        stopReason: "end_turn",
        cancelled: false,
        timedOut: false,
        authRequired: false,
        agentExited: true,
        transcriptPath: "unused",
      };
    },
    async () => {},
  );
  expect(attempts).toBe(3);
  expect(result.stopReason).toBe("end_turn");
});

test("A remote run without a timeout gets the item's awake budget, not 45 minutes", async () => {
  const { timeoutMs, ...input } = (await fixture()).input;
  let granted = 0;
  await runWithFailover(
    input,
    async (attempt) => {
      granted = attempt.timeoutMs ?? 0;
      return {
        role: "implementer",
        stopReason: "end_turn",
        cancelled: false,
        timedOut: false,
        authRequired: false,
        agentExited: true,
        transcriptPath: "unused",
      };
    },
    async () => {},
  );
  expect(timeoutMs).toBeUndefined();
  expect(granted).toBeGreaterThan(DEFAULT_RUN_TIMEOUT_MS - 1000);
});

test("a helper waits for the runner's busy helper slot instead of failing", async () => {
  const f = await fixture();
  const helperCount = () =>
    f.db.query<{ n: number }, []>("SELECT count(*) AS n FROM runner_helper").get()!.n;
  const first = f.backend.forSession("session", "classify")(f.input);
  while (helperCount() < 1) await Bun.sleep(1);
  const second = f.backend.forSession("session", "select_repository")(f.input);
  await Bun.sleep(20);
  expect(helperCount()).toBe(1);
  await f.reply();
  await first;
  while (helperCount() < 2) await Bun.sleep(1);
  await f.reply();
  expect((await second).stopReason).toBe("end_turn");
});

function coolingRunner(rejection = "agent quota cooldown") {
  return (db: Awaited<ReturnType<typeof openDatabase>>, now: () => number): RunnerPlacement => ({
    async candidates(request) {
      const cooldown =
        db
          .query<{ until: number }, []>(
            "SELECT cooldown_until AS until FROM runner_agent_policy WHERE runner_id='runner' AND agent='codex'",
          )
          .get()?.until ?? 0;
      if (cooldown > now() || rejection !== "agent quota cooldown") {
        request.onRejected?.("runner", rejection);
        return [];
      }
      return [{ id: "runner", workspaceId: "unused" }];
    },
    startedSteps: () => syncSteps(() => {}),
    finishedSteps: () =>
      syncSteps(() => {
        return { retryable: false };
      }),
  });
}

function coolDown(f: Awaited<ReturnType<typeof fixture>>, until: number) {
  f.db.run(
    "INSERT INTO runner_agent_policy(runner_id,agent,quota_state,cooldown_until) VALUES('runner','codex','exhausted',?)",
    [until],
  );
}

test("a runner only in its quota cooldown pauses the helper until the reset", async () => {
  const f = await fixture(coolingRunner());
  const resetsAt = Date.now() + 30 * 60_000;
  coolDown(f, resetsAt);
  const pause = await f.backend
    .forSession(
      "session",
      "classify",
    )(f.input)
    .catch((error: unknown) => error);
  expect(pause).toBeInstanceOf(UsageLimitPause);
  expect(pause).toMatchObject({
    agent: "codex",
    runnerId: "runner",
    resetsAt,
    resumeAt: resetsAt + USAGE_LIMIT_RESUME_SLACK_MS,
  });
  expect(f.db.query("SELECT 1 FROM runner_helper").get()).toBeNull();
});

test("a session item waits in a usage pause and places the helper once the cooldown passes", async () => {
  const f = await fixture(coolingRunner());
  const resetsAt = Date.now() + 30 * 60_000;
  coolDown(f, resetsAt);
  insertQueuedItem(f.db, { id: "item", now: Date.now(), sessionKey: "session" });
  const { run } = await beginImplementRun(sqliteDb(f.db), "item", Date.now());
  let settled = false;
  const pending = f.backend.forSession("session", "classify")(f.input);
  void pending.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let attempt = 0; attempt < 500 && !(await usagePause(sqliteDb(f.db), run.id)); attempt++)
    await Bun.sleep(1);
  expect(await usagePause(sqliteDb(f.db), run.id)).toMatchObject({
    itemId: "item",
    agent: "codex",
    runnerId: "runner",
    resetsAt,
    resumeAt: resetsAt + USAGE_LIMIT_RESUME_SLACK_MS,
  });
  expect(settled).toBe(false);
  f.advance(31 * 60_000 + USAGE_LIMIT_RESUME_SLACK_MS);
  for (
    let attempt = 0;
    attempt < 500 && !f.db.query("SELECT 1 FROM runner_helper").get();
    attempt++
  )
    await Bun.sleep(1);
  expect((await f.current()).runnerId).toBe("runner");
  expect(await usagePause(sqliteDb(f.db), run.id)).toBeNull();
  await f.reply();
  expect((await pending).stopReason).toBe("end_turn");
  expect(f.db.query<{ state: string }, []>("SELECT state FROM work_item").get()!.state).toBe(
    "running",
  );
});

test("a helper with no runner in a cooldown keeps the unavailable-runner error", async () => {
  const f = await fixture(coolingRunner("offline"));
  coolDown(f, Date.now() + 30 * 60_000);
  const error = await f.backend
    .forSession(
      "session",
      "classify",
    )(f.input)
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(UserFacingError);
  expect((error as Error).message).toMatch(/No paired runner can run codex/);
});

test("a helper whose named account hits its quota retries with the next account on the same runner", async () => {
  const requests: (readonly string[] | undefined)[] = [];
  let exhausted = "";
  const bindings: { accountId: string; bindingId: string }[] = [];
  const f = await fixture((db) => ({
    async candidates(request) {
      requests.push(request.excludeRunnerIds);
      if (bindings.length === 0) {
        const workspace = db
          .query<{ id: string }, []>("SELECT workspace_id AS id FROM runner WHERE id='runner'")
          .get()!.id;
        for (const label of ["A", "B"]) {
          const account = await createAgentAccount(sqliteDb(db), {
            workspaceId: workspace,
            agent: "codex",
            label,
            now: Date.now(),
          });
          const binding = await bindAgentAccount(sqliteDb(db), {
            workspaceId: workspace,
            accountId: account.id,
            runnerId: "runner",
            now: Date.now(),
          });
          bindings.push({ accountId: account.id, bindingId: binding.id });
        }
        db.run(
          "INSERT INTO runner_host_status(runner_id,runner_version,reported_at) VALUES('runner','0.1.61',?)",
          [Date.now()],
        );
        await recordRunnerAccountCapability(
          sqliteDb(db),
          "runner",
          {
            protocol: 1,
            bindings: bindings.map(({ bindingId }) => ({ bindingId, agent: "codex" })),
          },
          Date.now(),
        );
      }
      const runnerWorkspace = db
        .query<{ id: string }, []>("SELECT workspace_id AS id FROM runner WHERE id='runner'")
        .get()!.id;
      return bindings
        .filter(({ bindingId }) => bindingId !== exhausted)
        .map((account) => ({
          id: "runner",
          workspaceId: runnerWorkspace,
          account: { ...account, named: true },
        }));
    },
    startedSteps: () => syncSteps(() => {}),
    finishedSteps: (_q, observation) =>
      syncSteps(() => {
        const limited = quotaSignal(observation.result?.errorMessage ?? "", Date.now());
        if (limited?.state !== "exhausted") return { retryable: false };
        exhausted = bindings[0]!.bindingId;
        return { retryable: true, usageLimit: { resetsAt: null, recheckAt: Date.now() + 60_000 } };
      }),
  }));
  const pending = f.backend.forSession("session", "classify")(f.input);
  const helperCount = () =>
    f.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runner_helper").get()!.n;
  for (let attempt = 0; attempt < 1000 && helperCount() < 1; attempt++) await Bun.sleep(1);
  const first = await f.current();
  expect(first.account?.bindingId).toBe(bindings[0]!.bindingId);
  await f.helpers.submit(first.runnerId, {
    executionId: workspaceId(),
    commandId: first.id,
    role: "implementer",
    stopReason: "error",
    cancelled: false,
    timedOut: false,
    authRequired: false,
    agentExited: true,
    text: "",
    errorMessage: "You've hit your session limit. Retry-After: 120",
    account: first.account!,
  });
  for (let attempt = 0; attempt < 1000 && helperCount() < 2; attempt++) await Bun.sleep(1);
  const second = await f.current();
  expect(second.runnerId).toBe("runner");
  expect(second.account?.bindingId).toBe(bindings[1]!.bindingId);
  expect(requests.at(-1) ?? []).not.toContain("runner");
  await f.helpers.submit(second.runnerId, {
    executionId: workspaceId(),
    commandId: second.id,
    role: "implementer",
    stopReason: "end_turn",
    cancelled: false,
    timedOut: false,
    authRequired: false,
    agentExited: true,
    text: '{"mode":"answer"}',
    account: second.account!,
  });
  expect((await pending).stopReason).toBe("end_turn");
});

function secondRunner(f: Awaited<ReturnType<typeof fixture>>) {
  f.db.run(
    "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) SELECT 'second',workspace_id,owner_user_id,'Second','active',created_at,last_seen_at FROM runner WHERE id='runner'",
  );
}

async function linearSession(f: Awaited<ReturnType<typeof fixture>>, sessionId: string) {
  await recordLinearInstallation(sqliteDb(f.db), {
    organizationId: "org",
    oauthClientId: "app",
    appUserId: "app-user",
    sessionId,
    teamId: "team",
    observedAtMs: Date.now(),
  });
}

const helperResult = (commandId: string) => ({
  executionId: workspaceId(),
  commandId,
  role: "implementer" as const,
  stopReason: "end_turn" as const,
  cancelled: false,
  timedOut: false,
  authRequired: false,
  agentExited: true,
  text: '{"mode":"answer"}',
});

test("twelve resuming items keep one unacknowledged helper per runner and none fails", async () => {
  const f = await fixture();
  secondRunner(f);
  const sessions = Array.from({ length: 12 }, (_, index) => `session-${index}`);
  for (const session of sessions) await linearSession(f, session);
  const openHelpers = () =>
    f.db
      .query<{ id: string; runnerId: string; acked: number | null }, [number]>(
        "SELECT id,runner_id AS runnerId,acknowledged_at AS acked FROM runner_helper WHERE ended_at IS NULL AND result IS NULL AND expires_at>?",
      )
      .all(f.advance(0));
  const unacknowledgedPerRunner = () => {
    const counts = new Map<string, number>();
    for (const { runnerId, acked } of openHelpers())
      if (acked === null) counts.set(runnerId, (counts.get(runnerId) ?? 0) + 1);
    return Math.max(0, ...counts.values());
  };
  const failures: unknown[] = [];
  let lanesBusy = 0;
  const resume = async (session: string) => {
    for (;;)
      try {
        return await f.backend.forSession(session, "classify")(f.input);
      } catch (error) {
        if (!(error instanceof RunnerSlotsBusyError)) {
          failures.push(error);
          throw error;
        }
        lanesBusy++;
      }
  };
  const all = Promise.all(sessions.map(resume));
  const progress = { done: false };
  void all.finally(() => (progress.done = true)).catch(() => undefined);
  while (new Set(openHelpers().map((row) => row.runnerId)).size < 2) await Bun.sleep(1);
  await Bun.sleep(20);
  expect(openHelpers()).toHaveLength(2);
  expect(unacknowledgedPerRunner()).toBe(1);

  f.db.run("UPDATE runner SET last_seen_at=?", [f.advance(60_000)]);
  let peak = 0;
  while (!progress.done) {
    peak = Math.max(peak, unacknowledgedPerRunner());
    for (const { id, runnerId } of openHelpers()) {
      await f.helpers.acknowledge(runnerId, id);
      await f.helpers.submit(runnerId, helperResult(id));
    }
    await Bun.sleep(1);
  }
  await all;
  expect(failures).toEqual([]);
  expect(lanesBusy).toBeGreaterThan(0);
  expect(peak).toBeLessThanOrEqual(1);
  expect(
    f.db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runner_helper WHERE result IS NOT NULL")
      .get()!.n,
  ).toBe(12);
});

test("a helper the runner never picked up waits for the lane, one it ran and failed does not", async () => {
  const f = await fixture();
  const unpicked = f.backend.forSession("session", "classify")(f.input);
  await f.dispatched();
  f.db.run("UPDATE runner SET last_seen_at=?", [f.advance(60_000)]);
  await expect(unpicked).rejects.toBeInstanceOf(RunnerSlotsBusyError);
  const ran = f.backend.forSession("session", "classify")(f.input);
  await f.helpers.acknowledge("runner", (await f.dispatched()).id);
  f.advance(60_000);
  const failure = await ran.catch((error: unknown) => error);
  expect(failure).not.toBeInstanceOf(RunnerSlotsBusyError);
  expect((failure as Error).message).toBe("Remote session helper timed out");
});

test("a retry reuses the item's open helper instead of sending a second", async () => {
  const f = await fixture();
  const out = await f.helpers.dispatch({
    runnerId: "runner",
    sessionId: "session",
    purpose: "classify",
    profile: { agent: "codex", model: null },
    prompt: f.input.prompt,
  });
  const retry = f.backend.forSession("session", "classify")(f.input);
  await Bun.sleep(10);
  expect(f.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runner_helper").get()!.n).toBe(1);
  await f.helpers.submit("runner", helperResult(out.command.id));
  expect((await retry).stopReason).toBe("end_turn");
  await expect(f.helpers.current(out.command.id)).rejects.toThrow(/unavailable/);
});

test("a reused helper's sign-in failure excludes its named account, not the runner", async () => {
  const excluded: (readonly string[] | undefined)[] = [];
  const f = await fixture(() => ({
    async candidates(request) {
      excluded.push(request.excludeRunnerIds);
      return [];
    },
    startedSteps: () => syncSteps(() => {}),
    finishedSteps: () => syncSteps(() => ({ retryable: true })),
  }));
  const workspace = f.db
    .query<{ id: string }, []>("SELECT workspace_id AS id FROM runner WHERE id='runner'")
    .get()!.id;
  const account = await createAgentAccount(sqliteDb(f.db), {
    workspaceId: workspace,
    agent: "codex",
    label: "A",
    now: Date.now(),
  });
  const binding = await bindAgentAccount(sqliteDb(f.db), {
    workspaceId: workspace,
    accountId: account.id,
    runnerId: "runner",
    now: Date.now(),
  });
  f.db.run(
    "INSERT INTO runner_host_status(runner_id,runner_version,reported_at) VALUES('runner','0.1.61',?)",
    [Date.now()],
  );
  await recordRunnerAccountCapability(
    sqliteDb(f.db),
    "runner",
    { protocol: 1, bindings: [{ bindingId: binding.id, agent: "codex" }] },
    Date.now(),
  );
  const named = { accountId: account.id, bindingId: binding.id };
  const out = await f.helpers.dispatch({
    runnerId: "runner",
    sessionId: "session",
    purpose: "classify",
    profile: { agent: "codex", model: null },
    prompt: f.input.prompt,
    account: named,
  });
  const retry = f.backend.forSession("session", "classify")(f.input);
  await Bun.sleep(10);
  await f.helpers.submit("runner", {
    ...helperResult(out.command.id),
    stopReason: "error",
    authRequired: true,
    agentExited: true,
    account: named,
  });
  await retry.catch(() => undefined);
  expect(excluded).toEqual([[binding.id]]);
});

test("a second attempt on one helper keeps it open until the last attempt finishes", async () => {
  const f = await fixture();
  const first = f.backend.forSession("session", "classify")(f.input);
  const command = await f.dispatched();
  const second = f.backend.forSession("session", "classify")(f.input);
  await Bun.sleep(10);
  expect(f.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runner_helper").get()!.n).toBe(1);
  await f.helpers.submit("runner", helperResult(command.id));
  expect((await first).stopReason).toBe("end_turn");
  expect((await second).stopReason).toBe("end_turn");
  await expect(f.helpers.current(command.id)).rejects.toThrow(/unavailable/);
});

test("held-back helpers journal one line per runner at most every five minutes", async () => {
  const f = await fixture();
  await linearSession(f, "waiting");
  const holdOnce = async () => {
    const out = await f.helpers.dispatch({
      runnerId: "runner",
      sessionId: "session",
      purpose: "classify",
      profile: { agent: "codex", model: null },
      prompt: "other work",
    });
    const controller = new AbortController();
    const waiting = f.backend.forSession(
      "waiting",
      "classify",
    )({ ...f.input, signal: controller.signal });
    await Bun.sleep(20);
    controller.abort();
    await waiting.catch(() => undefined);
    f.helpers.finish(out.command.id);
  };
  await holdOnce();
  expect(f.journaled).toHaveLength(1);
  expect(f.journaled[0]).toContain("runner runner");
  f.db.run("UPDATE runner SET last_seen_at=?", [f.advance(60_000)]);
  await holdOnce();
  expect(f.journaled).toHaveLength(1);
  f.db.run("UPDATE runner SET last_seen_at=?", [f.advance(5 * 60_000)]);
  await holdOnce();
  expect(f.journaled).toHaveLength(2);
});

test("a sign-in goes first: no new helper goes out while one waits", async () => {
  const f = await fixture();
  const dispatch = () =>
    f.helpers.dispatch({
      runnerId: "runner",
      sessionId: "session",
      purpose: "classify",
      profile: { agent: "codex", model: null },
      prompt: "work",
    });
  const owner = f.db
    .query<{ workspace: string; user: string }, []>(
      "SELECT workspace_id AS workspace,owner_user_id AS user FROM runner WHERE id='runner'",
    )
    .get()!;
  const expires = f.advance(0) + 300_000;
  f.db.run(
    "INSERT INTO runner_command(id,runner_id,kind,envelope,expires_at) VALUES('sign-in','runner','login','{}',?)",
    [expires],
  );
  f.db.run(
    "INSERT INTO runner_login(id,runner_id,workspace_id,user_id,agent,state,expires_at,updated_at) VALUES('sign-in','runner',?,?,'codex','waiting',?,?)",
    [owner.workspace, owner.user, expires, f.advance(0)],
  );
  await expect(dispatch()).rejects.toThrow(/busy/);
  f.db.run("UPDATE runner_login SET state='cancelled' WHERE id='sign-in'");
  expect((await dispatch()).command.purpose).toBe("classify");
});

const HELPER_LANE_BUSY = "Queued: the runner's helper lane is busy. Paws retries when it frees.";

/** The answer task's own placement over two runners: agentbox and goldbox, two slots each. */
async function answerTask() {
  const f = await fixture(async (db, now) => {
    db.run("UPDATE linear_session SET issue_id='issue',creator_id='owner'");
    db.run(
      "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) SELECT 'goldbox',workspace_id,owner_user_id,'goldbox','active',created_at,last_seen_at FROM runner WHERE id='runner'",
    );
    db.run("UPDATE runner SET name='agentbox' WHERE id='runner'");
    for (const runnerId of ["runner", "goldbox"])
      await recordRunnerCapacity(sqliteDb(db), runnerId, 2, 2, 2);
    return createRunnerPlacement({ store: sqliteDb(db), now });
  });
  const fill = async (runnerId: string) => {
    for (const id of [`${runnerId}-1`, `${runnerId}-2`]) {
      insertQueuedItem(f.db, { id, now: Date.now(), sessionKey: `${id}-session` });
      const { run } = await beginImplementRun(sqliteDb(f.db), id, Date.now());
      f.db.run(
        "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until) SELECT ?,id,workspace_id,1,0,?,? FROM runner WHERE id=?",
        [run.id, id, Date.now() + 3_600_000, runnerId],
      );
    }
  };
  return { ...f, fill, input: { ...f.input, profile: { agent: "claude" as const, model: null } } };
}

test("an answer task's helper goes to the idle runner while the other runner is full", async () => {
  const f = await answerTask();
  await f.fill("goldbox");
  expect(f.db.query("SELECT 1 FROM runner_helper WHERE ended_at IS NULL").get()).toBeNull();
  const pending = f.backend.forSession("session", "classify")(f.input);
  expect((await f.dispatched()).runnerId).toBe("runner");
  await f.reply();
  expect((await pending).stopReason).toBe("end_turn");
});

test("capacity-only rejections wait in the helper lane instead of failing", async () => {
  const f = await answerTask();
  await f.fill("runner");
  await f.fill("goldbox");
  const pending = f.backend
    .forSession(
      "session",
      "classify",
    )(f.input)
    .catch((error: unknown) => error);
  await Bun.sleep(20);
  f.db.run("UPDATE runner SET last_seen_at=last_seen_at+60000");
  f.advance(60_000);
  const error = await pending;
  expect(error).toBeInstanceOf(RunnerSlotsBusyError);
  expect((error as Error).message).toBe(HELPER_LANE_BUSY);
  expect(f.db.query("SELECT 1 FROM runner_helper").get()).toBeNull();
});

test("a helper no runner can take names each runner's reason", async () => {
  const f = await fixture((db) => ({
    async candidates(input) {
      db.run(
        "INSERT OR IGNORE INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) SELECT 'goldbox',workspace_id,owner_user_id,'goldbox','active',created_at,last_seen_at FROM runner WHERE id='runner'",
      );
      input.onRejected?.("runner", "agent-not-signed-in");
      input.onRejected?.("goldbox", "agent quota cooldown");
      input.onRejected?.("goldbox", "auth-expired");
      return [];
    },
    startedSteps: () =>
      syncSteps(() => {
        throw new Error("Must not dispatch");
      }),
    finishedSteps: () =>
      syncSteps(() => {
        return { retryable: false };
      }),
  }));
  const error = await f.backend
    .forSession(
      "session",
      "classify",
    )(f.input)
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(UserFacingError);
  expect((error as Error).message).toBe(
    "No paired runner can run codex for this issue right now: Fixture: agent not signed in; goldbox: agent quota cooldown, auth expired. Check runner availability and usage limits, then retry.",
  );
});

test("a dispatch the runner refuses is named in the failure", async () => {
  const f = await fixture((db) => ({
    async candidates() {
      return [
        {
          id: "runner",
          workspaceId: db.query<{ id: string }, []>("SELECT id FROM workspace").get()!.id,
        },
      ];
    },
    startedSteps: () =>
      syncSteps(() => {
        throw new Error("Runner selection authority changed before assignment");
      }),
    finishedSteps: () =>
      syncSteps(() => {
        return { retryable: false };
      }),
  }));
  await expect(f.backend.forSession("session", "classify")(f.input)).rejects.toThrow(
    "right now: Fixture: Runner selection authority changed before assignment.",
  );
});
