import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { getRetro, listRetroItems, openPawsStore, type Db } from "../src/db";
import { RunnerRequestError } from "../src/runner-daemon";
import {
  markRunnerAccountSignedIn,
  openRunnerAccountHome,
  readRunnerJob,
  readRunnerJobInputs,
} from "../src/runner-execution";
import {
  MINIMUM_RUNNER_VERSION,
  verifyRunnerRetroCommand,
  type RunnerAccount,
  type RunnerRetroCommand,
  type RunnerRetroInputRequest,
  type RunnerRetroResult,
  type RunnerRetroTranscriptRequest,
} from "../src/runner-protocol";
import { openRunnerRetroRuntime, type RunnerRetroDaemon } from "../src/runner-retro-runtime";
import { executeRetroCommand, relayRetroTranscript } from "../src/runner-worker";
import type { createRetroDispatcher } from "../src/retros";
import {
  addRunnerPg as addRunner,
  heldAccountBindings,
  trustedKeys,
  worldPg,
} from "../src/retros/dispatch.fixtures";
import { FIXTURE_START, fixturePattern } from "../src/retros/result.fixtures";
import { seed, withoutForeignKeys } from "./pglite-fixtures";
import { copyMigratedPglite, tempStore } from "./pglite";

const nonRootLinux = process.platform === "linux" && process.getuid!() > 0 && process.getgid!() > 0;
const OUTPUT = JSON.stringify({ patterns: [fixturePattern()], workedWell: [] });
const roots: string[] = [];
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function reopen(root: string) {
  const opened = await openPawsStore({ url: null, pgliteDir: join(root, "pglite") });
  return { db: opened.store, close: opened.close };
}

async function world(
  options: { retries?: number; restartable?: boolean; before?: (db: Db) => Promise<void> } = {},
) {
  const created = await worldPg(
    options.restartable
      ? {
          open: async (root) => {
            await copyMigratedPglite(join(root, "pglite"));
            return reopen(root);
          },
          reopen,
        }
      : { open: () => tempStore() },
    options,
  );
  roots.push(created.root);
  closes.push(() => created.close());
  return created;
}

const seen = (db: Db, now: number) =>
  seed(db, (q) => q.orm.update(q.t.runner).set({ lastSeenAt: now }).where(eq(q.t.runner.id, "R1")));

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
  if (response.status !== 200)
    throw new RunnerRequestError(response.status, "POST", path, 0, json.error as string);
  return json;
}

function runnerDaemon(control: { dispatcher: Dispatcher }, clock: { now: number }) {
  const pending = new Map<string, RunnerRetroCommand>();
  const claimed = new Set<string>();
  const attempts = new Map<string, number>();
  const calls: string[] = [];
  const credentials: string[] = [];
  const daemon: RunnerRetroDaemon = {
    credentialRecipient: () => "recipient-certificate",
    carriesCredential: () => true,
    restoreCredentials: (id) => credentials.push(`restore:${id}`),
    returnCredentials: (id) => credentials.push(`return:${id}`),
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
          accountBindings: heldAccountBindings("R1"),
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
    async retroInput(request: RunnerRetroInputRequest | RunnerRetroTranscriptRequest) {
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
  return { daemon, calls, credentials };
}

function runnerHost(
  root: string,
  account: RunnerAccount,
  options: {
    crash?: boolean;
    failStart?: boolean;
    stopFailures?: number;
    steps?: unknown[];
    background?: boolean;
  } = {},
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
  markRunnerAccountSignedIn(
    openRunnerAccountHome(join(root, "home"), account, "codex", { signIn: true }),
    account,
    "codex",
  );
  const script = join(root, "script.json");
  writeFileSync(
    script,
    JSON.stringify({
      model: "gpt-x",
      models: ["gpt-x"],
      steps: [
        ...(options.steps ?? []),
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
      const turn = executeRetroCommand({
        executionId: id,
        readTranscript: (request, signal) =>
          relayRetroTranscript(
            { spool, executionId: id, outputDirectory, resultsGid: results.resultsGid },
            request,
            signal,
          ),
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
      }).finally(() => finished.add(id));
      if (!options.background) await turn;
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
    const w = await world({ restartable: true });
    let db = w.db;
    const root = mkdtempSync(join(tmpdir(), "paws-retro-runner-"));
    roots.push(root);
    const control = { dispatcher: w.open(w.db) };
    await control.dispatcher.tick();
    expect(await control.dispatcher.generation("r1")).toMatchObject({
      state: "waiting_for_runner",
    });

    const account = (await addRunner(db, { id: "R1" }))!;
    await seen(db, w.clock.now);
    await control.dispatcher.tick();
    expect(await control.dispatcher.generation("r1")).toMatchObject({
      state: "generating",
      diagnostic: "dispatched",
    });

    const host = runnerHost(root, account);
    const { daemon, calls, credentials } = runnerDaemon(control, w.clock);
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
    const job = readRunnerJob(host.spool, host.starts[0]!);
    expect(job.command).toMatchObject({ account, profile: { agent: "codex" } });
    expect(job.credentials).toEqual({ certificate: "recipient-certificate" });
    expect(credentials).toEqual([`restore:${job.command.id}`]);

    db = await w.restart();
    control.dispatcher = w.open(db);
    await runtime.stop();
    runtime = await open();
    expect(runtime.status().active).toMatchObject([{ phase: "reporting" }]);
    await seen(db, w.clock.now);
    await runtime.tick();
    expect(calls.filter((name) => name === "result")).toHaveLength(1);
    expect(credentials).toEqual([`restore:${job.command.id}`, `return:${job.command.id}`]);
    expect(runtime.status().active).toEqual([]);

    expect((await getRetro(db, "r1"))?.state).toBe("published");
    const items = (await listRetroItems(db, "r1")).length;
    expect(items).toBeGreaterThan(0);
    expect(await control.dispatcher.generation("r1")).toMatchObject({ state: "ready" });

    const result = JSON.parse(
      readFileSync(join(host.results.root, host.starts[0]!, "retro-result.json"), "utf8"),
    ) as RunnerRetroResult;
    expect(await daemon.postRetroResult(result)).toEqual({ duplicate: true });
    await runtime.tick();
    expect(host.starts).toHaveLength(1);
    expect(await listRetroItems(db, "r1")).toHaveLength(items);
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
    const account = (await addRunner(w.db, { id: "R1" }))!;
    await seen(w.db, w.clock.now);
    const control = { dispatcher: w.open(w.db) };
    await control.dispatcher.tick();
    const host = runnerHost(root, account, { crash: true });
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
    const account = (await addRunner(w.db, { id: "R1" }))!;
    await seen(w.db, w.clock.now);
    const control = { dispatcher: w.open(w.db) };
    await control.dispatcher.tick();
    const host = runnerHost(root, account, { failStart: true, stopFailures: 1 });
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

test.skipIf(!nonRootLinux)(
  "a retro turn lists transcripts, pages through a run and gets a spent budget as a tool error",
  async () => {
    const say = {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "y".repeat(200) },
    };
    const transcript = JSON.stringify({
      t: new Date(FIXTURE_START).toISOString(),
      event: { type: "session_update", update: say },
    });
    const w = await world({
      before: async (db) => {
        await withoutForeignKeys(db);
        await seed(
          db,
          (q) =>
            q.orm.insert(q.t.run).values({
              id: "run-a",
              itemId: "item-PAS-817",
              kind: "implement",
              agent: "codex",
              status: "ended",
              createdAt: FIXTURE_START + 1_000,
              updatedAt: FIXTURE_START + 1_500,
            }),
          (q) =>
            q.orm.insert(q.t.runnerTranscript).values({
              runId: "run-a",
              generation: 1,
              commandId: "command-run-a",
              workspaceId: "ws",
              executionId: "e",
              sizeBytes: transcript.length,
              sealedSize: transcript.length,
            }),
        );
      },
    });
    const root = mkdtempSync(join(tmpdir(), "paws-retro-runner-"));
    roots.push(root);
    const account = (await addRunner(w.db, {
      id: "R1",
      version: MINIMUM_RUNNER_VERSION.join("."),
    }))!;
    await seen(w.db, w.clock.now);
    const reader = { download: async () => new TextEncoder().encode(transcript) };
    const control = { dispatcher: w.open(w.db, undefined, { transcripts: reader }) };
    await control.dispatcher.tick();
    await seed(w.db, (q) => q.orm.update(q.t.retroAttempt).set({ transcriptReads: 398 }));
    const tool = (name: string, args: object) => ({ type: "host_tool", name, arguments: args });
    const read = (offset: number) =>
      tool("read_transcript", { runId: "run-a", generation: 1, offset, limit: 64 });
    const host = runnerHost(root, account, {
      background: true,
      steps: [
        tool("list_transcripts", { item: "PAS-817" }),
        tool("list_transcripts", { item: "PAS-1" }),
        read(0),
        read(64),
        read(128),
      ],
    });
    const { daemon } = runnerDaemon(control, w.clock);
    const runtime = await openRunnerRetroRuntime({
      root: join(root, "retro"),
      daemon,
      spool: host.spool,
      results: host.results,
      broker: host.broker,
      now: () => w.clock.now,
    });
    expect(
      readRunnerJob(host.spool, (await runtime.tick(), host.starts[0]!)).command,
    ).toMatchObject({ transcripts: true });
    for (let i = 0; i < 200 && runtime.status().active.length > 0; i++) {
      await Bun.sleep(100);
      await runtime.tick();
    }
    expect(runtime.status().active).toEqual([]);
    const tools = JSON.parse(readFileSync(join(root, "agent.json"), "utf8")).hostTools;
    expect(tools[0]).toMatchObject({ name: "list_transcripts", ok: true });
    expect(tools[0].text).toContain("run:run-a#1 PAS-817 implement");
    expect(tools[1].text).toBe("No transcripts match.");
    const pages = [JSON.parse(tools[2].text), JSON.parse(tools[3].text)];
    expect(pages.map((page) => [page.offset, page.nextOffset])).toEqual([
      [0, 64],
      [64, 128],
    ]);
    expect(pages[0].total).toBeGreaterThan(128);
    expect(pages[0].text + pages[1].text).toStartWith(
      `${new Date(FIXTURE_START).toISOString()} agent: yyy`,
    );
    expect(tools[4]).toMatchObject({ name: "read_transcript", ok: false });
    expect(tools[4].error).toContain("Transcript budget used");
    expect((await getRetro(w.db, "r1"))?.state).toBe("published");
    await runtime.stop();
  },
);
