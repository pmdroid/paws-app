import { journalCaught, journalRejection } from "../journal";
import { chmodSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { publishRunnerAnswer, removeRunnerAnswers } from "../runner-answers";
import { openDatabase } from "../db";
import { eq, notInArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { createHealthStore } from "./health-ddl";
import { healthExecution } from "./health-schema";
import { RunnerRequestError, type RunnerDaemon } from "../runner-daemon";
import {
  createDirectWorkerSupervisor,
  publishRunnerJob,
  readRunnerResultFile,
  type RunnerBrokerClient,
  type RunnerResults,
  type RunnerSpool,
} from "../runner-execution";
import type { RunnerAgentUser } from "../runner-protocol";
import {
  RunnerCommandSchema,
  RunnerLoginUpdateSchema,
  type RunnerLoginUpdate,
  RunnerHealthResultSchema,
  RunnerHelperResultSchema,
  type RunnerCommand,
  type RunnerHealthResult,
  type RunnerHelperResult,
} from "../runner-protocol";

type Command = Extract<RunnerCommand, { type: "probe" | "login_check" | "login" | "helper" }>;
type Entry = {
  unreachable?: boolean;
  renewedUntil?: number;
  id: string;
  command: Command;
  deadline: number;
  result?: RunnerHealthResult | RunnerHelperResult;
  login?: RunnerLoginUpdate;
  stopped?: Promise<void>;
  pulsing?: Promise<void>;
};
const conversation = (command: Pick<RunnerCommand, "type"> & { purpose?: string }) =>
  command.type === "helper" && command.purpose === "conversation";
const worker = z.object({
  executionId: z.string(),
  commandId: z.string(),
  run: RunnerHealthResultSchema.omit({ executionId: true, commandId: true, login: true }).strip(),
  login: RunnerHealthResultSchema.shape.login.unwrap().strip().optional(),
});

const helperWorker = z.object({
  executionId: z.string(),
  commandId: z.string(),
  run: RunnerHelperResultSchema.omit({
    executionId: true,
    commandId: true,
    text: true,
    replies: true,
    startWork: true,
  }).strip(),
  text: RunnerHelperResultSchema.shape.text,
  replies: RunnerHelperResultSchema.shape.replies,
  startWork: RunnerHelperResultSchema.shape.startWork,
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
    Partial<
      Pick<
        RunnerDaemon,
        "pollHelperCommands" | "helperLease" | "postHelperResult" | "exchangeLogin"
      >
    >;
  spool: RunnerSpool;
  results: RunnerResults;
  agentUser?: RunnerAgentUser;
  conversations?: () => number;
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
  createHealthStore(db);
  const q = drizzle(db);
  const setPhase = (id: string, phase: "running" | "interrupted" | "complete") =>
    q.update(healthExecution).set({ phase }).where(eq(healthExecution.id, id)).run();
  const markPublishing = (id: string, result: string) =>
    q
      .update(healthExecution)
      .set({ phase: "publishing", result })
      .where(eq(healthExecution.id, id))
      .run();
  const broker =
    options.broker ??
    createDirectWorkerSupervisor({
      stateRoot: join(options.root, "workers"),
      spool: options.spool,
      results: options.results,
      agentUser: options.agentUser,
    });
  const now = options.now ?? Date.now;
  const monotonic = options.monotonic ?? (() => performance.now());
  let active: Entry | undefined;
  const talks = new Map<string, Entry>();
  try {
    for (const row of q
      .select({
        id: healthExecution.id,
        payload: healthExecution.payload,
        phase: healthExecution.phase,
        result: healthExecution.result,
      })
      .from(healthExecution)
      .where(notInArray(healthExecution.phase, ["complete", "interrupted"]))
      .orderBy(sql`rowid`)
      .all()) {
      await broker.stop(row.id);
      const command = RunnerCommandSchema.parse(JSON.parse(row.payload));
      if (command.type === "login") removeRunnerAnswers(options.spool, row.id);
      if (command.type === "login" && command.expiresAt > now()) {
        if (active) throw new Error("Multiple runner receipts are unfinished");
        let update = row.result ? RunnerLoginUpdateSchema.parse(JSON.parse(row.result)) : null;
        if (!update) {
          try {
            update = readLogin(row.id);
          } catch (caughtError1) {
            journalCaught(
              caughtError1,
              "runner-health-runtime.openRunnerHealthRuntime.readLogin",
              null,
            );
            update = null;
          }
        }
        active = { id: row.id, command, deadline: monotonic() + command.expiresAt - now() };
        saveLogin(active, update?.state === "connected" ? "connected" : "failed");
      } else if (
        row.phase === "publishing" &&
        command.type === "helper" &&
        row.result &&
        command.expiresAt > now()
      ) {
        if (active && !conversation(command))
          throw new Error("Multiple runner helper receipts are unfinished");
        const result = RunnerHelperResultSchema.parse(JSON.parse(row.result));
        if (result.executionId !== row.id || result.commandId !== command.id)
          throw new Error("Runner helper receipt identity mismatch");
        const entry = {
          id: row.id,
          command,
          result,
          deadline: monotonic() + command.expiresAt - now(),
        };
        if (conversation(command)) talks.set(row.id, entry);
        else active = entry;
      } else setPhase(row.id, "interrupted");
    }
    await broker.sweep?.();
  } catch (error) {
    db.close();
    throw error;
  }
  let closed = false;
  let ticking: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  const report = (error?: unknown) =>
    options.onError?.(error instanceof Error ? error : new Error("Runner health operation failed"));
  function readLogin(id: string): RunnerLoginUpdate | null {
    let journal: string;
    try {
      journal = readRunnerResultFile(options.results, id, "events.jsonl").toString("utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        journalCaught(
          error,
          "runner-health-runtime.readLogin.toString",
          null,
          "optional file may be absent",
        );
        return null;
      }
      throw error;
    }
    const lines = journal.slice(0, journal.lastIndexOf("\n")).split("\n").filter(Boolean);
    if (!lines.length) return null;
    const event = JSON.parse(lines[lines.length - 1]!) as { type: string; update: unknown };
    if (event.type !== "login") throw new Error("Unexpected login event");
    return RunnerLoginUpdateSchema.parse(event.update);
  }
  function saveLogin(entry: Entry, state: "connected" | "failed") {
    entry.login = { state, terminal: "", authorization: null, inputId: null };
    markPublishing(entry.id, JSON.stringify(entry.login));
  }
  async function interrupt(entry: Entry) {
    entry.stopped ??= (async () => {
      await broker.stop(entry.id);
      if (entry.command.type === "login") {
        removeRunnerAnswers(options.spool, entry.id);
        if (entry.command.expiresAt > now()) {
          if (entry.login?.state !== "connected" && entry.login?.state !== "failed") {
            try {
              entry.login = readLogin(entry.id) ?? undefined;
            } catch (caughtError2) {
              journalCaught(caughtError2, "runner-health-runtime.interrupt.readLogin", null);
              entry.login = undefined;
            }
          }
          saveLogin(entry, entry.login?.state === "connected" ? "connected" : "failed");
          return;
        }
      }
      setPhase(entry.id, "interrupted");
    })();
    await entry.stopped;
  }
  function check(entry: Entry) {
    if (
      closed ||
      entry.stopped ||
      (entry.unreachable &&
      entry.command.type === "helper" &&
      entry.command.purpose === "conversation"
        ? now() >= (entry.renewedUntil ?? entry.command.expiresAt) + 300_000
        : now() >= (entry.renewedUntil ?? entry.command.expiresAt) ||
          monotonic() >= entry.deadline) ||
      options.daemon.status().phase !== "paired"
    )
      throw new Error("Runner health command has expired");
  }
  function pulse(entry: Entry | undefined = active) {
    if (entry?.pulsing) return entry.pulsing;
    if (closed || !entry) return Promise.resolve();
    const started = monotonic();
    entry.pulsing = (async () => {
      if (entry.command.type === "helper") {
        if (!options.daemon.helperLease) throw new Error("Runner helper lease is unavailable");
        const lease = await options.daemon.helperLease(entry.command.id);
        entry.renewedUntil = lease.expiresAt;
      } else await options.daemon.heartbeat();
      entry.unreachable = false;
      entry.deadline = Math.min(
        started + 60_000,
        monotonic() + Math.max(0, (entry.renewedUntil ?? entry.command.expiresAt) - now()),
      );
    })().finally(() => {
      entry.pulsing = undefined;
    });
    return entry.pulsing;
  }
  async function advance(entry: Entry): Promise<"released" | "finished" | "held"> {
    if (entry.stopped) {
      await entry.stopped;
      if (
        !closed &&
        entry.command.type === "login" &&
        entry.command.expiresAt > now() &&
        options.daemon.status().phase === "paired"
      ) {
        entry.stopped = undefined;
        entry.deadline = monotonic() + entry.command.expiresAt - now();
      } else return "released";
    }
    try {
      check(entry);
      if (entry.command.type === "helper") {
        try {
          await pulse(entry);
        } catch (error) {
          if (error instanceof RunnerRequestError && [401, 403, 409, 410].includes(error.status))
            throw error;
          entry.unreachable = true;
          check(entry);
          return "held";
        }
      }
      check(entry);
      if (entry.command.type === "login") {
        if (!options.daemon.exchangeLogin)
          throw new Error("Runner sign-in transport is unavailable");
        let update = entry.login ?? {
          state: "starting" as const,
          terminal: "",
          authorization: null,
          inputId: null,
        };
        if (update.state !== "connected" && update.state !== "failed")
          update = readLogin(entry.id) ?? update;
        if (entry.login?.inputId && entry.login.inputId !== update.inputId)
          removeRunnerAnswers(options.spool, entry.id);
        entry.login = update;
        if (update.state === "connected" || update.state === "failed") {
          saveLogin(entry, update.state);
          update = entry.login!;
          await broker.stop(entry.id);
        }
        check(entry);
        const reply = await options.daemon.exchangeLogin(entry.command.id, update);
        check(entry);
        if (reply.cancelled || update.state === "connected" || update.state === "failed") {
          await interrupt(entry);
          setPhase(entry.id, "complete");
          return "finished";
        } else if (reply.input) {
          if (reply.input.id !== update.inputId) throw new Error("Login input binding changed");
          publishRunnerAnswer(options.spool, entry.id, {
            requestId: reply.input.id,
            answer: JSON.stringify(reply.input.value),
          });
        }
        return "held";
      }
      if (!entry.result) {
        let raw: Buffer;
        try {
          raw = readRunnerResultFile(options.results, entry.id, "result.json");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            journalCaught(
              error,
              "runner-health-runtime.step.readRunnerResultFile",
              null,
              "optional file may be absent",
            );
            return "held";
          }
          throw error;
        }
        try {
          JSON.parse(raw.toString("utf8"));
        } catch (caughtError3) {
          journalCaught(caughtError3, "runner-health-runtime.step.parse", null);
          return "held";
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
            ...(entry.command.account ? { account: entry.command.account } : {}),
            text: result.text,
            ...(result.replies ? { replies: result.replies } : {}),
            ...(result.startWork ? { startWork: result.startWork } : {}),
          });
          markPublishing(entry.id, JSON.stringify(entry.result));
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
            ...(entry.command.account ? { account: entry.command.account } : {}),
            ...(result.login ? { login: result.login } : {}),
          });
        }
      }
      try {
        if (entry.command.type === "helper") {
          await pulse(entry);
          check(entry);
          if (!options.daemon.postHelperResult)
            throw new Error("Runner helper result transport is unavailable");
          await options.daemon.postHelperResult(RunnerHelperResultSchema.parse(entry.result));
        } else await options.daemon.postHealth(RunnerHealthResultSchema.parse(entry.result));
      } catch (error) {
        if (error instanceof RunnerRequestError && [403, 409].includes(error.status)) throw error;
        journalCaught(error, "runner-health-runtime.step.pulse", null);
        report();
        return "held";
      }
      check(entry);
      setPhase(entry.id, "complete");
      return "finished";
    } catch (caughtError4) {
      journalCaught(caughtError4, "runner-health-runtime.step.check", null);
      await interrupt(entry);
      report();
    }
    return "held";
  }
  async function step(admit: boolean) {
    for (const entry of [...talks.values()])
      if ((await advance(entry)) !== "held") talks.delete(entry.id);
    let slot = true;
    if (active) {
      const outcome = await advance(active);
      if (outcome !== "held") active = undefined;
      slot = outcome === "released";
    }
    const room = talks.size < (options.conversations?.() ?? 0);
    if (!admit || closed || (!slot && !room)) return;
    await options.daemon.pollHelperCommands?.();
    if (slot) await options.daemon.pollCommands();
    if (closed) return;
    for (const input of options.daemon.pendingCommands()) {
      if (
        input.type !== "probe" &&
        input.type !== "login_check" &&
        input.type !== "login" &&
        input.type !== "helper"
      )
        continue;
      const talk = conversation(input);
      if (talk ? !room : !slot) continue;
      if (
        input.type === "helper" &&
        (!options.daemon.helperLease || !options.daemon.postHelperResult)
      )
        continue;
      if (input.type === "login" && !options.daemon.exchangeLogin) continue;
      const command = RunnerCommandSchema.parse(input) as Command;
      const previous = q
        .select({ payload: healthExecution.payload })
        .from(healthExecution)
        .where(eq(healthExecution.commandId, command.id))
        .get();
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
      q.insert(healthExecution)
        .values({ id, commandId: command.id, payload: JSON.stringify(command), phase: "preparing" })
        .run();
      const entry: Entry = {
        id,
        command,
        deadline:
          monotonic() +
          Math.min(command.type === "login" ? 600_000 : 60_000, command.expiresAt - now()),
      };
      if (talk) talks.set(id, entry);
      else active = entry;
      try {
        check(entry);
        if (command.type === "helper") await pulse(entry);
        check(entry);
        if (command.type === "login") {
          const reply = await options.daemon.exchangeLogin!(command.id, {
            state: "starting",
            terminal: "",
            authorization: null,
            inputId: null,
          });
          if (reply.cancelled) throw new Error("Login was cancelled");
          check(entry);
        }
        publishRunnerJob(options.spool, { executionId: id, command });
        check(entry);
        const receipt = await broker.start(id);
        if (receipt.alreadyAdmitted)
          throw new Error("Runner execution identity was already consumed");
        check(entry);
        if (command.type === "helper") await pulse(entry);
        check(entry);
        setPhase(id, "running");
        await options.daemon
          .acknowledgeCommand(command.id)
          .catch(journalRejection("runner-health-runtime.step.acknowledgeCommand", report, null));
      } catch (caughtError5) {
        journalCaught(caughtError5, "runner-health-runtime.step.check", null);
        await interrupt(entry);
        report();
      }
      return;
    }
  }
  const entries = () => [...(active ? [active] : []), ...talks.values()];
  const heartbeat = setInterval(() => {
    for (const entry of entries())
      void pulse(entry)
        .catch(async (caughtError6) => {
          journalCaught(caughtError6, "runner-health-runtime.openRunnerHealthRuntime.pulse", null);
          if (
            entry.command.type === "helper" &&
            entry.command.purpose === "conversation" &&
            !(
              caughtError6 instanceof RunnerRequestError &&
              [401, 403, 409, 410].includes(caughtError6.status)
            )
          ) {
            entry.unreachable = true;
            return;
          }
          if (
            (active === entry || talks.get(entry.id) === entry) &&
            entry.command.type === "helper"
          )
            await interrupt(entry);
          report();
        })
        .catch(
          journalRejection("runner-health-runtime.openRunnerHealthRuntime.catch", report, null),
        );
  }, 15_000);
  const watchdog = setInterval(() => {
    for (const entry of entries()) {
      if (entry.stopped) continue;
      try {
        check(entry);
      } catch (caughtError7) {
        journalCaught(caughtError7, "runner-health-runtime.openRunnerHealthRuntime.check", null);
        void interrupt(entry).catch(
          journalRejection("runner-health-runtime.openRunnerHealthRuntime.interrupt", report, null),
        );
      }
    }
  }, 250);
  return {
    holds: () =>
      [...(active ? [active] : []), ...talks.values()].flatMap(({ id, command }) => [
        id,
        ...(command.type === "helper" && command.conversation ? [command.conversation.runId] : []),
      ]),
    status: () => ({
      active: active ? { executionId: active.id, commandId: active.command.id } : null,
      conversations: [...talks.values()].map((entry) => ({
        executionId: entry.id,
        commandId: entry.command.id,
      })),
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
        const held = entries();
        await Promise.all(held.map((entry) => interrupt(entry)));
        await Promise.allSettled([ticking, ...held.map((entry) => entry.pulsing)]);
        db.close();
      })();
      return stopping;
    },
  };
}
