import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getRetro, listRetroItems, openDatabase, sqliteDb } from "../src/db";
import { RunnerRequestError } from "../src/runner-daemon";
import { readRunnerJob, readRunnerJobInputs } from "../src/runner-execution";
import {
  verifyRunnerRetroCommand,
  type RunnerRetroCommand,
  type RunnerRetroInputRequest,
  type RunnerRetroResult,
} from "../src/runner-protocol";
import { openRunnerRetroRuntime, type RunnerRetroDaemon } from "../src/runner-retro-runtime";
import { executeRetroCommand } from "../src/runner-worker";
import type { createRetroDispatcher } from "../src/retros";
import { addRunner, trustedKeys, world } from "../src/retros/dispatch.fixtures";
import { fixturePattern } from "../src/retros/result.fixtures";

const nonRootLinux = process.platform === "linux" && process.getuid!() > 0 && process.getgid!() > 0;
const OUTPUT = JSON.stringify({ patterns: [fixturePattern()], workedWell: [] });
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Dispatcher = ReturnType<typeof createRetroDispatcher>;

async function call(dispatcher: Dispatcher, path: string, body?: unknown) {
  const request =
    body === undefined
      ? new Request(`https://runner.test${path}`)
      : new Request(`https://runner.test${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
  const response = await dispatcher.fetch(request, "R1");
  if (response === null) throw new Error(`unrouted ${path}`);
  const json = (await response.json()) as Record<string, unknown>;
  if (response.status !== 200) throw new RunnerRequestError(response.status, "POST", path, 0);
  return json;
}

function runnerDaemon(control: { dispatcher: Dispatcher }, clock: { now: number }) {
  const pending = new Map<string, RunnerRetroCommand>();
  const claimed = new Set<string>();
  const attempts = new Map<string, number>();
  const calls: string[] = [];
  const daemon: RunnerRetroDaemon = {
    status: () => ({
      phase: "paired",
      runnerId: "R1",
      workspaceId: "ws",
      fingerprint: "fixture",
      expiresAt: clock.now + 86_400_000,
    }),
    async pollRetroCommands() {
      const { commands } = (await call(control.dispatcher, "/v1/retro-commands")) as {
        commands: unknown[];
      };
      for (const envelope of commands) {
        const verified = verifyRunnerRetroCommand(envelope, {
          trustedKeys,
          runnerId: "R1",
          workspaceId: "ws",
          now: clock.now,
          latestAttempt: (retroId) => attempts.get(retroId),
          claimCommand: (id) => !claimed.has(id) && Boolean(claimed.add(id)),
        });
        if (!verified.ok) continue;
        pending.set(verified.command.id, verified.command);
        attempts.set(verified.command.retroId, verified.command.attempt);
      }
      return {
        commands: [...pending.values()].filter((command) => command.expiresAt > clock.now),
        rejected: [],
      };
    },
    async acknowledgeRetroCommand(id: string) {
      calls.push("ack");
      return (await call(control.dispatcher, `/v1/retro-commands/${id}/ack`, {})) as {
        expiresAt: number;
      };
    },
    async retroInput(request: RunnerRetroInputRequest) {
      calls.push(`input:${request.kind}`);
      return call(control.dispatcher, `/v1/retro-commands/${request.commandId}/input`, request);
    },
    async postRetroResult(result: RunnerRetroResult) {
      calls.push("result");
      return (await call(
        control.dispatcher,
        `/v1/retro-commands/${result.commandId}/result`,
        result,
      )) as { duplicate: boolean };
    },
    async releaseRetroCommand(id: string) {
      calls.push("released");
      return (await call(control.dispatcher, `/v1/retro-commands/${id}/released`, {
        reason: "teardown",
      })) as { ok: true };
    },
  };
  return { daemon, calls };
}

function runnerHost(
  root: string,
  options: { crash?: boolean; failStart?: boolean; stopFailures?: number } = {},
) {
  const spool = {
    root: join(root, "spool"),
    runnerUid: process.getuid!(),
    agentGid: process.getgid!(),
  };
  const results = {
    root: join(root, "results"),
    agentUid: process.getuid!(),
    resultsGid: process.getgid!(),
  };
  for (const [path, mode] of [
    [spool.root, 0o750],
    [results.root, 0o770],
    [join(root, "retro"), 0o700],
    [join(root, "home"), 0o700],
  ] as const) {
    mkdirSync(path, { recursive: true, mode });
    chmodSync(path, mode);
  }
  const script = join(root, "script.json");
  writeFileSync(
    script,
    JSON.stringify({
      model: "gpt-x",
      models: ["gpt-x"],
      steps: [
        {
          type: "update",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: OUTPUT } },
        },
        { type: "end" },
      ],
    }),
  );
  const starts: string[] = [];
  const stops: string[] = [];
  let stopFailures = options.stopFailures ?? 0;
  const finished = new Set<string>();
  const broker = {
    async start(id: string) {
      starts.push(id);
      if (options.failStart) throw new Error("worker start failed");
      const outputDirectory = join(results.root, id);
      mkdirSync(outputDirectory, { mode: 0o750 });
      chmodSync(outputDirectory, 0o750);
      if (options.crash) {
        finished.add(id);
        return { alreadyAdmitted: false };
      }
      const { command } = readRunnerJob(spool, id);
      const inputs = readRunnerJobInputs(spool, id).retro!;
      if (command.type !== "retro") throw new Error("expected a retro job");
      await executeRetroCommand({
        executionId: id,
        command,
        expected: {
          runnerId: command.runnerId,
          workspaceId: command.workspaceId,
          attempt: command.attempt,
          settingsRevision: command.settingsRevision,
        },
        fetchInput: async (request) => {
          const bytes = Buffer.from(inputs[request.kind]).subarray(
            request.offset,
            request.offset + request.length,
          );
          return {
            commandId: command.id,
            kind: request.kind,
            offset: request.offset,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            data: bytes.toString("base64"),
          };
        },
        outputDirectory,
        workRoot: join(root, "work"),
        home: join(root, "home"),
        resultsGid: results.resultsGid,
        launch: {
          command: process.execPath,
          args: [
            "--no-env-file",
            fileURLToPath(new URL("../src/acp/testing/fake-agent.ts", import.meta.url)),
            join(root, "agent.json"),
            script,
          ],
          env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
        },
      });
      finished.add(id);
      return { alreadyAdmitted: false };
    },
    async stop(id: string) {
      stops.push(id);
      if (stopFailures-- > 0) throw new Error("termination timed out");
    },
    alive: (id: string) => !finished.has(id),
  };
  return { spool, results, broker, starts, stops };
}

test.skipIf(!nonRootLinux)(
  "a retro waits, runs on the paired runner, survives both restarts and publishes once",
  async () => {
    const w = await world();
    const root = mkdtempSync(join(tmpdir(), "paws-retro-runner-"));
    roots.push(root);
    const control = { dispatcher: w.open(w.db) };
    await control.dispatcher.tick();
    expect(await control.dispatcher.generation("r1")).toMatchObject({
      state: "waiting_for_runner",
    });

    addRunner(w.db, { id: "R1" });
    const seen = () => w.db.run("UPDATE runner SET last_seen_at=? WHERE id='R1'", [w.clock.now]);
    seen();
    await control.dispatcher.tick();
    expect(await control.dispatcher.generation("r1")).toMatchObject({
      state: "generating",
      diagnostic: "dispatched",
    });

    const host = runnerHost(root);
    const { daemon, calls } = runnerDaemon(control, w.clock);
    const open = () =>
      openRunnerRetroRuntime({
        root: join(root, "retro"),
        daemon,
        spool: host.spool,
        results: host.results,
        broker: host.broker,
        now: () => w.clock.now,
      });
    let runtime = await open();
    await runtime.tick();
    expect(calls).toEqual(["ack", "input:digest", "input:prompt"]);
    expect(host.starts).toHaveLength(1);
    expect(runtime.status().active).toMatchObject([{ phase: "running" }]);

    control.dispatcher = w.open(openDatabase(w.path));
    await runtime.stop();
    runtime = await open();
    expect(runtime.status().active).toMatchObject([{ phase: "reporting" }]);
    seen();
    await runtime.tick();
    expect(calls.filter((name) => name === "result")).toHaveLength(1);
    expect(runtime.status().active).toEqual([]);

    const reopened = openDatabase(w.path);
    expect((await getRetro(sqliteDb(reopened), "r1"))?.state).toBe("published");
    const items = listRetroItems(reopened, "r1").length;
    expect(items).toBeGreaterThan(0);
    expect(await control.dispatcher.generation("r1")).toMatchObject({ state: "ready" });

    const result = JSON.parse(
      readFileSync(join(host.results.root, host.starts[0]!, "retro-result.json"), "utf8"),
    ) as RunnerRetroResult;
    expect(await daemon.postRetroResult(result)).toEqual({ duplicate: true });
    await runtime.tick();
    expect(host.starts).toHaveLength(1);
    expect(listRetroItems(reopened, "r1")).toHaveLength(items);
    expect(await control.dispatcher.generation("r1")).toMatchObject({ state: "ready" });
    await runtime.stop();
  },
);

test.skipIf(!nonRootLinux)(
  "a worker that dies without a result is reported as teardown and starts no second turn",
  async () => {
    const w = await world({ retries: 0 });
    const root = mkdtempSync(join(tmpdir(), "paws-retro-runner-"));
    roots.push(root);
    addRunner(w.db, { id: "R1" });
    w.db.run("UPDATE runner SET last_seen_at=? WHERE id='R1'", [w.clock.now]);
    const control = { dispatcher: w.open(w.db) };
    await control.dispatcher.tick();
    const host = runnerHost(root, { crash: true });
    const { daemon, calls } = runnerDaemon(control, w.clock);
    const runtime = await openRunnerRetroRuntime({
      root: join(root, "retro"),
      daemon,
      spool: host.spool,
      results: host.results,
      broker: host.broker,
      now: () => w.clock.now,
    });
    await runtime.tick();
    await runtime.tick();
    expect(calls).toEqual(["ack", "input:digest", "input:prompt", "released"]);
    expect(runtime.status().active).toEqual([]);
    expect(await control.dispatcher.generation("r1")).toMatchObject({
      state: "failed",
      diagnostic: "failed",
      retry: null,
    });
    await runtime.tick();
    expect(host.starts).toHaveLength(1);
    await runtime.stop();
  },
);

test.skipIf(!nonRootLinux)(
  "a failed admission whose termination fails retries teardown before releasing the slot",
  async () => {
    const w = await world({ retries: 0 });
    const root = mkdtempSync(join(tmpdir(), "paws-retro-runner-"));
    roots.push(root);
    addRunner(w.db, { id: "R1" });
    w.db.run("UPDATE runner SET last_seen_at=? WHERE id='R1'", [w.clock.now]);
    const control = { dispatcher: w.open(w.db) };
    await control.dispatcher.tick();
    const host = runnerHost(root, { failStart: true, stopFailures: 1 });
    const { daemon, calls } = runnerDaemon(control, w.clock);
    const errors: string[] = [];
    const runtime = await openRunnerRetroRuntime({
      root: join(root, "retro"),
      daemon,
      spool: host.spool,
      results: host.results,
      broker: host.broker,
      now: () => w.clock.now,
      onError: (error) => errors.push(error.message),
    });
    await runtime.tick();
    expect(errors).toEqual(["worker start failed", "termination timed out"]);
    expect(runtime.status().active).toMatchObject([{ phase: "preparing" }]);
    expect(calls).toEqual(["ack", "input:digest", "input:prompt"]);
    expect(await control.dispatcher.generation("r1")).toMatchObject({ state: "generating" });

    await runtime.tick();
    expect(host.stops).toHaveLength(2);
    expect(calls).toEqual(["ack", "input:digest", "input:prompt", "released"]);
    expect(runtime.status().active).toEqual([]);
    expect(await control.dispatcher.generation("r1")).toMatchObject({
      state: "failed",
      retry: null,
    });
    await runtime.tick();
    expect(host.starts).toHaveLength(1);
    await runtime.stop();
  },
);
