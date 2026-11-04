import { journalCaught } from "../journal";
import { chmodSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { randomBytes } from "node:crypto";
import { openDatabase } from "../db";
import { RunnerRequestError, type RunnerDaemon } from "../runner-daemon";
import {
  createDirectWorkerSupervisor,
  publishRunnerJob,
  readRunnerResultFile,
  type RunnerBrokerClient,
  type RunnerResults,
  type RunnerSpool,
} from "../runner-execution";
import {
  RunnerRetroCommandSchema,
  RunnerRetroResultSchema,
  type RunnerRetroCommand,
  type RunnerRetroInputRequest,
  type RunnerRetroResult,
} from "../runner-protocol";
import { downloadRetroInput, RETRO_RESULT_FILE } from "../runner-worker";

type Phase = "preparing" | "running" | "reporting" | "releasing" | "complete";
type Row = {
  id: string;
  payload: string;
  phase: Phase;
  result: string | null;
  started_at: number | null;
};

export type RunnerRetroDaemon = Pick<
  RunnerDaemon,
  | "status"
  | "pollRetroCommands"
  | "acknowledgeRetroCommand"
  | "retroInput"
  | "postRetroResult"
  | "releaseRetroCommand"
>;

export const RUNNER_RETRO_RUNTIME_TIMING = {
  inputTimeoutMs: 120_000,
  outcomeGraceMs: 120_000,
} as const;

function executionId(now: number) {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  let value = BigInt(`0x${bytes.toString("hex")}`);
  let result = "";
  for (let index = 0; index < 26; index++) {
    result = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[Number(value & 31n)] + result;
    value >>= 5n;
  }
  return result;
}

const settled = (error: unknown) =>
  error instanceof RunnerRequestError && error.status >= 400 && error.status < 500;

export async function openRunnerRetroRuntime(options: {
  root: string;
  daemon: RunnerRetroDaemon;
  spool: RunnerSpool;
  results: RunnerResults;
  broker?: RunnerBrokerClient;
  now?: () => number;
  onError?: (error: Error) => void;
}) {
  if (!isAbsolute(options.root) || options.daemon.status().phase !== "paired")
    throw new Error("Paired runner and absolute retro root are required");
  const info = statSync(options.root);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o700)
    throw new Error("Runner retro root must be private");
  const path = join(options.root, "retro.db");
  const db = openDatabase(path);
  chmodSync(path, 0o600);
  db.run(
    `CREATE TABLE IF NOT EXISTS retro_execution(id TEXT PRIMARY KEY, command_id TEXT UNIQUE NOT NULL,
     payload TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN
     ('preparing','running','reporting','releasing','complete')), result TEXT, started_at INTEGER) STRICT`,
  );
  const broker =
    options.broker ??
    createDirectWorkerSupervisor({
      stateRoot: join(options.root, "workers"),
      spool: options.spool,
      results: options.results,
    });
  const now = options.now ?? Date.now;
  const report = (error: unknown) =>
    options.onError?.(error instanceof Error ? error : new Error("Runner retro operation failed"));
  const phase = (id: string, next: Phase, result?: RunnerRetroResult) =>
    db.run("UPDATE retro_execution SET phase=?, result=COALESCE(?, result) WHERE id=?", [
      next,
      result === undefined ? null : JSON.stringify(result),
      id,
    ]);
  const commandOf = (row: Row): RunnerRetroCommand =>
    RunnerRetroCommandSchema.parse(JSON.parse(row.payload));

  function recordedResult(row: Row, command: RunnerRetroCommand): RunnerRetroResult | null {
    let raw: Buffer;
    try {
      raw = readRunnerResultFile(options.results, row.id, RETRO_RESULT_FILE);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const result = RunnerRetroResultSchema.parse(JSON.parse(raw.toString("utf8")));
    if (result.executionId !== row.id || result.commandId !== command.id)
      throw new Error("Runner retro result identity mismatch");
    return result;
  }

  async function settleTurn(row: Row, command: RunnerRetroCommand) {
    await broker.stop(row.id);
    const result = recordedResult(row, command);
    if (result) phase(row.id, "reporting", result);
    else phase(row.id, "releasing");
  }

  try {
    for (const row of db
      .query<Row, []>(
        "SELECT id,payload,phase,result,started_at FROM retro_execution WHERE phase IN ('preparing','running') ORDER BY rowid",
      )
      .all())
      await settleTurn(row, commandOf(row));
    await broker.sweep?.();
  } catch (error) {
    db.close();
    throw error;
  }

  let closed = false;
  let ticking: Promise<void> | undefined;

  async function deliver(row: Row, command: RunnerRetroCommand) {
    try {
      if (row.phase === "reporting")
        await options.daemon.postRetroResult(
          RunnerRetroResultSchema.parse(JSON.parse(row.result!)),
        );
      else await options.daemon.releaseRetroCommand(command.id);
    } catch (error) {
      if (!settled(error)) throw error;
      journalCaught(error, "runner-retro-runtime.report.refused", null);
    }
    phase(row.id, "complete");
  }

  const reread = (id: string) =>
    db
      .query<Row, [string]>(
        "SELECT id,payload,phase,result,started_at FROM retro_execution WHERE id=?",
      )
      .get(id)!;

  async function advance(row: Row) {
    const command = commandOf(row);
    if (row.phase === "preparing") {
      await settleTurn(row, command);
      row = reread(row.id);
    } else if (row.phase === "running") {
      const deadline =
        (row.started_at ?? now()) +
        command.executionLimit.activeMinutes * 60_000 +
        RUNNER_RETRO_RUNTIME_TIMING.outcomeGraceMs;
      if (!recordedResult(row, command) && broker.alive?.(row.id) !== false && now() <= deadline)
        return;
      await settleTurn(row, command);
      row = reread(row.id);
    }
    if (row.phase === "reporting" || row.phase === "releasing") await deliver(row, command);
  }

  async function admit(command: RunnerRetroCommand) {
    const id = executionId(now());
    db.run("INSERT INTO retro_execution(id,command_id,payload,phase) VALUES(?,?,?,'preparing')", [
      id,
      command.id,
      JSON.stringify(command),
    ]);
    try {
      await options.daemon.acknowledgeRetroCommand(command.id);
    } catch (error) {
      if (!settled(error)) {
        phase(id, "releasing");
        throw error;
      }
      journalCaught(error, "runner-retro-runtime.admit.acknowledge", null);
      phase(id, "releasing");
      return;
    }
    try {
      const signal = AbortSignal.timeout(RUNNER_RETRO_RUNTIME_TIMING.inputTimeoutMs);
      const fetchInput = (request: RunnerRetroInputRequest) => options.daemon.retroInput(request);
      const digest = await downloadRetroInput(command, "digest", fetchInput, signal);
      const prompt = await downloadRetroInput(command, "prompt", fetchInput, signal);
      if (closed) throw new Error("Runner retro runtime is closed");
      publishRunnerJob(
        options.spool,
        { executionId: id, command },
        { retroInputs: { digest, prompt } },
      );
      const receipt = await broker.start(id);
      if (receipt.alreadyAdmitted)
        throw new Error("Runner execution identity was already consumed");
      db.run("UPDATE retro_execution SET phase='running', started_at=? WHERE id=?", [now(), id]);
    } catch (error) {
      journalCaught(error, "runner-retro-runtime.admit.start", null);
      report(error);
      try {
        await broker.stop(id);
        phase(id, "releasing");
      } catch (stopError) {
        journalCaught(stopError, "runner-retro-runtime.admit.stop", null);
        report(stopError);
      }
    }
  }

  async function step() {
    for (const row of db
      .query<Row, []>(
        "SELECT id,payload,phase,result,started_at FROM retro_execution WHERE phase <> 'complete' ORDER BY rowid",
      )
      .all()) {
      if (closed) return;
      try {
        await advance(row);
      } catch (error) {
        journalCaught(error, "runner-retro-runtime.step.advance", null);
        report(error);
      }
    }
    if (closed) return;
    let commands: RunnerRetroCommand[];
    try {
      ({ commands } = await options.daemon.pollRetroCommands());
    } catch (error) {
      if (error instanceof RunnerRequestError && error.status === 404) {
        journalCaught(error, "runner-retro-runtime.step.poll", null, "Paws has no retro queue");
        return;
      }
      throw error;
    }
    for (const command of commands) {
      if (closed) return;
      const known = db
        .query<{ payload: string }, [string]>(
          "SELECT payload FROM retro_execution WHERE command_id=?",
        )
        .get(command.id);
      if (known) {
        if (known.payload !== JSON.stringify(command))
          throw new Error("Runner retro command changed");
        continue;
      }
      if (command.expiresAt <= now()) continue;
      await admit(command);
    }
  }

  return {
    status: () => ({
      active: db
        .query<{ id: string; command_id: string; phase: Phase }, []>(
          "SELECT id, command_id, phase FROM retro_execution WHERE phase <> 'complete' ORDER BY rowid",
        )
        .all()
        .map((row) => ({ executionId: row.id, commandId: row.command_id, phase: row.phase })),
    }),
    tick() {
      if (closed) return Promise.reject(new Error("Runner retro runtime is closed"));
      ticking ??= step().finally(() => {
        ticking = undefined;
      });
      return ticking;
    },
    async stop() {
      if (closed) return;
      closed = true;
      await Promise.allSettled([ticking]);
      for (const row of db
        .query<{ id: string }, []>(
          "SELECT id FROM retro_execution WHERE phase IN ('preparing','running')",
        )
        .all())
        await broker.stop(row.id).catch((error: unknown) => report(error));
      db.close();
    },
  };
}

export type RunnerRetroRuntime = Awaited<ReturnType<typeof openRunnerRetroRuntime>>;
