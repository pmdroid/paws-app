import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRetro,
  getRetro,
  listRetroAttempts,
  listRetroDispatches,
  listRetroItems,
  migrate,
  openDatabase,
  retroWatermarks,
  runnerOccupancy,
  saveRetroSettingsRevision,
} from "../db";
import {
  signRunnerRetroCommand,
  verifyRunnerRetroCommand,
  type RunnerRetroCommand,
} from "../runner-protocol";
import { collectRetroDigest, createRetroDispatcher, retroRetryDelayMs } from "./index";
import { FIXTURE_END, FIXTURE_REPO, FIXTURE_START, fixturePattern } from "./result.fixtures";

const keys = generateKeyPairSync("ed25519");
const trustedKeys = new Map([["k1", keys.publicKey]]);
const sign = (command: RunnerRetroCommand) =>
  signRunnerRetroCommand({ keyId: "k1", privateKey: keys.privateKey, command });
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const EXECUTION_ID = "01JAAAAAAAAAAAAAAAAAAAAAAA";
const VALID_OUTPUT = JSON.stringify({ patterns: [fixturePattern()], workedWell: [] });

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function seedActivity(db: Database, identifier: string, answers: number) {
  const id = `item-${identifier}`;
  db.run(
    `INSERT INTO linear_session (session_id, issue_id, organization_id, team_id, created_at)
     VALUES (?, ?, 'org', 'team', 0)`,
    [`session-${identifier}`, `issue-${identifier}`],
  );
  db.run(
    `INSERT INTO work_item (id, delegation_id, linear_issue_id, linear_identifier, title, state,
       branch_name, position, created_at, session_key)
     VALUES (?, ?, ?, ?, ?, 'running', ?, 0, ?, ?)`,
    [
      id,
      `delegation-${identifier}`,
      `issue-${identifier}`,
      identifier,
      `Work on ${identifier}`,
      `paws/${identifier}`,
      FIXTURE_START,
      `session-${identifier}`,
    ],
  );
  const [owner, repo] = FIXTURE_REPO.split("/");
  db.run("INSERT INTO work_item_repository VALUES (?, ?, ?, 'git@x')", [id, owner!, repo!]);
  for (let n = 0; n < answers; n += 1)
    db.run(
      `INSERT INTO question (id, item_id, session_id, kind, reason, body, status, answer, answered_by,
         created_at, answered_at) VALUES (?, ?, 's', 'agent', 'push_rejected', 'How do I recover?',
         'answered', 'Fetch and rebase.', 'someone', ?, ?)`,
      [`q-${identifier}-${n}`, id, FIXTURE_START + n, FIXTURE_START + n + 1],
    );
}

function addRunner(
  db: Database,
  input: { id: string; owner?: string; version?: string; capacity?: number; ready?: boolean },
) {
  db.run(
    "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES(?,'ws',?,?,'active',0,0)",
    [input.id, input.owner ?? "admin", input.id],
  );
  db.run("INSERT INTO runner_host_status(runner_id,runner_version,reported_at) VALUES(?,?,0)", [
    input.id,
    input.version ?? "0.1.63",
  ]);
  db.run("INSERT INTO runner_agent_policy(runner_id,agent,ready) VALUES(?,'codex',?)", [
    input.id,
    input.ready === false ? 0 : 1,
  ]);
  db.run("INSERT INTO runner_capacity(runner_id,capacity) VALUES(?,?)", [
    input.id,
    input.capacity ?? 1,
  ]);
}

function world(options: { activity?: boolean; retries?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "paws-retro-dispatch-"));
  roots.push(root);
  const path = join(root, "paws.db");
  const db = openDatabase(path);
  migrate(db);
  db.run("INSERT INTO workspace VALUES ('ws', 'org', 'ws', 0)");
  db.run("INSERT INTO workspace_repository VALUES ('ws', ?, 'team')", [FIXTURE_REPO]);
  for (const [id, role] of [
    ["admin", "admin"],
    ["member", "member"],
  ]) {
    db.run("INSERT INTO workspace_user(id,linear_user_id,name,email) VALUES(?,?,?,?)", [
      id!,
      `linear-${id}`,
      id!,
      `${id}@example.test`,
    ]);
    db.run(
      "INSERT INTO workspace_member(workspace_id,user_id,role,source,active,checked_at) VALUES('ws',?,?,'manual',1,0)",
      [id!, role!],
    );
  }
  if (options.activity !== false) {
    seedActivity(db, "PAS-817", 4);
    seedActivity(db, "PAS-843", 5);
  }
  const { revision } = saveRetroSettingsRevision(db, {
    workspaceId: "ws",
    prompt: "Review {{period}} in {{repositories}}.\n\n{{digest}}",
    agentProfile: { agent: "codex", model: "gpt-x", effort: null },
    repositories: [FIXTURE_REPO],
    outputLimits: { maxItems: 5, workedWell: 3 },
    executionLimits: { activeMinutes: 15, retries: options.retries ?? 1 },
    schedule: {},
    createdBy: "admin",
    now: 1,
  });
  createRetro(db, {
    id: "r1",
    workspaceId: "ws",
    windowStart: FIXTURE_START,
    windowEnd: FIXTURE_END,
    origin: "manual",
    settingsRevision: revision,
    agentProfile: { agent: "codex", model: "gpt-x", effort: null },
    now: FIXTURE_END,
  });
  const collected = collectRetroDigest(db, { retroId: "r1", artifactRoot: root, now: FIXTURE_END });
  if (!collected.ok) throw new Error(collected.reason);
  const clock = { now: FIXTURE_END + 10_000 };
  const open = (database: Database) =>
    createRetroDispatcher({ db: database, artifactRoot: root, sign, now: () => clock.now });
  return { db, root, path, clock, open, digestSha256: collected.digestSha256 };
}

type Dispatcher = ReturnType<typeof createRetroDispatcher>;

async function call(dispatcher: Dispatcher, runnerId: string, path: string, body?: unknown) {
  const request =
    body === undefined
      ? new Request(`https://runner.test${path}`)
      : new Request(`https://runner.test${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
  const response = await dispatcher.fetch(request, runnerId);
  if (response === null) throw new Error(`unrouted ${path}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function fakeRunner(runnerId: string, clock: { now: number }) {
  const claimed = new Set<string>();
  const runner = {
    seen(db: Database) {
      db.run("UPDATE runner SET last_seen_at=? WHERE id=?", [clock.now, runnerId]);
    },
    async poll(dispatcher: Dispatcher): Promise<RunnerRetroCommand[]> {
      const listed = await call(dispatcher, runnerId, "/v1/retro-commands");
      const commands: RunnerRetroCommand[] = [];
      for (const envelope of listed.body.commands as unknown[]) {
        const verified = verifyRunnerRetroCommand(envelope, {
          trustedKeys,
          runnerId,
          workspaceId: "ws",
          now: clock.now,
          latestAttempt: () => undefined,
          claimCommand: (id) => !claimed.has(id) && Boolean(claimed.add(id)),
        });
        if (verified.ok) commands.push(verified.command);
      }
      return commands;
    },
    async start(dispatcher: Dispatcher, command: RunnerRetroCommand) {
      const ack = await call(dispatcher, runnerId, `/v1/retro-commands/${command.id}/ack`, {});
      expect(ack.status).toBe(200);
      const inputs: Record<string, string> = {};
      for (const kind of ["digest", "prompt"] as const) {
        const descriptor = command[kind];
        let text = "";
        for (let offset = 0; offset < descriptor.sizeBytes; offset += 524288) {
          const chunk = await call(dispatcher, runnerId, `/v1/retro-commands/${command.id}/input`, {
            commandId: command.id,
            workspaceId: command.workspaceId,
            retroId: command.retroId,
            attempt: command.attempt,
            kind,
            sha256: descriptor.sha256,
            offset,
            length: Math.min(524288, descriptor.sizeBytes - offset),
          });
          expect(chunk.status).toBe(200);
          text += Buffer.from(chunk.body.data as string, "base64").toString("utf8");
        }
        expect(sha256(text)).toBe(descriptor.sha256);
        inputs[kind] = text;
      }
      return inputs;
    },
    result(command: RunnerRetroCommand, output: string | null, outcome = "completed") {
      return {
        executionId: EXECUTION_ID,
        commandId: command.id,
        type: "retro",
        capability: 1,
        runnerId,
        workspaceId: command.workspaceId,
        retroId: command.retroId,
        attempt: command.attempt,
        settingsRevision: command.settingsRevision,
        digestSha256: command.digest.sha256,
        promptSha256: command.prompt.sha256,
        outcome,
        activeMs: 42_000,
        ...(output === null
          ? { errorMessage: "The agent stopped." }
          : { output, outputSha256: sha256(output) }),
      };
    },
    submit(dispatcher: Dispatcher, command: RunnerRetroCommand, body: unknown) {
      return call(dispatcher, runnerId, `/v1/retro-commands/${command.id}/result`, body);
    },
  };
  return runner;
}

function occupyWithHelper(db: Database, runnerId: string, until: number) {
  db.run(
    `INSERT INTO runner_helper(id,runner_id,workspace_id,session_id,session_generation,runner_fence,
       envelope,expires_at) VALUES('helper-1',?,'ws','session-PAS-817',0,0,'{}',?)`,
    [runnerId, until],
  );
}

describe("retro dispatch, composed with a fake runner", () => {
  test("waits for capacity, dispatches once, survives a restart and publishes one report despite a duplicate", async () => {
    const { db, path, clock, open, digestSha256 } = world();
    addRunner(db, { id: "R1" });
    const runner = fakeRunner("R1", clock);
    runner.seen(db);
    occupyWithHelper(db, "R1", clock.now + 600_000);
    let dispatcher = open(db);

    dispatcher.tick();
    expect(dispatcher.generation("r1")).toMatchObject({
      state: "waiting_for_runner",
      diagnostic: "capacity_wait",
      attempt: 0,
      attemptsUsed: 0,
      digestSha256,
    });
    expect(await runner.poll(dispatcher)).toEqual([]);
    clock.now += 60_000;
    runner.seen(db);
    dispatcher.tick();
    expect(dispatcher.generation("r1")).toMatchObject({ state: "waiting_for_runner", attempt: 0 });
    expect(dispatcher.generation("r1")!.waitMs).toBe(60_000);

    db.run("UPDATE runner_helper SET ended_at=? WHERE id='helper-1'", [clock.now]);
    dispatcher.tick();
    const [dispatch] = listRetroDispatches(db, "r1");
    expect(dispatch).toMatchObject({ runnerId: "R1", attempt: 1, fetchedAt: null });
    expect(getRetro(db, "r1")).toMatchObject({ state: "generating", attempt: 1 });
    expect(dispatcher.generation("r1")).toMatchObject({
      state: "generating",
      diagnostic: "dispatched",
      runnerId: "R1",
      commandId: dispatch!.commandId,
      attemptsUsed: 1,
    });
    expect(runnerOccupancy(db, "R1", clock.now).occupied).toBe(1);

    const [command] = await runner.poll(dispatcher);
    expect(command).toMatchObject({
      id: dispatch!.commandId,
      attempt: 1,
      profile: { agent: "codex", model: "gpt-x" },
      executionLimit: { activeMinutes: 15 },
      output: { maxItems: 5, workedWell: 3 },
      digest: { sha256: digestSha256 },
    });
    const inputs = await runner.start(dispatcher, command!);
    expect(inputs.prompt).toContain(`in ${FIXTURE_REPO}.\n\n<session_digest>`);

    clock.now += 120_000;
    db.close();
    const reopened = openDatabase(path);
    dispatcher = open(reopened);
    runner.seen(reopened);
    dispatcher.tick();
    dispatcher.tick();
    expect(listRetroDispatches(reopened, "r1")).toHaveLength(1);
    expect(getRetro(reopened, "r1")).toMatchObject({ state: "generating", attempt: 1 });
    expect(dispatcher.generation("r1")).toMatchObject({
      state: "generating",
      diagnostic: "active",
    });
    expect(await runner.poll(dispatcher)).toEqual([]);

    const body = runner.result(command!, VALID_OUTPUT);
    expect(await runner.submit(dispatcher, command!, body)).toEqual({
      status: 200,
      body: { duplicate: false },
    });
    expect(await runner.submit(dispatcher, command!, body)).toEqual({
      status: 200,
      body: { duplicate: true },
    });
    const other = runner.result(command!, JSON.stringify({ patterns: [], workedWell: [] }));
    expect((await runner.submit(dispatcher, command!, other)).status).toBe(409);
    dispatcher.tick();

    const retro = getRetro(reopened, "r1")!;
    expect(retro.state).toBe("published");
    expect((retro.result as { items: unknown[] }).items).toHaveLength(1);
    expect(listRetroItems(reopened, "r1")).toHaveLength(1);
    expect(listRetroAttempts(reopened, "r1").map((entry) => entry.outcome)).toEqual(["succeeded"]);
    expect(retroWatermarks(reopened, "ws")).toEqual([
      { repository: FIXTURE_REPO, cursor: FIXTURE_END, retroId: "r1", updatedAt: clock.now },
    ]);
    expect(dispatcher.generation("r1")).toMatchObject({
      state: "ready",
      diagnostic: "ready",
      activeMs: 42_000,
      waitMs: 60_000,
    });
    expect(runnerOccupancy(reopened, "R1", clock.now).occupied).toBe(0);
    reopened.close();
  });
});

describe("placement", () => {
  test("only an online admin runner with retro support and the agent signed in receives it", async () => {
    const { db, clock, open } = world();
    addRunner(db, { id: "OLD", version: "0.1.62" });
    addRunner(db, { id: "MEMBER", owner: "member" });
    addRunner(db, { id: "SIGNED_OUT", ready: false });
    db.run("UPDATE runner SET last_seen_at=?", [clock.now]);
    const dispatcher = open(db);
    dispatcher.tick();
    expect(dispatcher.generation("r1")).toMatchObject({
      state: "waiting_for_runner",
      diagnostic: "no_runner",
      attempt: 0,
    });
    expect(dispatcher.generation("r1")!.detail).toContain("1 need a runner update");
    for (const id of ["OLD", "MEMBER", "SIGNED_OUT"])
      expect(await fakeRunner(id, clock).poll(dispatcher)).toEqual([]);
    expect(listRetroDispatches(db, "r1")).toEqual([]);
  });

  test("a quota cooldown on the selected agent is a wait that spends no attempt", () => {
    const { db, clock, open } = world();
    addRunner(db, { id: "R1" });
    db.run("UPDATE runner SET last_seen_at=?", [clock.now]);
    db.run("UPDATE runner_agent_policy SET quota_state='exhausted', cooldown_until=?", [
      clock.now + 900_000,
    ]);
    const dispatcher = open(db);
    dispatcher.tick();
    expect(dispatcher.generation("r1")).toMatchObject({
      state: "waiting_for_runner",
      diagnostic: "quota_cooldown",
      until: clock.now + 900_000,
      attempt: 0,
    });
    clock.now += 900_001;
    db.run("UPDATE runner SET last_seen_at=?", [clock.now]);
    dispatcher.tick();
    expect(dispatcher.generation("r1")).toMatchObject({ state: "generating", attempt: 1 });
  });

  test("a dispatched retro holds a shared slot that implementation work also counts", () => {
    const { db, clock, open } = world();
    addRunner(db, { id: "R1", capacity: 2 });
    db.run("UPDATE runner SET last_seen_at=?", [clock.now]);
    open(db).tick();
    expect(runnerOccupancy(db, "R1", clock.now)).toEqual({ capacity: 2, occupied: 1 });
  });

  test("an empty window publishes an empty report without a runner", () => {
    const { db, open } = world({ activity: false });
    const dispatcher = open(db);
    dispatcher.tick();
    expect(getRetro(db, "r1")!.state).toBe("published");
    expect(listRetroDispatches(db, "r1")).toEqual([]);
    expect(dispatcher.generation("r1")!.state).toBe("ready");
  });
});

describe("recovery", () => {
  test("a turn past its limit is an unknown outcome: the slot stays and no second turn starts", async () => {
    const { db, clock, open } = world();
    addRunner(db, { id: "R1", capacity: 2 });
    const runner = fakeRunner("R1", clock);
    runner.seen(db);
    const dispatcher = open(db);
    dispatcher.tick();
    const [command] = await runner.poll(dispatcher);
    await runner.start(dispatcher, command!);
    clock.now += 15 * 60_000 + 300_001;
    runner.seen(db);
    dispatcher.tick();
    dispatcher.tick();
    expect(dispatcher.generation("r1")).toMatchObject({
      state: "generating",
      diagnostic: "unknown_outcome",
      attempt: 1,
    });
    expect(listRetroDispatches(db, "r1")).toHaveLength(1);
    expect(runnerOccupancy(db, "R1", clock.now).occupied).toBe(1);

    expect(
      (
        await call(dispatcher, "R1", `/v1/retro-commands/${command!.id}/released`, {
          reason: "teardown",
        })
      ).status,
    ).toBe(200);
    expect(runnerOccupancy(db, "R1", clock.now).occupied).toBe(0);
    expect(dispatcher.generation("r1")).toMatchObject({
      state: "failed",
      diagnostic: "retry_backoff",
      attemptsUsed: 1,
    });
    expect(getRetro(db, "r1")!.error).toContain("without a result");
  });

  test("invalid output keeps the digest and retries the same snapshot with backoff until spent", async () => {
    const { db, clock, open, digestSha256 } = world({ retries: 1 });
    addRunner(db, { id: "R1" });
    const runner = fakeRunner("R1", clock);
    runner.seen(db);
    const dispatcher = open(db);
    dispatcher.tick();
    const [first] = await runner.poll(dispatcher);
    await runner.start(dispatcher, first!);
    await runner.submit(dispatcher, first!, runner.result(first!, '{"not":"a retro"}'));
    const failed = dispatcher.generation("r1")!;
    expect(failed).toMatchObject({
      state: "failed",
      diagnostic: "retry_backoff",
      digestSha256,
      attemptsUsed: 1,
      maxAttempts: 2,
    });
    expect(failed.retry!.at).toBe(clock.now + retroRetryDelayMs(1));
    expect(getRetro(db, "r1")!.error).toContain(`against digest ${digestSha256.slice(0, 12)}`);

    dispatcher.tick();
    expect(listRetroDispatches(db, "r1")).toHaveLength(1);
    clock.now += retroRetryDelayMs(1);
    runner.seen(db);
    dispatcher.tick();
    const [second] = await runner.poll(dispatcher);
    expect(second).toMatchObject({
      attempt: 2,
      digest: first!.digest,
      prompt: first!.prompt,
      settingsRevision: first!.settingsRevision,
    });
    await runner.start(dispatcher, second!);
    expect(
      (await runner.submit(dispatcher, first!, runner.result(first!, VALID_OUTPUT))).status,
    ).toBe(409);
    await runner.submit(dispatcher, second!, runner.result(second!, null, "error"));
    expect(dispatcher.generation("r1")).toMatchObject({
      state: "failed",
      diagnostic: "failed",
      retry: null,
      attemptsUsed: 2,
    });
    clock.now += 86_400_000;
    runner.seen(db);
    dispatcher.tick();
    expect(listRetroDispatches(db, "r1")).toHaveLength(2);
  });

  test("an unfetched command is re-signed under the same id; a lost fetch costs no attempt", async () => {
    const { db, clock, open } = world({ retries: 0 });
    addRunner(db, { id: "R1" });
    const runner = fakeRunner("R1", clock);
    runner.seen(db);
    const dispatcher = open(db);
    dispatcher.tick();
    const [dispatch] = listRetroDispatches(db, "r1");
    clock.now += 290_000;
    runner.seen(db);
    const [resent] = await runner.poll(dispatcher);
    expect(resent!.id).toBe(dispatch!.commandId);
    expect(listRetroDispatches(db, "r1")[0]!.deliveries).toBe(2);

    clock.now += 300_000 + 60_001;
    runner.seen(db);
    dispatcher.tick();
    expect(listRetroDispatches(db, "r1")[0]).toMatchObject({ releaseReason: "not_started" });
    dispatcher.tick();
    const dispatches = listRetroDispatches(db, "r1");
    expect(dispatches).toHaveLength(2);
    expect(dispatcher.generation("r1")).toMatchObject({
      state: "generating",
      attempt: 2,
      attemptsUsed: 1,
      maxAttempts: 1,
    });
  });

  test("a revoked runner fences the attempt; its late result is refused", async () => {
    const { db, clock, open } = world();
    addRunner(db, { id: "R1" });
    const runner = fakeRunner("R1", clock);
    runner.seen(db);
    const dispatcher = open(db);
    dispatcher.tick();
    const [command] = await runner.poll(dispatcher);
    await runner.start(dispatcher, command!);
    db.run("UPDATE runner SET status='revoked', revoked_at=? WHERE id='R1'", [clock.now]);
    dispatcher.tick();
    expect(getRetro(db, "r1")!.error).toContain("outcome is unknown");
    expect(
      (await runner.submit(dispatcher, command!, runner.result(command!, VALID_OUTPUT))).status,
    ).toBe(409);
    expect(getRetro(db, "r1")!.state).toBe("failed");
  });
});
