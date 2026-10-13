import { chmodSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { openDatabase } from "../db";
import { RunnerRequestError, type RunnerDaemon } from "../runner-daemon";
import {
  createRunnerBrokerClient,
  publishRunnerJob,
  readRunnerResultFile,
  type RunnerBrokerClient,
  type RunnerResults,
  type RunnerSpool,
} from "../runner-execution";
import {
  RunnerCommandSchema,
  RunnerHealthResultSchema,
  RunnerHelperResultSchema,
  type RunnerCommand,
  type RunnerHealthResult,
  type RunnerHelperResult,
} from "../runner-protocol";

type Command = Extract<RunnerCommand, { type: "probe" | "login_check" | "helper" }>;
type Entry = {
  id: string;
  command: Command;
  deadline: number;
  result?: RunnerHealthResult | RunnerHelperResult;
  stopped?: Promise<void>;
};
const worker = z.object({
  executionId: z.string(),
  commandId: z.string(),
  run: RunnerHealthResultSchema.omit({ executionId: true, commandId: true, login: true }).strip(),
  login: RunnerHealthResultSchema.shape.login.unwrap().strip().optional(),
});

const helperWorker = z.object({
  executionId: z.string(),
  commandId: z.string(),
  run: RunnerHelperResultSchema.omit({ executionId: true, commandId: true, text: true }).strip(),
  text: RunnerHelperResultSchema.shape.text,
});

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

export async function openRunnerHealthRuntime(options: {
  root: string;
  daemon: Pick<
    RunnerDaemon,
    | "status"
    | "pendingCommands"
    | "pollCommands"
    | "acknowledgeCommand"
    | "postHealth"
    | "heartbeat"
  > &
    Partial<Pick<RunnerDaemon, "pollHelperCommands" | "helperLease" | "postHelperResult">>;
  spool: RunnerSpool;
  results: RunnerResults;
  broker?: RunnerBrokerClient;
  now?: () => number;
  monotonic?: () => number;
  onError?: (error: Error) => void;
}) {
  if (!isAbsolute(options.root) || options.daemon.status().phase !== "paired")
    throw new Error("Paired runner and absolute health root are required");
  const info = statSync(options.root);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o700)
    throw new Error("Runner health root must be private");
  const path = join(options.root, "health.db");
  const db = openDatabase(path);
  chmodSync(path, 0o600);
  db.run(
    "CREATE TABLE IF NOT EXISTS health_execution(id TEXT PRIMARY KEY,command_id TEXT UNIQUE NOT NULL,payload TEXT NOT NULL,phase TEXT NOT NULL) STRICT",
  );
  if (
    !db
      .query<{ name: string }, []>("PRAGMA table_info(health_execution)")
      .all()
      .some((row) => row.name === "result")
  )
    db.run("ALTER TABLE health_execution ADD COLUMN result TEXT");
  const broker = options.broker ?? createRunnerBrokerClient();
  const now = options.now ?? Date.now;
  const monotonic = options.monotonic ?? (() => performance.now());
  let active: Entry | undefined;
  try {
    for (const row of db
      .query<{ id: string; payload: string; phase: string; result: string | null }, []>(
        "SELECT id,payload,phase,result FROM health_execution WHERE phase NOT IN ('complete','interrupted') ORDER BY rowid",
      )
      .all()) {
      await broker.stop(row.id);
      const command = RunnerCommandSchema.parse(JSON.parse(row.payload));
      if (
        row.phase === "publishing" &&
        command.type === "helper" &&
        row.result &&
        command.expiresAt > now()
      ) {
        if (active) throw new Error("Multiple runner helper receipts are unfinished");
        const result = RunnerHelperResultSchema.parse(JSON.parse(row.result));
        if (result.executionId !== row.id || result.commandId !== command.id)
          throw new Error("Runner helper receipt identity mismatch");
        active = { id: row.id, command, result, deadline: monotonic() + command.expiresAt - now() };
      } else db.run("UPDATE health_execution SET phase='interrupted' WHERE id=?", [row.id]);
    }
  } catch (error) {
    db.close();
    throw error;
  }
  let closed = false;
  let ticking: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let pulsing: Promise<void> | undefined;
  const report = () => options.onError?.(new Error("Runner health operation failed"));
  async function interrupt(entry: Entry) {
    entry.stopped ??= (async () => {
      await broker.stop(entry.id);
      db.run("UPDATE health_execution SET phase='interrupted' WHERE id=?", [entry.id]);
    })();
    await entry.stopped;
  }
  function check(entry: Entry) {
    if (
      closed ||
      entry.stopped ||
      now() >= entry.command.expiresAt ||
      monotonic() >= entry.deadline ||
      options.daemon.status().phase !== "paired"
    )
      throw new Error("Runner health command has expired");
  }
  function pulse() {
    if (pulsing) return pulsing;
    if (closed || !active) return Promise.resolve();
    const entry = active;
    const started = monotonic();
    pulsing = (async () => {
      if (entry.command.type === "helper") {
        if (!options.daemon.helperLease) throw new Error("Runner helper lease is unavailable");
        const lease = await options.daemon.helperLease(entry.command.id);
        if (lease.expiresAt !== entry.command.expiresAt)
          throw new Error("Runner helper lease changed");
      } else await options.daemon.heartbeat();
      check(entry);
      entry.deadline = Math.min(
        started + 60_000,
        monotonic() + Math.max(0, entry.command.expiresAt - now()),
      );
    })().finally(() => {
      pulsing = undefined;
    });
    return pulsing;
  }
  async function step(admit: boolean) {
    if (active?.stopped) {
      await active.stopped;
      active = undefined;
    }
    if (active) {
      const entry = active;
      try {
        check(entry);
        if (entry.command.type === "helper") await pulse();
        check(entry);
        if (!entry.result) {
          let raw: Buffer;
          try {
            raw = readRunnerResultFile(options.results, entry.id, "result.json");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
            throw error;
          }
          try {
            JSON.parse(raw.toString("utf8"));
          } catch {
            return;
          }
          await broker.stop(entry.id);
          check(entry);
          const payload = JSON.parse(
            readRunnerResultFile(options.results, entry.id, "result.json").toString("utf8"),
          );
          if (entry.command.type === "helper") {
            const result = helperWorker.parse(payload);
            if (result.executionId !== entry.id || result.commandId !== entry.command.id)
              throw new Error("Runner helper result identity mismatch");
            entry.result = RunnerHelperResultSchema.parse({
              ...result.run,
              executionId: entry.id,
              commandId: entry.command.id,
              text: result.text,
            });
            db.run("UPDATE health_execution SET phase='publishing',result=? WHERE id=?", [
              JSON.stringify(entry.result),
              entry.id,
            ]);
          } else {
            const result = worker.parse(payload);
            if (
              result.executionId !== entry.id ||
              result.commandId !== entry.command.id ||
              result.run.role !== "implementer"
            )
              throw new Error("Runner health result identity mismatch");
            if (
              (entry.command.type === "probe" && result.login) ||
              (entry.command.type === "login_check" && result.login?.agent !== entry.command.agent)
            )
              throw new Error("Runner health result does not match the command");
            entry.result = RunnerHealthResultSchema.parse({
              ...result.run,
              executionId: entry.id,
              commandId: entry.command.id,
              ...(result.login ? { login: result.login } : {}),
            });
          }
        }
        try {
          if (entry.command.type === "helper") {
            await pulse();
            check(entry);
            if (!options.daemon.postHelperResult)
              throw new Error("Runner helper result transport is unavailable");
            await options.daemon.postHelperResult(RunnerHelperResultSchema.parse(entry.result));
          } else await options.daemon.postHealth(RunnerHealthResultSchema.parse(entry.result));
        } catch (error) {
          if (error instanceof RunnerRequestError && [403, 409].includes(error.status)) throw error;
          report();
          return;
        }
        check(entry);
        db.run("UPDATE health_execution SET phase='complete' WHERE id=?", [entry.id]);
        active = undefined;
      } catch {
        await interrupt(entry);
        report();
      }
      return;
    }
    if (!admit || closed) return;
    await options.daemon.pollHelperCommands?.();
    await options.daemon.pollCommands();
    if (closed) return;
    for (const input of options.daemon.pendingCommands()) {
      if (input.type !== "probe" && input.type !== "login_check" && input.type !== "helper")
        continue;
      if (
        input.type === "helper" &&
        (!options.daemon.helperLease || !options.daemon.postHelperResult)
      )
        continue;
      const command = RunnerCommandSchema.parse(input) as Command;
      const previous = db
        .query<{ payload: string }, [string]>(
          "SELECT payload FROM health_execution WHERE command_id=?",
        )
        .get(command.id);
      if (previous) {
        if (previous.payload !== JSON.stringify(command))
          throw new Error("Runner health command changed");
        await options.daemon.acknowledgeCommand(command.id);
        continue;
      }
      if (command.expiresAt <= now()) {
        await options.daemon.acknowledgeCommand(command.id);
        continue;
      }
      const id = executionId(now());
      db.run(
        "INSERT INTO health_execution(id,command_id,payload,phase) VALUES(?,?,?,'preparing')",
        [id, command.id, JSON.stringify(command)],
      );
      const entry: Entry = {
        id,
        command,
        deadline: monotonic() + Math.min(60_000, command.expiresAt - now()),
      };
      active = entry;
      try {
        check(entry);
        if (command.type === "helper") await pulse();
        check(entry);
        publishRunnerJob(options.spool, { executionId: id, command });
        check(entry);
        const receipt = await broker.start(id);
        if (receipt.alreadyAdmitted)
          throw new Error("Runner execution identity was already consumed");
        check(entry);
        if (command.type === "helper") await pulse();
        check(entry);
        db.run("UPDATE health_execution SET phase='running' WHERE id=?", [id]);
        await options.daemon.acknowledgeCommand(command.id).catch(report);
      } catch {
        await interrupt(entry);
        report();
      }
      return;
    }
  }
  const heartbeat = setInterval(() => {
    const entry = active;
    void pulse()
      .catch(async () => {
        if (active === entry && entry?.command.type === "helper") await interrupt(entry);
        report();
      })
      .catch(report);
  }, 15_000);
  const watchdog = setInterval(() => {
    if (!active || active.stopped) return;
    try {
      check(active);
    } catch {
      void interrupt(active).catch(report);
    }
  }, 250);
  return {
    status: () => ({
      active: active ? { executionId: active.id, commandId: active.command.id } : null,
    }),
    tick(admit = true) {
      if (closed) return Promise.reject(new Error("Runner health runtime is closed"));
      ticking ??= step(admit).finally(() => {
        ticking = undefined;
      });
      return ticking;
    },
    stop() {
      stopping ??= (async () => {
        closed = true;
        clearInterval(watchdog);
        clearInterval(heartbeat);
        if (active) await interrupt(active);
        await Promise.allSettled([ticking, pulsing]);
        db.close();
      })();
      return stopping;
    },
  };
}
