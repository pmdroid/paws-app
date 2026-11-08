import { randomBytes, createHash } from "node:crypto";
import { chmodSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Changes } from "bun:sqlite";
import { and, eq, gt, gte, inArray, isNull, lt, ne, notExists, notInArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { openDatabase, immediate } from "../db";
import {
  RunnerArtifactSchema,
  RunnerActivitySchema,
  RunnerPermissionSchema,
  RunnerCommandSchema,
  RunnerEventSchema,
  RunnerResultSchema,
  type RunnerResult,
  type RunnerCommand,
  withoutJournalTime,
} from "../runner-protocol";
import { ddl } from "./ddl";
import { cleanup, delivery, execution, publication, resultDelivery, termination } from "./schema";

export type WorkCommand = Extract<RunnerCommand, { type: "run" | "review" | "task" }>;
export type Execution = { id: string; command: WorkCommand; phase: string };
const artifact = z.strictObject({
  type: z.literal("artifact"),
  requestId: z.uuid(),
  artifact: RunnerArtifactSchema,
});
const question = z.strictObject({
  type: z.literal("question"),
  requestId: z.uuid(),
  question: z.string().min(1).max(16_384),
  context: z.string().min(1).max(16_384).optional(),
  options: z
    .array(
      z.union([
        z.string().max(256),
        z.strictObject({
          label: z.string().min(1).max(256).optional(),
          value: z.string().min(1).max(256),
        }),
      ]),
    )
    .max(16),
});

const policyRequest = z.strictObject({
  type: z.literal("closeout_policy"),
  requestId: z.uuid(),
  offset: z
    .number()
    .int()
    .min(0)
    .max(8 * 1024 * 1024)
    .optional(),
  hash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});

const ciRerunRequest = z.strictObject({
  type: z.literal("ci_rerun"),
  requestId: z.uuid(),
  reason: z.string().min(1).max(2000),
});

function executionId(now: number): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  let value = BigInt(`0x${bytes.toString("hex")}`);
  let result = "";
  for (let i = 0; i < 26; i++) {
    result = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[Number(value & 31n)] + result;
    value >>= 5n;
  }
  return result;
}

export type TerminalExecution = {
  id: string;
  command: { id: string; runId: string; generation: number; itemId: string };
};

type TerminalRow = {
  id: string;
  commandId: string;
  runId: string;
  generation: number;
  itemId: string;
};
const TERMINAL_PHASES = ["complete", "interrupted"];
// Read only the identifiers, so an execution an older release journaled still lists.
const payloadRunId = sql<string>`json_extract(${execution.payload},'$.runId')`;
const payloadGeneration = sql<number>`json_extract(${execution.payload},'$.generation')`;
const terminalColumns = {
  id: execution.id,
  commandId: execution.commandId,
  runId: payloadRunId,
  generation: payloadGeneration,
  itemId: sql<string>`json_extract(${execution.payload},'$.itemId')`,
};
const awaitsAnswer = sql`json_extract(${delivery.payload},'$.type') IN ('question','artifact','closeout_policy','ci_rerun')`;
const one = { one: sql`1` };

function rowid(table: SQLiteTable) {
  return sql`${table}.rowid`;
}

function changes(query: { run(): unknown }): number {
  return (query.run() as Changes).changes;
}

function terminalExecution({ id, commandId, runId, generation, itemId }: TerminalRow) {
  return { id, command: { id: commandId, runId, generation, itemId } } satisfies TerminalExecution;
}

export function openExecutionJournal(root: string) {
  if (!isAbsolute(root)) throw new Error("Execution journal root must be absolute");
  const info = statSync(root);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o700)
    throw new Error("Execution journal root must be private");
  const path = join(root, "executions.db");
  const db = openDatabase(path);
  chmodSync(path, 0o600);
  ddl(db);
  const orm = drizzle(db);
  // Recover a crash between recording Paws's decision and changing the execution phase.
  orm
    .update(execution)
    .set({
      phase: sql`(SELECT CASE WHEN ${resultDelivery.accepted}=1 AND ${resultDelivery.failure}=0 THEN 'complete' ELSE 'interrupted' END FROM ${resultDelivery} WHERE ${resultDelivery.executionId}=${execution.id})`,
    })
    .where(
      and(
        notInArray(execution.phase, TERMINAL_PHASES),
        inArray(
          execution.id,
          orm
            .select({ id: resultDelivery.executionId })
            .from(resultDelivery)
            .where(ne(resultDelivery.accepted, 0)),
        ),
      ),
    )
    .run();
  const unterminated = notExists(
    orm.select(one).from(termination).where(eq(termination.commandId, execution.commandId)),
  );
  function parseExecution(row: { id: string; payload: string; phase: string }) {
    const parsed = RunnerCommandSchema.safeParse(JSON.parse(row.payload));
    if (!parsed.success) return undefined;
    const command = parsed.data;
    if (command.type !== "run" && command.type !== "review" && command.type !== "task")
      throw new Error("Invalid persisted work command");
    return { id: row.id, command, phase: row.phase } satisfies Execution;
  }
  const executionColumns = { id: execution.id, payload: execution.payload, phase: execution.phase };
  function readExecution(id: string): Execution | undefined {
    const row = orm.select(executionColumns).from(execution).where(eq(execution.id, id)).get();
    return row ? parseExecution(row) : undefined;
  }
  function executions(active: boolean): Execution[] {
    return orm
      .select(executionColumns)
      .from(execution)
      .where(
        active
          ? notInArray(execution.phase, TERMINAL_PHASES)
          : inArray(execution.phase, TERMINAL_PHASES),
      )
      .orderBy(rowid(execution))
      .all()
      .flatMap((row) => parseExecution(row) ?? []);
  }
  function storedPublication(id: string) {
    const row = orm
      .select({
        payload: publication.payload,
        lease: publication.lease,
        publishedSha: publication.publishedSha,
        refused: publication.refused,
      })
      .from(publication)
      .where(eq(publication.executionId, id))
      .get();
    return (
      row && {
        result: RunnerResultSchema.parse(JSON.parse(row.payload)),
        ...(row.lease === null ? {} : { lease: row.lease }),
        ...(row.publishedSha === null ? {} : { publishedSha: row.publishedSha }),
        ...(row.refused === null ? {} : { refused: row.refused }),
      }
    );
  }
  function unsentArtifactPayload(id: string, sequence: number) {
    return orm
      .select({ payload: delivery.payload })
      .from(delivery)
      .where(
        and(eq(delivery.executionId, id), eq(delivery.sequence, sequence), eq(delivery.sent, 0)),
      )
      .get();
  }
  function replaceUnsent(id: string, sequence: number, payload: string) {
    orm
      .update(delivery)
      .set({ payload })
      .where(
        and(eq(delivery.executionId, id), eq(delivery.sequence, sequence), eq(delivery.sent, 0)),
      )
      .run();
  }
  return {
    executions,
    execution: readExecution,
    publication: storedPublication,
    // Older releases could mark an execution interrupted before its broker stopped.
    // Reconcile those rows through the same broker contract on upgrade.
    unconfirmedTerminations(): TerminalExecution[] {
      return orm
        .select(terminalColumns)
        .from(execution)
        .where(and(inArray(execution.phase, TERMINAL_PHASES), unterminated))
        .orderBy(rowid(execution))
        .all()
        .map(terminalExecution);
    },
    unreadableExecutions(): TerminalExecution[] {
      return orm
        .select({ ...terminalColumns, payload: execution.payload, phase: execution.phase })
        .from(execution)
        .where(and(notInArray(execution.phase, TERMINAL_PHASES), unterminated))
        .orderBy(rowid(execution))
        .all()
        .filter((row) => !parseExecution(row))
        .map(terminalExecution);
    },
    terminationPending(runId: string, generation: number) {
      return (
        orm
          .select(one)
          .from(execution)
          .where(and(eq(payloadRunId, runId), eq(payloadGeneration, generation), unterminated))
          .limit(1)
          .get() !== undefined
      );
    },
    confirmTermination(command: { id: string; runId: string; generation: number }) {
      // A row from an older release can lack these fields. OR IGNORE skips its NOT NULL failure,
      // which the builder's ON CONFLICT DO NOTHING would raise.
      orm.run(
        sql`INSERT OR IGNORE INTO ${termination}(command_id,run_id,generation) VALUES(${command.id},${command.runId},${command.generation})`,
      );
    },
    cleanupStarted(id: string, at: number) {
      orm.insert(cleanup).values({ executionId: id, startedAt: at }).onConflictDoNothing().run();
    },
    cleanupFailed(id: string, failure: string, at: number) {
      return orm
        .insert(cleanup)
        .values({
          executionId: id,
          startedAt: at,
          failures: 1,
          failure: failure.slice(0, 1024),
          failedAt: at,
        })
        .onConflictDoUpdate({
          target: cleanup.executionId,
          set: {
            failures: sql`${cleanup.failures}+1`,
            failure: sql`excluded.failure`,
            failedAt: sql`excluded.failed_at`,
          },
        })
        .returning({ failures: cleanup.failures })
        .get().failures;
    },
    cleanupDone(id: string) {
      return (
        orm
          .delete(cleanup)
          .where(eq(cleanup.executionId, id))
          .returning({ failures: cleanup.failures })
          .get()?.failures ?? 0
      );
    },
    cleanups() {
      return orm
        .select({
          executionId: cleanup.executionId,
          phase: execution.phase,
          since: cleanup.startedAt,
          failures: cleanup.failures,
          failure: cleanup.failure,
          failedAt: cleanup.failedAt,
          runId: payloadRunId,
          generation: payloadGeneration,
          commandId: execution.commandId,
        })
        .from(cleanup)
        .innerJoin(execution, eq(execution.id, cleanup.executionId))
        .orderBy(rowid(cleanup))
        .all();
    },
    pendingTerminations() {
      return orm
        .select({
          runId: termination.runId,
          generation: termination.generation,
          commandId: termination.commandId,
        })
        .from(termination)
        .where(eq(termination.reported, 0))
        .orderBy(rowid(termination))
        .limit(64)
        .all();
    },
    terminationReported(entry: { runId: string; generation: number; commandId: string }) {
      orm
        .update(termination)
        .set({ reported: 1 })
        .where(
          and(
            eq(termination.commandId, entry.commandId),
            eq(termination.runId, entry.runId),
            eq(termination.generation, entry.generation),
          ),
        )
        .run();
    },
    transcriptSealed(id: string) {
      return Boolean(
        orm
          .select({ sealed: execution.transcriptSealed })
          .from(execution)
          .where(eq(execution.id, id))
          .get()?.sealed,
      );
    },
    sealTranscript(id: string) {
      orm.update(execution).set({ transcriptSealed: 1 }).where(eq(execution.id, id)).run();
    },
    resultRejected(id: string) {
      orm
        .update(resultDelivery)
        .set({ accepted: 2 })
        .where(eq(resultDelivery.executionId, id))
        .run();
    },
    resultUndeliverable(id: string, reason: string) {
      orm
        .update(resultDelivery)
        .set({ accepted: 3, refused: reason.slice(0, 4096) })
        .where(and(eq(resultDelivery.executionId, id), eq(resultDelivery.accepted, 0)))
        .run();
    },
    undeliverableResults() {
      return orm
        .select({
          id: resultDelivery.executionId,
          runId: payloadRunId,
          generation: payloadGeneration,
          reason: sql<string>`${resultDelivery.refused}`,
          payload: resultDelivery.payload,
        })
        .from(resultDelivery)
        .innerJoin(execution, eq(execution.id, resultDelivery.executionId))
        .where(eq(resultDelivery.accepted, 3))
        .orderBy(rowid(resultDelivery))
        .all()
        .map(({ payload, ...row }) => ({
          ...row,
          result: RunnerResultSchema.parse(JSON.parse(payload)),
        }));
    },
    saveResult(id: string, result: RunnerResult, failure = false) {
      orm
        .insert(resultDelivery)
        .values({
          executionId: id,
          payload: JSON.stringify(RunnerResultSchema.parse(result)),
          failure: Number(failure),
        })
        .onConflictDoNothing()
        .run();
    },
    beginPublication(id: string, result: RunnerResult, lease?: string) {
      immediate(db, () => {
        orm
          .insert(publication)
          .values({
            executionId: id,
            payload: JSON.stringify(RunnerResultSchema.parse(result)),
            lease: lease ?? null,
          })
          .onConflictDoNothing()
          .run();
        orm
          .update(execution)
          .set({ phase: "publishing" })
          .where(and(eq(execution.id, id), notInArray(execution.phase, TERMINAL_PHASES)))
          .run();
      });
      return storedPublication(id)!;
    },
    published(id: string, sha: string) {
      if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Runner published commit is invalid");
      orm
        .update(publication)
        .set({ publishedSha: sha })
        .where(and(eq(publication.executionId, id), isNull(publication.refused)))
        .run();
    },
    refusePublication(id: string, reason: string) {
      orm
        .update(publication)
        .set({ refused: reason.slice(0, 4096) })
        .where(and(eq(publication.executionId, id), isNull(publication.refused)))
        .run();
    },
    pendingResults() {
      return orm
        .select({
          id: resultDelivery.executionId,
          runId: payloadRunId,
          generation: payloadGeneration,
        })
        .from(resultDelivery)
        .innerJoin(execution, eq(execution.id, resultDelivery.executionId))
        .where(eq(resultDelivery.accepted, 0))
        .orderBy(rowid(resultDelivery))
        .all();
    },
    pendingResult(id: string) {
      const row = orm
        .select({ payload: resultDelivery.payload, failure: resultDelivery.failure })
        .from(resultDelivery)
        .where(and(eq(resultDelivery.executionId, id), eq(resultDelivery.accepted, 0)))
        .get();
      return (
        row && {
          result: RunnerResultSchema.parse(JSON.parse(row.payload)),
          failure: Boolean(row.failure),
        }
      );
    },
    resultPending(id: string) {
      return Boolean(
        orm
          .select(one)
          .from(resultDelivery)
          .where(and(eq(resultDelivery.executionId, id), eq(resultDelivery.accepted, 0)))
          .get(),
      );
    },
    resultAccepted(id: string) {
      orm
        .update(resultDelivery)
        .set({ accepted: 1 })
        .where(eq(resultDelivery.executionId, id))
        .run();
    },
    hasResult(id: string) {
      return Boolean(
        orm.select(one).from(resultDelivery).where(eq(resultDelivery.executionId, id)).get(),
      );
    },
    waiting(id: string) {
      return Boolean(
        orm
          .select(one)
          .from(delivery)
          .innerJoin(execution, eq(execution.id, delivery.executionId))
          .where(
            and(eq(execution.id, id), gt(delivery.sequence, execution.answerCursor), awaitsAnswer),
          )
          .limit(1)
          .get(),
      );
    },
    admit(command: WorkCommand, now: number): Execution | null {
      const parsed = RunnerCommandSchema.parse(command);
      if (parsed.type !== "run" && parsed.type !== "review" && parsed.type !== "task")
        throw new Error("Work command is required");
      if (
        orm
          .select(one)
          .from(termination)
          .where(
            and(
              eq(termination.runId, command.runId),
              eq(termination.generation, command.generation),
            ),
          )
          .limit(1)
          .get()
      )
        return null;
      const existing = orm
        .select({ payload: execution.payload })
        .from(execution)
        .where(eq(execution.commandId, command.id))
        .get();
      if (existing) {
        if (existing.payload !== JSON.stringify(parsed))
          throw new Error("Persisted command changed");
        return null;
      }
      const id = executionId(now);
      orm
        .insert(execution)
        .values({ id, commandId: command.id, payload: JSON.stringify(parsed), phase: "preparing" })
        .run();
      return { id, command: parsed, phase: "preparing" };
    },
    phase(id: string, phase: "running" | "publishing" | "cleaning" | "complete" | "interrupted") {
      return (
        changes(
          orm
            .update(execution)
            .set({ phase })
            .where(and(eq(execution.id, id), notInArray(execution.phase, TERMINAL_PHASES))),
        ) === 1
      );
    },
    ingest(id: string, bytes: Buffer) {
      if (bytes.length > 16_777_216) throw new Error("Runner event journal exceeds size limit");
      immediate(db, () => {
        const row = orm
          .select({
            consumed: execution.consumed,
            prefixHash: execution.prefixHash,
            phase: execution.phase,
          })
          .from(execution)
          .where(eq(execution.id, id))
          .get();
        if (!row) throw new Error("Unknown execution journal");
        const terminal = row.phase === "complete" || row.phase === "interrupted";
        if (terminal && (bytes.length < row.consumed || bytes.indexOf(10, row.consumed) !== -1))
          throw new Error("Execution journal is terminal");
        if (
          bytes.length < row.consumed ||
          (row.consumed > 0 &&
            createHash("sha256").update(bytes.subarray(0, row.consumed)).digest("hex") !==
              row.prefixHash)
        )
          throw new Error("Runner event journal was rewritten");
        // Result replay still validates the consumed prefix of a terminal execution.
        if (terminal) return;
        let offset = row.consumed;
        let sequence = orm
          .select({ sequence: sql<number>`COALESCE(MAX(${delivery.sequence}),0)` })
          .from(delivery)
          .where(eq(delivery.executionId, id))
          .get()!.sequence;
        let message = "";
        function append(event: z.infer<typeof RunnerEventSchema>, requestId: string | null = null) {
          orm
            .insert(delivery)
            .values({
              executionId: id,
              sequence: ++sequence,
              payload: JSON.stringify(RunnerEventSchema.parse(event)),
              requestId,
            })
            .run();
        }
        function flushMessage() {
          if (!message) return;
          append({
            type: "activity",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: message },
            },
          });
          message = "";
        }
        while (offset < bytes.length) {
          const end = bytes.indexOf(10, offset);
          if (end < 0) break;
          if (end - offset > 262_144) throw new Error("Runner journal record exceeds limit");
          const raw = withoutJournalTime(JSON.parse(bytes.subarray(offset, end).toString("utf8")));
          let event: z.infer<typeof RunnerEventSchema> | undefined;
          let requestId: string | null = null;
          const q = question.safeParse(raw);
          const artifactRequest = artifact.safeParse(raw);
          const policy = policyRequest.safeParse(raw);
          const ciRerun = ciRerunRequest.safeParse(raw);
          if (ciRerun.success) {
            event = { type: "ci_rerun", reason: ciRerun.data.reason };
            requestId = ciRerun.data.requestId;
          } else if (policy.success) {
            event = {
              type: "closeout_policy",
              ...(policy.data.offset === undefined ? {} : { offset: policy.data.offset }),
              ...(policy.data.hash === undefined ? {} : { hash: policy.data.hash }),
            };
            requestId = policy.data.requestId;
          } else if (artifactRequest.success) {
            if (artifactRequest.data.requestId !== artifactRequest.data.artifact.id)
              throw new Error("Artifact request binding changed");
            event = { type: "artifact", artifact: artifactRequest.data.artifact };
            requestId = artifactRequest.data.requestId;
          } else if (q.success) {
            event = {
              type: "question",
              text: q.data.question,
              ...(q.data.context === undefined ? {} : { context: q.data.context }),
              options: q.data.options,
            };
            requestId = q.data.requestId;
          } else {
            if (raw && typeof raw === "object" && "type" in raw && raw.type === "plan") {
              const parsed = RunnerEventSchema.safeParse(raw);
              if (!parsed.success || parsed.data.type !== "plan")
                throw new Error("Invalid runner plan");
              event = parsed.data;
            } else if (
              raw &&
              typeof raw === "object" &&
              "type" in raw &&
              raw.type === "pull_request"
            ) {
              const parsed = RunnerEventSchema.safeParse(raw);
              if (!parsed.success || parsed.data.type !== "pull_request")
                throw new Error("Invalid runner pull request");
              event = parsed.data;
            } else if (raw && typeof raw === "object" && "type" in raw && raw.type === "closeout") {
              const parsed = RunnerEventSchema.safeParse(raw);
              if (!parsed.success || parsed.data.type !== "closeout")
                throw new Error("Invalid runner Closeout progress");
              event = parsed.data;
            } else if (
              raw &&
              typeof raw === "object" &&
              "type" in raw &&
              raw.type === "hook_failed"
            ) {
              const parsed = RunnerEventSchema.safeParse(raw);
              if (!parsed.success || parsed.data.type !== "hook_failed")
                throw new Error("Invalid runner hook failure");
              event = parsed.data;
            } else if (raw && typeof raw === "object" && "type" in raw && raw.type === "reply") {
              const parsed = RunnerEventSchema.safeParse(raw);
              if (!parsed.success || parsed.data.type !== "reply")
                throw new Error("Invalid runner reply");
              event = parsed.data;
            } else if (raw && typeof raw === "object" && "type" in raw && raw.type === "preview") {
              const parsed = RunnerEventSchema.safeParse(raw);
              if (!parsed.success || parsed.data.type !== "preview")
                throw new Error("Invalid runner preview");
              event = parsed.data;
            } else if (raw && typeof raw === "object" && "type" in raw && raw.type === "progress") {
              const parsed = RunnerEventSchema.safeParse(raw);
              if (!parsed.success || parsed.data.type !== "progress")
                throw new Error("Invalid runner progress");
              event = parsed.data;
            } else if (
              raw &&
              typeof raw === "object" &&
              "type" in raw &&
              raw.type === "session_restore"
            ) {
              const parsed = RunnerEventSchema.safeParse(raw);
              if (!parsed.success || parsed.data.type !== "session_restore")
                throw new Error("Invalid runner session restore");
              event = parsed.data;
            } else if (
              raw &&
              typeof raw === "object" &&
              "type" in raw &&
              (raw.type === "handover" || raw.type === "handover_interrupted")
            ) {
              const parsed = RunnerEventSchema.safeParse(raw);
              if (
                !parsed.success ||
                (parsed.data.type !== "handover" && parsed.data.type !== "handover_interrupted")
              )
                throw new Error("Invalid runner handover");
              event = parsed.data;
            } else if (
              raw &&
              typeof raw === "object" &&
              "type" in raw &&
              (raw.type === "agent_wait_started" || raw.type === "agent_wait_ended")
            ) {
              const parsed = RunnerEventSchema.safeParse(raw);
              if (
                !parsed.success ||
                (parsed.data.type !== "agent_wait_started" &&
                  parsed.data.type !== "agent_wait_ended")
              )
                throw new Error("Invalid runner agent wait");
              event = parsed.data;
            } else if (
              raw &&
              typeof raw === "object" &&
              "type" in raw &&
              raw.type === "checkpoint"
            ) {
              const parsed = RunnerEventSchema.safeParse(raw);
              if (!parsed.success || parsed.data.type !== "checkpoint" || parsed.data.dropped)
                throw new Error("Invalid runner checkpoint");
              event = parsed.data;
            } else if (
              raw &&
              typeof raw === "object" &&
              "type" in raw &&
              ["question", "artifact", "closeout_policy", "ci_rerun"].includes(String(raw.type))
            )
              throw new Error("Invalid runner question");
            const permission = z
              .object({
                type: z.literal("acp"),
                event: z.object({ type: z.literal("permission") }).loose(),
              })
              .safeParse(raw);
            if (permission.success) {
              const { type: _type, ...decision } = permission.data.event;
              const parsed = RunnerPermissionSchema.safeParse(decision);
              if (parsed.success) event = { type: "permission", permission: parsed.data };
            }
            const acp = z
              .object({
                type: z.literal("acp"),
                event: z.object({
                  type: z.literal("session_update"),
                  update: z.record(z.string(), z.unknown()),
                }),
              })
              .safeParse(raw);
            if (acp.success) {
              const input = acp.data.event.update;
              if (Array.isArray(input.content))
                input.content = input.content.filter(
                  (part) =>
                    z
                      .object({
                        type: z.literal("content"),
                        content: z.object({ type: z.literal("text") }),
                      })
                      .safeParse(part).success,
                );
              const update = RunnerActivitySchema.safeParse(input);
              if (update.success) {
                if (update.data.sessionUpdate === "agent_message_chunk") {
                  let text = update.data.content.text;
                  while (text.length) {
                    const count = Math.min(65_536 - message.length, text.length);
                    message += text.slice(0, count);
                    text = text.slice(count);
                    if (message.length === 65_536) flushMessage();
                  }
                } else event = { type: "activity", update: update.data };
              }
            }
          }
          if (event) {
            flushMessage();
            append(event, requestId);
          }
          offset = end + 1;
        }
        flushMessage();
        orm
          .update(execution)
          .set({
            consumed: offset,
            prefixHash: createHash("sha256").update(bytes.subarray(0, offset)).digest("hex"),
          })
          .where(eq(execution.id, id))
          .run();
      });
    },
    pending(id: string) {
      return orm
        .select({ sequence: delivery.sequence, payload: delivery.payload })
        .from(delivery)
        .where(and(eq(delivery.executionId, id), eq(delivery.sent, 0)))
        .orderBy(delivery.sequence)
        .all()
        .map((row) => ({
          sequence: row.sequence,
          event: RunnerEventSchema.parse(JSON.parse(row.payload)),
        }));
    },
    transcriptCursor(id: string) {
      const row = orm
        .select({ offset: execution.transcriptOffset, consumed: execution.consumed })
        .from(execution)
        .where(eq(execution.id, id))
        .get();
      if (!row) throw new Error("Runner transcript execution is missing");
      return row;
    },
    transcriptUploaded(id: string, previous: number, offset: number) {
      if (!Number.isSafeInteger(offset) || offset <= previous)
        throw new Error("Runner transcript offset is invalid");
      const changed = changes(
        orm
          .update(execution)
          .set({ transcriptOffset: offset })
          .where(
            and(
              eq(execution.id, id),
              eq(execution.transcriptOffset, previous),
              gte(execution.consumed, offset),
            ),
          ),
      );
      if (changed !== 1) throw new Error("Runner transcript offset changed");
    },
    sessionCursor(id: string) {
      const row = orm
        .select({ offset: execution.sessionOffset, state: execution.sessionState })
        .from(execution)
        .where(eq(execution.id, id))
        .get();
      if (!row) throw new Error("Runner session execution is missing");
      return row;
    },
    sessionUploaded(id: string, previous: number, offset: number) {
      if (!Number.isSafeInteger(offset) || offset <= previous)
        throw new Error("Runner session offset is invalid");
      const changed = changes(
        orm
          .update(execution)
          .set({ sessionOffset: offset })
          .where(
            and(
              eq(execution.id, id),
              eq(execution.sessionOffset, previous),
              eq(execution.sessionState, ""),
            ),
          ),
      );
      if (changed !== 1) throw new Error("Runner session offset changed");
    },
    sessionDone(id: string, state: "sealed" | "skipped") {
      orm
        .update(execution)
        .set({ sessionState: state })
        .where(and(eq(execution.id, id), eq(execution.sessionState, "")))
        .run();
    },
    /** Marks an unsent artifact as refused by Paws, so the event is sent without its bytes. */
    dropArtifact(id: string, sequence: number, reason: string) {
      const row = unsentArtifactPayload(id, sequence);
      const event = row && RunnerEventSchema.parse(JSON.parse(row.payload));
      if (!event || event.type !== "artifact")
        throw new Error("Dropped artifact does not match an unsent artifact");
      const dropped = RunnerEventSchema.parse({ ...event, dropped: reason.slice(0, 1024) });
      replaceUnsent(id, sequence, JSON.stringify(dropped));
      return dropped;
    },
    /** Marks an unsent checkpoint as not published, so Paws never records its commit. */
    dropCheckpoint(id: string, sequence: number, reason: string) {
      const row = unsentArtifactPayload(id, sequence);
      const event = row && RunnerEventSchema.parse(JSON.parse(row.payload));
      if (!event || event.type !== "checkpoint")
        throw new Error("Dropped checkpoint does not match an unsent checkpoint");
      const dropped = RunnerEventSchema.parse({ ...event, dropped: reason.slice(0, 1024) });
      replaceUnsent(id, sequence, JSON.stringify(dropped));
      return dropped;
    },
    sent(id: string, sequence: number) {
      orm
        .update(delivery)
        .set({ sent: 1 })
        .where(and(eq(delivery.executionId, id), eq(delivery.sequence, sequence)))
        .run();
    },
    answerCursor(id: string) {
      return orm
        .select({ cursor: execution.answerCursor })
        .from(execution)
        .where(eq(execution.id, id))
        .get()!.cursor;
    },
    requestId(id: string, sequence: number) {
      return (
        orm
          .select({ requestId: delivery.requestId })
          .from(delivery)
          .where(and(eq(delivery.executionId, id), eq(delivery.sequence, sequence)))
          .get()?.requestId ?? null
      );
    },
    answered(id: string, sequence: number) {
      const row = orm
        .select({ payload: delivery.payload, sent: delivery.sent })
        .from(delivery)
        .where(and(eq(delivery.executionId, id), eq(delivery.sequence, sequence)))
        .get();
      if (
        !row ||
        row.sent !== 1 ||
        !["question", "artifact", "closeout_policy", "ci_rerun"].includes(
          RunnerEventSchema.parse(JSON.parse(row.payload)).type,
        )
      )
        throw new Error("Answer does not match a delivered question or artifact");
      const earlier = orm
        .select({ sequence: delivery.sequence })
        .from(delivery)
        .innerJoin(execution, eq(execution.id, delivery.executionId))
        .where(
          and(
            eq(delivery.executionId, id),
            gt(delivery.sequence, execution.answerCursor),
            lt(delivery.sequence, sequence),
            awaitsAnswer,
          ),
        )
        .limit(1)
        .get();
      if (earlier) throw new Error("Answer would skip an earlier question or artifact");
      orm
        .update(execution)
        .set({ answerCursor: sequence })
        .where(and(eq(execution.id, id), lt(execution.answerCursor, sequence)))
        .run();
    },
    close() {
      db.close();
    },
  };
}
