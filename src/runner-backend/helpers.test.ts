import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  advanceLinearSessionGeneration,
  beginImplementRun,
  consumeWorkspaceBootstrap,
  insertQueuedItem,
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordLinearInstallation,
} from "../db";
import { RunnerSlotsBusyError } from "../core";
import { DEFAULT_RUN_TIMEOUT_MS, recoverAcpConversation, type RunAgentOptions } from "../acp";
import { createRunnerHelpers } from "../runner-helpers";
import { workspaceId, workspaceTokenHash, issueWorkspaceBootstrap } from "../workspace";
import { createRemoteSessionAgentRunner } from "./helpers";
import { RetryableRunnerError, runWithFailover } from "./failover";
import { quotaSignal, type RunnerPlacement } from "../runner-placement";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

function fixture(
  placement?: (db: ReturnType<typeof openDatabase>, now: () => number) => RunnerPlacement,
) {
  const root = mkdtempSync(join(tmpdir(), "paws-helper-backend-"));
  const db = openDatabase(join(root, "paws.db"));
  migrate(db);
  let now = Date.now();
  const userId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const workspace = consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "org",
    name: "Fixture",
    userId,
    tokenHash: workspaceTokenHash(issueWorkspaceBootstrap(db, "org", now)),
    now,
  });
  db.run(
    "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES(?,?,?,'Fixture','active',?,?)",
    ["runner", workspace.id, userId, now, now],
  );
  recordLinearInstallation(db, {
    organizationId: "org",
    oauthClientId: "app",
    appUserId: "app-user",
    sessionId: "session",
    teamId: "team",
    observedAtMs: now,
  });
  const helpers = createRunnerHelpers({
    db,
    keyId: "fixture",
    privateKey: generateKeyPairSync("ed25519").privateKey,
    now: () => now,
  });
  const backend = createRemoteSessionAgentRunner({
    db,
    helpers,
    now: () => now,
    pollIntervalMs: 1,
    placement: placement?.(db, () => now),
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
  function current() {
    const row = db
      .query<{ id: string }, []>("SELECT id FROM runner_helper ORDER BY rowid DESC")
      .get();
    if (!row) throw new Error("Expected dispatched helper");
    return helpers.current(row.id).command;
  }
  function reply(text = '{"mode":"answer"}') {
    helpers.submit(current().runnerId, {
      executionId: "01J00000000000000000000000",
      commandId: current().id,
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
  return { db, backend, input, helpers, current, reply, advance: (ms: number) => (now += ms) };
}

test.each(["classify", "select_repository"] as const)(
  "session backend dispatches %s before item/repository selection and restores its result",
  async (purpose) => {
    const f = fixture();
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
    expect(f.current().purpose).toBe(purpose);
    expect(f.current().prompt).toBe(f.input.prompt);
    expect(f.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM work_item").get()!.n).toBe(0);
    f.reply();
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
  const f = fixture();
  const pending = f.backend.forSession("session", "classify")(f.input);
  advanceLinearSessionGeneration(f.db, "session");
  await expect(pending).rejects.toThrow(/authority changed/);
  expect(
    f.db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runner_helper WHERE ended_at IS NULL")
      .get()!.n,
  ).toBe(0);
});

test("cancelling a helper fences later output without invoking a local agent", async () => {
  const f = fixture();
  const controller = new AbortController();
  const pending = f.backend.forSession(
    "session",
    "classify",
  )({ ...f.input, signal: controller.signal });
  const command = f.current();
  controller.abort();
  await expect(pending).rejects.toThrow();
  expect(() => f.helpers.current(command.id)).toThrow(/unavailable/);
});

test("a replacement during the event callback cannot return stale classification", async () => {
  const f = fixture();
  let events = 0;
  const pending = f.backend.forSession(
    "session",
    "classify",
  )({
    ...f.input,
    async onEvent() {
      events++;
      advanceLinearSessionGeneration(f.db, "session");
    },
  });
  f.reply();
  await expect(pending).rejects.toThrow(/authority changed/);
  expect(events).toBe(1);
});

test("no active runner fails closed and a deadline cannot retain capacity", async () => {
  const f = fixture();
  f.db.run("UPDATE runner SET status='paused'");
  await expect(f.backend.forSession("session", "classify")(f.input)).rejects.toThrow(
    /No paired runner can run/,
  );
  f.db.run("UPDATE runner SET status='active'");
  const pending = f.backend.forSession("session", "classify")(f.input);
  f.advance(60_000);
  await expect(pending).rejects.toThrow(/timed out/);
  expect(
    f.db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runner_helper WHERE ended_at IS NULL")
      .get()!.n,
  ).toBe(0);
});

function fillRunner(f: ReturnType<typeof fixture>) {
  insertQueuedItem(f.db, { id: "busy", now: Date.now(), sessionKey: "busy-session" });
  const { run } = beginImplementRun(f.db, "busy", Date.now());
  f.db.run(
    "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until) SELECT ?,id,workspace_id,1,0,'busy',? FROM runner WHERE id='runner'",
    [run.id, Date.now() + 3_600_000],
  );
}

test("a helper waits while task work fills the runner and starts once a slot frees", async () => {
  const f = fixture();
  fillRunner(f);
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
  expect(f.current().runnerId).toBe("runner");
  f.advance(60_000);
  await expect(pending).rejects.toThrow(/timed out/);
});

test("a helper still blocked by task work at its deadline reports the runner slots as busy", async () => {
  const f = fixture();
  fillRunner(f);
  const pending = f.backend.forSession("session", "classify")(f.input);
  await Bun.sleep(10);
  f.advance(60_000);
  await expect(pending).rejects.toBeInstanceOf(RunnerSlotsBusyError);
});

test("session helpers reject executable-work and file/tool contracts before dispatch", async () => {
  const f = fixture();
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
  const f = fixture((db, now) => ({
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
    started(input) {
      expect(db.inTransaction).toBe(true);
      expect(input.runnerId).toBe("selected");
      expect(
        db.query("SELECT 1 FROM runner_helper WHERE id=?").get(input.commandId),
      ).not.toBeNull();
      calls.push("started");
    },
    finished(input) {
      expect(db.inTransaction).toBe(true);
      expect(input.result?.agentExited).toBe(true);
      calls.push("finished");
      return { retryable: false };
    },
  }));
  const pending = f.backend.forSession("session", "classify")(f.input);
  for (let attempt = 0; attempt < 1000 && calls.length < 2; attempt++) await Bun.sleep(1);
  expect(calls.length).toBe(2);
  expect(f.current().runnerId).toBe("selected");
  f.reply();
  await pending;
  expect(calls).toEqual(["candidates", "started", "finished"]);
});

test("Rejected placement admission rolls back the signed helper command", async () => {
  const f = fixture((db) => ({
    async candidates() {
      return [
        {
          id: "runner",
          workspaceId: db.query<{ id: string }, []>("SELECT id FROM workspace").get()!.id,
        },
      ];
    },
    started() {
      throw new Error("Shared host authorization changed");
    },
    finished() {
      return { retryable: false };
    },
  }));
  await expect(f.backend.forSession("session", "classify")(f.input)).rejects.toThrow(
    /No paired runner can run/,
  );
  expect(f.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runner_helper").get()!.n).toBe(0);
});

test("An empty placement decision cannot fall back to another paired host", async () => {
  const f = fixture(() => ({
    async candidates() {
      return [];
    },
    started() {
      throw new Error("Must not dispatch");
    },
    finished() {
      return { retryable: false };
    },
  }));
  await expect(f.backend.forSession("session", "classify")(f.input)).rejects.toThrow(
    /No paired runner can run/,
  );
  expect(f.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runner_helper").get()!.n).toBe(0);
});

test("Three real helper assignments fail over after expired authentication and observed quota", async () => {
  const attempts: string[] = [];
  const f = fixture((db, now) => ({
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
    started(request) {
      expect(db.inTransaction).toBe(true);
      attempts.push(request.runnerId);
    },
    finished(observation) {
      return {
        retryable:
          Boolean(observation.result?.authRequired) ||
          quotaSignal(observation.result?.errorMessage ?? "", now())?.state === "exhausted",
      };
    },
  }));
  const pending = f.backend.forSession("session", "classify")(f.input);
  const waitAttempt = async (count: number) => {
    for (let index = 0; index < 1000 && attempts.length < count; index++) await Bun.sleep(1);
    expect(attempts.length).toBe(count);
    return f.current();
  };
  const first = await waitAttempt(1);
  const submit = (
    command: ReturnType<typeof f.current>,
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
  submit(first, true, "Agent login expired");
  const second = await waitAttempt(2);
  expect(second.id).not.toBe(first.id);
  expect(second.prompt).toContain("fresh agent session");
  expect(
    f.db
      .query<{ ended: number }, [string]>("SELECT ended_at AS ended FROM runner_helper WHERE id=?")
      .get(first.id)!.ended,
  ).toBeGreaterThan(0);
  submit(second, false, "You've hit your session limit. Retry-After: 120");
  const third = await waitAttempt(3);
  expect(third.id).not.toBe(second.id);
  f.reply();
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
      ...fixture().input,
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
  const { timeoutMs, ...input } = fixture().input;
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
  const f = fixture();
  const helperCount = () =>
    f.db.query<{ n: number }, []>("SELECT count(*) AS n FROM runner_helper").get()!.n;
  const first = f.backend.forSession("session", "classify")(f.input);
  while (helperCount() < 1) await Bun.sleep(1);
  const second = f.backend.forSession("session", "select_repository")(f.input);
  await Bun.sleep(20);
  expect(helperCount()).toBe(1);
  f.reply();
  await first;
  while (helperCount() < 2) await Bun.sleep(1);
  f.reply();
  expect((await second).stopReason).toBe("end_turn");
});
