import { journalCaught, journalRejection } from "../journal";
import { chmodSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { openDatabase, readRunnerToolRequests, type RunnerToolRequest } from "../runner-journal";
import { publishRunnerAnswer } from "../runner-answers";
import { eq, notInArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { createHealthStore } from "./health-ddl";
import { healthExecution } from "./health-schema";
import { RunnerRequestError, type RunnerDaemon } from "../runner-daemon";
import {
  createDirectWorkerSupervisor,
  publishRunnerJob,
  readRunnerCredentials,
  readRunnerResultFile,
  type RunnerBrokerClient,
  type RunnerResults,
  type RunnerSpool,
} from "../runner-execution";
import type { RunnerAgentUser } from "../runner-protocol";
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
  unreachable?: boolean;
  renewedUntil?: number;
  id: string;
  command: Command;
  deadline: number;
  result?: RunnerHealthResult | RunnerHelperResult;
  stopped?: Promise<void>;
  pulsing?: Promise<void>;
  tools?: {
    offset: number;
    queue: RunnerToolRequest[];
    answered: Set<string>;
    failed: Set<string>;
    forwarding?: Promise<void>;
    timer?: ReturnType<typeof setInterval>;
  };
};
const unanswered = { text: "Paws could not answer that tool.", isError: true };
const conversation = (command: Pick<RunnerCommand, "type"> & { purpose?: string }) =>
  command.type === "helper" &&
  (command.purpose === "conversation" || command.purpose === "slack_reply");
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
        | "pollHelperCommands"
        | "helperLease"
        | "helperRequest"
        | "postHelperResult"
        | "carriesCredential"
        | "credentialRecipient"
        | "restoreCredentials"
        | "returnCredentials"
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
      restoreCredentials: (id) => options.daemon.restoreCredentials?.(id),
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
      const parsed = RunnerCommandSchema.safeParse(JSON.parse(row.payload));
      if (!parsed.success) {
        setPhase(row.id, "interrupted");
        continue;
      }
      const command = parsed.data;
      if (
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
  function returnCredentials(entry: Entry) {
    const { id } = entry.command;
    if (!options.daemon.returnCredentials || !options.daemon.carriesCredential?.(id)) return;
    options.daemon.returnCredentials(
      id,
      entry.id,
      readRunnerCredentials(options.results, entry.id),
    );
  }
  async function forward(entry: Entry) {
    const tools = entry.tools;
    if (!tools || entry.command.type !== "helper" || !options.daemon.helperRequest) return;
    let raw: Buffer;
    try {
      raw = readRunnerResultFile(options.results, entry.id, "events.jsonl");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return;
    }
    const read = readRunnerToolRequests(raw, tools.offset);
    tools.offset = read.offset;
    tools.queue.push(...read.requests);
    for (const request of tools.queue.splice(0)) {
      if (tools.answered.has(request.requestId) || closed || entry.stopped || entry.result)
        continue;
      let answer: { text: string; isError?: boolean };
      try {
        answer = await options.daemon.helperRequest(entry.command.id, request);
      } catch (error) {
        journalCaught(error, "runner-health-runtime.forward.helperRequest", null);
        const final = error instanceof RunnerRequestError && error.status < 500;
        if (!final && !tools.failed.has(request.requestId)) {
          tools.failed.add(request.requestId);
          tools.queue.push(request);
          continue;
        }
        answer = unanswered;
      }
      tools.answered.add(request.requestId);
      publishRunnerAnswer(options.spool, entry.id, {
        requestId: request.requestId,
        answer: JSON.stringify(
          answer.isError ? { text: answer.text, isError: true } : { text: answer.text },
        ),
      });
    }
  }
  function forwarding(entry: Entry) {
    const tools = entry.tools;
    if (!tools || tools.forwarding) return;
    if (closed || entry.stopped || entry.result) {
      clearInterval(tools.timer);
      return;
    }
    tools.forwarding = forward(entry)
      .catch(journalRejection("runner-health-runtime.forwarding", report, null))
      .finally(() => {
        tools.forwarding = undefined;
      });
  }
  async function interrupt(entry: Entry) {
    clearInterval(entry.tools?.timer);
    entry.stopped ??= (async () => {
      await broker.stop(entry.id);
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
      return "released";
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
        returnCredentials(entry);
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
      if (input.type !== "probe" && input.type !== "login_check" && input.type !== "helper")
        continue;
      const talk = conversation(input);
      if (talk ? !room : !slot) continue;
      if (
        input.type === "helper" &&
        (!options.daemon.helperLease || !options.daemon.postHelperResult)
      )
        continue;
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
        deadline: monotonic() + Math.min(60_000, command.expiresAt - now()),
      };
      if (talk) talks.set(id, entry);
      else active = entry;
      try {
        check(entry);
        if (command.type === "helper") await pulse(entry);
        check(entry);
        options.daemon.restoreCredentials?.(command.id);
        publishRunnerJob(options.spool, {
          executionId: id,
          command,
          ...(options.daemon.credentialRecipient && options.daemon.carriesCredential?.(command.id)
            ? { credentials: { certificate: options.daemon.credentialRecipient() } }
            : {}),
        });
        check(entry);
        const receipt = await broker.start(id);
        if (receipt.alreadyAdmitted)
          throw new Error("Runner execution identity was already consumed");
        check(entry);
        if (command.type === "helper") await pulse(entry);
        check(entry);
        setPhase(id, "running");
        if (command.type === "helper" && command.tools && options.daemon.helperRequest) {
          entry.tools = { offset: 0, queue: [], answered: new Set(), failed: new Set() };
          entry.tools.timer = setInterval(() => forwarding(entry), 250);
        }
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
        await Promise.allSettled([
          ticking,
          ...held.flatMap((entry) => [entry.pulsing, entry.tools?.forwarding]),
        ]);
        db.close();
      })();
      return stopping;
    },
  };
}
