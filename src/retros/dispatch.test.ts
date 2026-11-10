import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import {
  accountSlotsInUse,
  beginRetroCollection,
  closeRetro,
  createRetro,
  freezeRetroInput,
  ensureLegacyAgentBinding,
  getRetro,
  getRetroDispatch,
  legacyAgentAccountId,
  listRetroAttempts,
  listRetroDispatches,
  listRetroItems,
  openDatabase,
  readRetroArtifact,
  recordAccountObservation,
  retroSlotsHeld,
  retroWatermarks,
  runnerOccupancy,
  writeRetroArtifact,
  sqliteDb,
} from "../db";
import { verifyRunnerRetroCommand, type RunnerRetroCommand } from "../runner-protocol";
import { createRetroDispatcher, retroRetryDelayMs } from "./index";
import { addRunner, trustedKeys, world as fixtureWorld } from "./dispatch.fixtures";
import { FIXTURE_END, FIXTURE_REPO, FIXTURE_START, fixturePattern } from "./result.fixtures";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const EXECUTION_ID = "01JAAAAAAAAAAAAAAAAAAAAAAA";
const VALID_OUTPUT = JSON.stringify({ patterns: [fixturePattern()], workedWell: [] });

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function world(options: { activity?: boolean; retries?: number } = {}) {
  const created = fixtureWorld(options);
  roots.push(created.root);
  return created;
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

    await dispatcher.tick();
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
    await dispatcher.tick();
    expect(dispatcher.generation("r1")).toMatchObject({ state: "waiting_for_runner", attempt: 0 });
    expect(dispatcher.generation("r1")!.waitMs).toBe(60_000);

    db.run("UPDATE runner_helper SET ended_at=? WHERE id='helper-1'", [clock.now]);
    await dispatcher.tick();
    const [dispatch] = await listRetroDispatches(sqliteDb(db), "r1");
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
    await dispatcher.tick();
    await dispatcher.tick();
    expect(await listRetroDispatches(sqliteDb(reopened), "r1")).toHaveLength(1);
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
    await dispatcher.tick();

    const retro = getRetro(reopened, "r1")!;
    expect(retro.state).toBe("published");
    expect((retro.result as { items: unknown[] }).items).toHaveLength(1);
    expect(listRetroItems(reopened, "r1")).toHaveLength(1);
    expect(
      (await listRetroAttempts(sqliteDb(reopened), "r1")).map((entry) => entry.outcome),
    ).toEqual(["succeeded"]);
    expect(await retroWatermarks(sqliteDb(reopened), "ws")).toEqual([
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
    await dispatcher.tick();
    expect(dispatcher.generation("r1")).toMatchObject({
      state: "waiting_for_runner",
      diagnostic: "no_runner",
      attempt: 0,
    });
    expect(dispatcher.generation("r1")!.detail).toContain("1 need a runner update");
    for (const id of ["OLD", "MEMBER", "SIGNED_OUT"])
      expect(await fakeRunner(id, clock).poll(dispatcher)).toEqual([]);
    expect(await listRetroDispatches(sqliteDb(db), "r1")).toEqual([]);
  });

  test("a quota cooldown on the selected agent is a wait that spends no attempt", async () => {
    const { db, clock, open } = world();
    addRunner(db, { id: "R1" });
    db.run("UPDATE runner SET last_seen_at=?", [clock.now]);
    db.run("UPDATE runner_agent_policy SET quota_state='exhausted', cooldown_until=?", [
      clock.now + 900_000,
    ]);
    const dispatcher = open(db);
    await dispatcher.tick();
    expect(dispatcher.generation("r1")).toMatchObject({
      state: "waiting_for_runner",
      diagnostic: "quota_cooldown",
      until: clock.now + 900_000,
      attempt: 0,
    });
    clock.now += 900_001;
    db.run("UPDATE runner SET last_seen_at=?", [clock.now]);
    await dispatcher.tick();
    expect(dispatcher.generation("r1")).toMatchObject({ state: "generating", attempt: 1 });
  });

  test("a dispatched retro holds a shared slot that implementation work also counts", async () => {
    const { db, clock, open } = world();
    addRunner(db, { id: "R1", capacity: 2 });
    db.run("UPDATE runner SET last_seen_at=?", [clock.now]);
    await open(db).tick();
    expect(runnerOccupancy(db, "R1", clock.now)).toEqual({ capacity: 2, occupied: 1 });
  });

  test("an empty window publishes an empty report without a runner", async () => {
    const { db, open } = world({ activity: false });
    const dispatcher = open(db);
    await dispatcher.tick();
    expect(getRetro(db, "r1")!.state).toBe("published");
    expect(await listRetroDispatches(sqliteDb(db), "r1")).toEqual([]);
    expect(dispatcher.generation("r1")!.state).toBe("ready");
  });

  test("a digest over the runner limit abandons the retro and names its size and the limit", async () => {
    const { db, root, clock, open } = world();
    const first = getRetro(db, "r1")!;
    const read = (kind: "digest" | "manifest") => {
      const stored = readRetroArtifact(db, root, "r1", kind);
      if (!stored.ok) throw new Error(stored.reason);
      return Buffer.from(stored.bytes);
    };
    const digest = read("digest");
    const manifest = read("manifest");
    await closeRetro(sqliteDb(db), {
      retroId: "r1",
      state: "abandoned",
      error: "replaced",
      now: clock.now,
    });
    db.run("DELETE FROM retro_collection_lock WHERE retro_id = 'r1'");
    createRetro(db, {
      id: "r2",
      workspaceId: "ws",
      windowStart: FIXTURE_START,
      windowEnd: FIXTURE_END + 1,
      origin: "manual",
      settingsRevision: first.settingsRevision,
      agentProfile: first.agentProfile,
      now: clock.now,
    });
    expect(beginRetroCollection(db, { retroId: "r2", now: clock.now }).ok).toBe(true);
    const padded = Buffer.concat([digest, Buffer.alloc(8_718_484 - digest.length, " ")]);
    for (const [kind, bytes] of [
      ["digest", padded],
      ["manifest", manifest],
    ] as const)
      writeRetroArtifact(db, root, { retroId: "r2", kind, bytes, now: clock.now });
    freezeRetroInput(db, {
      retroId: "r2",
      endCursors: { [FIXTURE_REPO]: FIXTURE_END },
      now: clock.now,
    });
    addRunner(db, { id: "R1" });
    db.run("UPDATE runner SET last_seen_at=?", [clock.now]);
    await open(db).tick();
    expect(getRetro(db, "r2")).toMatchObject({
      state: "abandoned",
      error:
        "The frozen digest is 8.3 MiB (8,718,484 bytes); runners accept at most 8.0 MiB (8,388,608 bytes).",
    });
    expect(await listRetroDispatches(sqliteDb(db), "r2")).toEqual([]);
  });
});

describe("recovery", () => {
  test("a turn past its limit is an unknown outcome: the slot stays and no second turn starts", async () => {
    const { db, clock, open } = world();
    addRunner(db, { id: "R1", capacity: 2 });
    const runner = fakeRunner("R1", clock);
    runner.seen(db);
    const dispatcher = open(db);
    await dispatcher.tick();
    const [command] = await runner.poll(dispatcher);
    await runner.start(dispatcher, command!);
    clock.now += 15 * 60_000 + 300_001;
    runner.seen(db);
    await dispatcher.tick();
    await dispatcher.tick();
    expect(dispatcher.generation("r1")).toMatchObject({
      state: "generating",
      diagnostic: "unknown_outcome",
      attempt: 1,
    });
    expect(await listRetroDispatches(sqliteDb(db), "r1")).toHaveLength(1);
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
    await dispatcher.tick();
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

    await dispatcher.tick();
    expect(await listRetroDispatches(sqliteDb(db), "r1")).toHaveLength(1);
    clock.now += retroRetryDelayMs(1);
    runner.seen(db);
    await dispatcher.tick();
    const [second] = await runner.poll(dispatcher);
    expect(second).toMatchObject({
      attempt: 2,
      digest: first!.digest,
      settingsRevision: first!.settingsRevision,
    });
    expect(second!.prompt.sha256).not.toBe(first!.prompt.sha256);
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
    await dispatcher.tick();
    expect(await listRetroDispatches(sqliteDb(db), "r1")).toHaveLength(2);
  });

  test("an invalid result's retry is a repair turn that gets the exact problems", async () => {
    const { db, clock, open } = world({ retries: 1 });
    addRunner(db, { id: "R1" });
    const runner = fakeRunner("R1", clock);
    runner.seen(db);
    const dispatcher = open(db);
    await dispatcher.tick();
    const [first] = await runner.poll(dispatcher);
    const firstInputs = await runner.start(dispatcher, first!);
    expect(firstInputs.prompt).not.toContain("<previous_result_problems>");
    const invalid = JSON.stringify({
      patterns: [
        fixturePattern({
          explanation: "12 questions asked how to recover from a rejected push.",
          existingIssues: ["PAS-817"],
        }),
      ],
      workedWell: [],
    });
    await runner.submit(dispatcher, first!, runner.result(first!, invalid));
    expect(getRetro(db, "r1")!.error).toContain(
      "patterns[0].existingIssues[0] unknown_issue; patterns[0].explanation forged_count",
    );

    clock.now += retroRetryDelayMs(1);
    runner.seen(db);
    await dispatcher.tick();
    const [second] = await runner.poll(dispatcher);
    expect(second!.attempt).toBe(2);
    expect(second!.prompt.sha256).not.toBe(first!.prompt.sha256);
    const { prompt } = await runner.start(dispatcher, second!);
    expect(prompt).toStartWith(firstInputs.prompt!);
    expect(prompt).toContain(
      '- "patterns[0].explanation" forged_count: The cited evidence supports at most 9 questions.',
    );
    expect(prompt).toContain(
      '- "patterns[0].existingIssues[0]" unknown_issue: List only existing issues the digest reports for this repository.',
    );
    expect(prompt).toContain(`Previous output:\n${invalid}\n</previous_result_problems>\n`);

    await runner.submit(dispatcher, second!, runner.result(second!, VALID_OUTPUT));
    expect(getRetro(db, "r1")!.state).toBe("published");
    expect((await listRetroAttempts(sqliteDb(db), "r1")).map((entry) => entry.outcome)).toEqual([
      "failed",
      "succeeded",
    ]);
  });

  test("an invalid result with no retry left fails the retro as before", async () => {
    const { db, clock, open } = world({ retries: 0 });
    addRunner(db, { id: "R1" });
    const runner = fakeRunner("R1", clock);
    runner.seen(db);
    const dispatcher = open(db);
    await dispatcher.tick();
    const [first] = await runner.poll(dispatcher);
    await runner.start(dispatcher, first!);
    const invalid = JSON.stringify({
      patterns: [fixturePattern({ existingIssues: ["PAS-817"] })],
      workedWell: [],
    });
    await runner.submit(dispatcher, first!, runner.result(first!, invalid));
    expect(dispatcher.generation("r1")).toMatchObject({
      state: "failed",
      diagnostic: "failed",
      retry: null,
      attemptsUsed: 1,
      maxAttempts: 1,
    });
    expect(getRetro(db, "r1")!.error).toContain("patterns[0].existingIssues[0] unknown_issue");
    clock.now += 86_400_000;
    runner.seen(db);
    await dispatcher.tick();
    expect(await listRetroDispatches(sqliteDb(db), "r1")).toHaveLength(1);
  });

  test("an unfetched command is re-signed under the same id; a lost fetch costs no attempt", async () => {
    const { db, clock, open } = world({ retries: 0 });
    addRunner(db, { id: "R1" });
    const runner = fakeRunner("R1", clock);
    runner.seen(db);
    const dispatcher = open(db);
    await dispatcher.tick();
    const [dispatch] = await listRetroDispatches(sqliteDb(db), "r1");
    clock.now += 290_000;
    runner.seen(db);
    const [resent] = await runner.poll(dispatcher);
    expect(resent!.id).toBe(dispatch!.commandId);
    expect((await listRetroDispatches(sqliteDb(db), "r1"))[0]!.deliveries).toBe(2);

    clock.now += 300_000 + 60_001;
    runner.seen(db);
    await dispatcher.tick();
    expect((await listRetroDispatches(sqliteDb(db), "r1"))[0]).toMatchObject({
      releaseReason: "not_started",
    });
    await dispatcher.tick();
    expect(await listRetroDispatches(sqliteDb(db), "r1")).toHaveLength(1);
    expect(dispatcher.generation("r1")).toMatchObject({ diagnostic: "retry_backoff" });
    clock.now += retroRetryDelayMs(1);
    runner.seen(db);
    await dispatcher.tick();
    const dispatches = await listRetroDispatches(sqliteDb(db), "r1");
    expect(dispatches).toHaveLength(2);
    expect(dispatcher.generation("r1")).toMatchObject({
      state: "generating",
      attempt: 2,
      attemptsUsed: 1,
      maxAttempts: 1,
    });
  });

  test("an online runner that never fetches does not hold its slot after the command expires", async () => {
    const { db, clock, open } = world({ retries: 0 });
    addRunner(db, { id: "R1" });
    const runner = fakeRunner("R1", clock);
    runner.seen(db);
    const dispatcher = open(db);
    await dispatcher.tick();
    const [dispatch] = await listRetroDispatches(sqliteDb(db), "r1");
    clock.now = dispatch!.expiresAt;
    runner.seen(db);
    await dispatcher.tick();
    expect(await getRetroDispatch(sqliteDb(db), dispatch!.commandId)).toMatchObject({
      releaseReason: "not_started",
    });
    expect(await retroSlotsHeld(sqliteDb(db), "R1")).toBe(0);
    expect(await dispatcher.commands("R1")).toEqual([]);
    for (let round = 1; round <= 3; round += 1) {
      clock.now += retroRetryDelayMs(round) - 1;
      runner.seen(db);
      await dispatcher.tick();
      expect(await listRetroDispatches(sqliteDb(db), "r1")).toHaveLength(round);
      clock.now += 1;
      runner.seen(db);
      await dispatcher.tick();
      const latest = (await listRetroDispatches(sqliteDb(db), "r1")).at(-1)!;
      expect(latest.attempt).toBe(round + 1);
      clock.now = latest.expiresAt;
      runner.seen(db);
      await dispatcher.tick();
    }
    expect(dispatcher.generation("r1")).toMatchObject({
      state: "failed",
      diagnostic: "retry_backoff",
      attemptsUsed: 0,
    });
  });

  test("revoking a runner mid-turn keeps the slot and attempt fenced; no retry starts", async () => {
    const { db, clock, open } = world();
    addRunner(db, { id: "R1" });
    addRunner(db, { id: "R2" });
    const runner = fakeRunner("R1", clock);
    db.run("UPDATE runner SET last_seen_at=? WHERE id='R2'", [clock.now - 1]);
    runner.seen(db);
    const dispatcher = open(db);
    await dispatcher.tick();
    const [command] = await runner.poll(dispatcher);
    await runner.start(dispatcher, command!);
    db.run("UPDATE runner SET status='revoked', revoked_at=? WHERE id='R1'", [clock.now]);
    for (let tick = 0; tick < 3; tick += 1) {
      clock.now += retroRetryDelayMs(3);
      db.run("UPDATE runner SET last_seen_at=? WHERE id='R2'", [clock.now]);
      await dispatcher.tick();
    }
    expect(await listRetroDispatches(sqliteDb(db), "r1")).toHaveLength(1);
    expect((await listRetroDispatches(sqliteDb(db), "r1"))[0]!.releasedAt).toBeNull();
    expect(dispatcher.generation("r1")).toMatchObject({
      state: "generating",
      diagnostic: "unknown_outcome",
      attempt: 1,
    });
    expect(
      (await runner.submit(dispatcher, command!, runner.result(command!, VALID_OUTPUT))).status,
    ).toBe(409);
    expect(await fakeRunner("R2", clock).poll(dispatcher)).toEqual([]);
  });

  test("an unfetched command on a revoked runner was never started and is released", async () => {
    const { db, clock, open } = world();
    addRunner(db, { id: "R1" });
    db.run("UPDATE runner SET last_seen_at=?", [clock.now]);
    const dispatcher = open(db);
    await dispatcher.tick();
    db.run("UPDATE runner SET status='revoked', revoked_at=? WHERE id='R1'", [clock.now]);
    await dispatcher.tick();
    expect((await listRetroDispatches(sqliteDb(db), "r1"))[0]).toMatchObject({
      releaseReason: "not_started",
    });
    expect(dispatcher.generation("r1")).toMatchObject({ attemptsUsed: 0 });
  });

  test("losing workspace authority stops delivery but lets the runner report teardown", async () => {
    const { db, clock, open } = world();
    addRunner(db, { id: "R1" });
    const runner = fakeRunner("R1", clock);
    runner.seen(db);
    const dispatcher = open(db);
    await dispatcher.tick();
    const [command] = await runner.poll(dispatcher);
    await runner.start(dispatcher, command!);
    db.run("UPDATE workspace_member SET role='member' WHERE user_id='admin'");
    const input = await call(dispatcher, "R1", `/v1/retro-commands/${command!.id}/input`, {
      commandId: command!.id,
      workspaceId: "ws",
      retroId: "r1",
      attempt: 1,
      kind: "digest",
      sha256: command!.digest.sha256,
      offset: 0,
      length: 1,
    });
    expect(input.status).toBe(409);
    await dispatcher.tick();
    expect(runnerOccupancy(db, "R1", clock.now).occupied).toBe(1);
    expect(
      (await runner.submit(dispatcher, command!, runner.result(command!, VALID_OUTPUT))).status,
    ).toBe(200);
    expect(runnerOccupancy(db, "R1", clock.now).occupied).toBe(0);
    expect(getRetro(db, "r1")).toMatchObject({ state: "failed" });
    expect(getRetro(db, "r1")!.error).toContain("lost workspace authority");
    expect(listRetroItems(db, "r1")).toEqual([]);
  });

  test("an unfetched command is released when the owner loses workspace authority", async () => {
    const { db, clock, open } = world();
    addRunner(db, { id: "R1" });
    db.run("UPDATE runner SET last_seen_at=?", [clock.now]);
    const dispatcher = open(db);
    await dispatcher.tick();
    db.run("UPDATE workspace_member SET role='member' WHERE user_id='admin'");
    await dispatcher.tick();
    expect((await listRetroDispatches(sqliteDb(db), "r1"))[0]).toMatchObject({
      releaseReason: "not_started",
    });
    expect(runnerOccupancy(db, "R1", clock.now).occupied).toBe(0);
  });

  test("replaying settlement after publication keeps the ready report and its accounting", async () => {
    const { db, clock, open } = world();
    addRunner(db, { id: "R1" });
    const runner = fakeRunner("R1", clock);
    runner.seen(db);
    const dispatcher = open(db);
    await dispatcher.tick();
    const [command] = await runner.poll(dispatcher);
    await runner.start(dispatcher, command!);
    await runner.submit(dispatcher, command!, runner.result(command!, VALID_OUTPUT));
    db.run("UPDATE retro_dispatch SET settled_at = NULL");
    await dispatcher.tick();
    expect(dispatcher.generation("r1")).toMatchObject({
      state: "ready",
      diagnostic: "ready",
      activeMs: 42_000,
    });
    expect(listRetroItems(db, "r1")).toHaveLength(1);
  });
});

describe("agent account admission", () => {
  test("a disabled default account dispatches nothing", async () => {
    const { db, clock, open } = world();
    addRunner(db, { id: "R1" });
    db.run("UPDATE runner SET last_seen_at=?", [clock.now]);
    const accountId = legacyAgentAccountId("ws", "codex");
    await ensureLegacyAgentBinding(sqliteDb(db), "R1", "codex", clock.now);
    db.run("UPDATE agent_account SET enabled=0 WHERE id=?", [accountId]);
    const dispatcher = open(db);
    await dispatcher.tick();
    expect(await listRetroDispatches(sqliteDb(db), "r1")).toEqual([]);
    expect(dispatcher.generation("r1")).toMatchObject({
      state: "waiting_for_runner",
      diagnostic: "no_runner",
      attempt: 0,
    });
  });

  test("a persisted provider or model hold blocks dispatch while the runner has no cooldown", async () => {
    const { db, clock, open } = world();
    addRunner(db, { id: "R1" });
    db.run("UPDATE runner SET last_seen_at=?", [clock.now]);
    const binding = await ensureLegacyAgentBinding(sqliteDb(db), "R1", "codex", clock.now);
    recordAccountObservation(db, {
      bindingId: binding.id,
      source: "result",
      sourceId: "model-hold",
      observedAt: clock.now,
      now: clock.now,
      state: "unsupported_model",
      model: "gpt-x",
    });
    const dispatcher = open(db);
    await dispatcher.tick();
    expect(await listRetroDispatches(sqliteDb(db), "r1")).toEqual([]);
    expect(dispatcher.generation("r1")).toMatchObject({
      state: "waiting_for_runner",
      diagnostic: "no_runner",
      attempt: 0,
    });
    expect(dispatcher.generation("r1")!.detail).toContain("model unavailable");

    recordAccountObservation(db, {
      bindingId: binding.id,
      source: "result",
      sourceId: "provider-hold",
      observedAt: clock.now + 1,
      now: clock.now + 1,
      state: "restricted",
    });
    clock.now += 60_000;
    db.run("UPDATE runner SET last_seen_at=?", [clock.now]);
    await dispatcher.tick();
    expect(await listRetroDispatches(sqliteDb(db), "r1")).toEqual([]);
    expect(dispatcher.generation("r1")).toMatchObject({ diagnostic: "no_runner", attempt: 0 });

    recordAccountObservation(db, {
      bindingId: binding.id,
      source: "result",
      sourceId: "provider-ok",
      observedAt: clock.now,
      now: clock.now,
      state: "ok",
      model: "gpt-x",
      clears: ["provider", "model"],
    });
    await dispatcher.tick();
    expect(await listRetroDispatches(sqliteDb(db), "r1")).toHaveLength(1);
  });

  test("an open retro reservation fences quota revalidation for further attempts", async () => {
    const { db, clock, open } = world();
    addRunner(db, { id: "R1", capacity: 4 });
    db.run("UPDATE runner SET last_seen_at=?", [clock.now]);
    const accountId = legacyAgentAccountId("ws", "codex");
    const binding = await ensureLegacyAgentBinding(sqliteDb(db), "R1", "codex", clock.now);
    recordAccountObservation(db, {
      bindingId: binding.id,
      source: "result",
      sourceId: "quota-hold",
      observedAt: clock.now,
      now: clock.now,
      state: "exhausted",
      resetsAt: clock.now,
    });
    db.run("UPDATE agent_account_health SET next_check_at=? WHERE kind='quota'", [clock.now]);
    createRetro(db, {
      id: "r0",
      workspaceId: "ws",
      windowStart: FIXTURE_START - 7 * 86_400_000,
      windowEnd: FIXTURE_START,
      origin: "manual",
      settingsRevision: getRetro(db, "r1")!.settingsRevision,
      now: clock.now,
    });
    db.run(
      `INSERT INTO retro_dispatch (command_id, retro_id, attempt, workspace_id, runner_id,
         runner_fence, command, envelope, created_at, issued_at, expires_at)
       VALUES ('probe', 'r0', 1, 'ws', 'R1', 0, '{}', '{}', ?, ?, ?)`,
      [clock.now, clock.now, clock.now + 1],
    );
    db.run(
      `INSERT INTO runner_command_account (command_id, workspace_id, runner_id, agent, account_id,
         binding_id, named, recorded_at) VALUES ('probe', 'ws', 'R1', 'codex', ?, ?, 0, ?)`,
      [accountId, binding.id, clock.now],
    );
    const dispatcher = open(db);
    await dispatcher.tick();
    expect(dispatcher.generation("r1")).toMatchObject({
      state: "waiting_for_runner",
      diagnostic: "quota_cooldown",
      attempt: 0,
    });

    db.run(
      "UPDATE retro_dispatch SET released_at=?, release_reason='teardown' WHERE command_id='probe'",
      [clock.now],
    );
    await dispatcher.tick();
    expect(dispatcher.generation("r1")).toMatchObject({ state: "generating", attempt: 1 });
  });

  test("the account concurrency limit counts retro turns and holds further work", async () => {
    const { db, clock, open } = world();
    addRunner(db, { id: "R1", capacity: 4 });
    db.run("UPDATE runner SET last_seen_at=?", [clock.now]);
    const accountId = legacyAgentAccountId("ws", "codex");
    const binding = await ensureLegacyAgentBinding(sqliteDb(db), "R1", "codex", clock.now);
    db.run("UPDATE agent_account SET concurrency=1 WHERE id=?", [accountId]);
    createRetro(db, {
      id: "r0",
      workspaceId: "ws",
      windowStart: FIXTURE_START - 7 * 86_400_000,
      windowEnd: FIXTURE_START,
      origin: "manual",
      settingsRevision: getRetro(db, "r1")!.settingsRevision,
      now: clock.now,
    });
    db.run(
      `INSERT INTO retro_dispatch (command_id, retro_id, attempt, workspace_id, runner_id,
         runner_fence, command, envelope, created_at, issued_at, expires_at)
       VALUES ('other', 'r0', 1, 'ws', 'R1', 0, '{}', '{}', ?, ?, ?)`,
      [clock.now, clock.now, clock.now + 1],
    );
    db.run(
      `INSERT INTO runner_command_account (command_id, workspace_id, runner_id, agent, account_id,
         binding_id, named, recorded_at) VALUES ('other', 'ws', 'R1', 'codex', ?, ?, 0, ?)`,
      [accountId, binding.id, clock.now],
    );
    expect(accountSlotsInUse(db, accountId, clock.now)).toBe(1);
    const dispatcher = open(db);
    await dispatcher.tick();
    expect(dispatcher.generation("r1")).toMatchObject({
      state: "waiting_for_runner",
      diagnostic: "capacity_wait",
      attempt: 0,
    });

    db.run(
      "UPDATE retro_dispatch SET released_at=?, release_reason='teardown' WHERE command_id='other'",
      [clock.now],
    );
    await dispatcher.tick();
    expect(dispatcher.generation("r1")).toMatchObject({ state: "generating", attempt: 1 });
    expect(accountSlotsInUse(db, accountId, clock.now)).toBe(1);
  });
});
