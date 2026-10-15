import { randomBytes, createHash } from "node:crypto";
import { chmodSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { openDatabase, immediate } from "../db";
import {
  RunnerArtifactSchema,
  RunnerCommandSchema,
  RunnerEventSchema,
  type RunnerCommand,
} from "../runner-protocol";

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

export function openExecutionJournal(root: string) {
  if (!isAbsolute(root)) throw new Error("Execution journal root must be absolute");
  const info = statSync(root);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o700)
    throw new Error("Execution journal root must be private");
  const path = join(root, "executions.db");
  const db = openDatabase(path);
  chmodSync(path, 0o600);
  db.run(
    "CREATE TABLE IF NOT EXISTS execution (id TEXT PRIMARY KEY, command_id TEXT UNIQUE NOT NULL, payload TEXT NOT NULL, phase TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0, prefix_hash TEXT NOT NULL DEFAULT '', answer_cursor INTEGER NOT NULL DEFAULT 0) STRICT",
  );
  db.run(
    "CREATE TABLE IF NOT EXISTS delivery (execution_id TEXT NOT NULL REFERENCES execution(id), sequence INTEGER NOT NULL, payload TEXT NOT NULL, request_id TEXT, sent INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(execution_id,sequence)) STRICT",
  );
  if (
    !db
      .query<{ name: string }, []>("PRAGMA table_info(execution)")
      .all()
      .some((column) => column.name === "transcript_offset")
  )
    db.run("ALTER TABLE execution ADD COLUMN transcript_offset INTEGER NOT NULL DEFAULT 0");
  function executions(active: boolean): Execution[] {
    return db
      .query<{ id: string; payload: string; phase: string }, [number]>(
        "SELECT id,payload,phase FROM execution WHERE (phase NOT IN ('complete','interrupted'))=? ORDER BY rowid",
      )
      .all(Number(active))
      .map((row) => {
        const command = RunnerCommandSchema.parse(JSON.parse(row.payload));
        if (command.type !== "run" && command.type !== "review" && command.type !== "task")
          throw new Error("Invalid persisted work command");
        return { id: row.id, command, phase: row.phase };
      });
  }
  return {
    executions,
    admit(command: WorkCommand, now: number): Execution | null {
      const parsed = RunnerCommandSchema.parse(command);
      if (parsed.type !== "run" && parsed.type !== "review" && parsed.type !== "task")
        throw new Error("Work command is required");
      const existing = db
        .query<{ payload: string }, [string]>("SELECT payload FROM execution WHERE command_id=?")
        .get(command.id);
      if (existing) {
        if (existing.payload !== JSON.stringify(parsed))
          throw new Error("Persisted command changed");
        return null;
      }
      const id = executionId(now);
      db.run("INSERT INTO execution(id,command_id,payload,phase) VALUES (?,?,?,'preparing')", [
        id,
        command.id,
        JSON.stringify(parsed),
      ]);
      return { id, command: parsed, phase: "preparing" };
    },
    phase(id: string, phase: "running" | "publishing" | "complete" | "interrupted") {
      const changed = db.run(
        "UPDATE execution SET phase=? WHERE id=? AND phase NOT IN ('complete','interrupted')",
        [phase, id],
      ).changes;
      return changed === 1;
    },
    ingest(id: string, bytes: Buffer) {
      immediate(db, () => {
        const row = db
          .query<{ consumed: number; prefix_hash: string; phase: string }, [string]>(
            "SELECT consumed,prefix_hash,phase FROM execution WHERE id=?",
          )
          .get(id);
        if (!row) throw new Error("Unknown execution journal");
        if (row.phase === "complete" || row.phase === "interrupted")
          throw new Error("Execution journal is terminal");
        if (
          bytes.length < row.consumed ||
          (row.consumed > 0 &&
            createHash("sha256").update(bytes.subarray(0, row.consumed)).digest("hex") !==
              row.prefix_hash)
        )
          throw new Error("Runner event journal was rewritten");
        let offset = row.consumed;
        let sequence = db
          .query<{ sequence: number }, [string]>(
            "SELECT COALESCE(MAX(sequence),0) AS sequence FROM delivery WHERE execution_id=?",
          )
          .get(id)!.sequence;
        while (offset < bytes.length) {
          const end = bytes.indexOf(10, offset);
          if (end < 0) break;
          if (end - offset > 262_144) throw new Error("Runner journal record exceeds limit");
          const raw: unknown = JSON.parse(bytes.subarray(offset, end).toString("utf8"));
          let event: z.infer<typeof RunnerEventSchema> | undefined;
          let requestId: string | null = null;
          const q = question.safeParse(raw);
          const publication = artifact.safeParse(raw);
          if (publication.success) {
            if (publication.data.requestId !== publication.data.artifact.id)
              throw new Error("Artifact request binding changed");
            event = { type: "artifact", artifact: publication.data.artifact };
            requestId = publication.data.requestId;
          } else if (q.success) {
            event = { type: "question", text: q.data.question, options: q.data.options };
            requestId = q.data.requestId;
          } else {
            if (
              raw &&
              typeof raw === "object" &&
              "type" in raw &&
              ["question", "artifact"].includes(String(raw.type))
            )
              throw new Error("Invalid runner question");
            const progress = z
              .object({
                type: z.literal("acp"),
                event: z.object({
                  type: z.literal("session_update"),
                  update: z.object({
                    sessionUpdate: z.literal("agent_message_chunk"),
                    content: z.object({ type: z.literal("text"), text: z.string().max(65_536) }),
                  }),
                }),
              })
              .safeParse(raw);
            if (progress.success && sequence < 128)
              event = { type: "progress", text: progress.data.event.update.content.text };
            const tool = z
              .object({
                type: z.literal("acp"),
                event: z.object({
                  type: z.literal("session_update"),
                  update: z.object({
                    sessionUpdate: z.enum(["tool_call", "tool_call_update"]),
                    title: z.string().max(4096).optional(),
                    status: z.string().max(256).optional(),
                    content: z.array(z.unknown()).optional(),
                  }),
                }),
              })
              .safeParse(raw);
            if (tool.success && sequence < 128) {
              const update = tool.data.event.update;
              const text = [update.title, update.status].filter(Boolean);
              for (const part of update.content ?? []) {
                const content = z
                  .object({
                    type: z.literal("content"),
                    content: z.object({ type: z.literal("text"), text: z.string().max(65_536) }),
                  })
                  .safeParse(part);
                if (content.success) text.push(content.data.content.text);
              }
              if (text.length)
                event = { type: "progress", text: `Tool: ${text.join("\n")}`.slice(0, 65_536) };
            }
          }
          if (event) {
            if (sequence >= 1024) throw new Error("Runner event count exceeds limit");
            db.run(
              "INSERT INTO delivery(execution_id,sequence,payload,request_id) VALUES (?,?,?,?)",
              [id, ++sequence, JSON.stringify(RunnerEventSchema.parse(event)), requestId],
            );
          }
          offset = end + 1;
        }
        db.run("UPDATE execution SET consumed=?,prefix_hash=? WHERE id=?", [
          offset,
          createHash("sha256").update(bytes.subarray(0, offset)).digest("hex"),
          id,
        ]);
      });
    },
    pending(id: string) {
      return db
        .query<{ sequence: number; payload: string }, [string]>(
          "SELECT sequence,payload FROM delivery WHERE execution_id=? AND sent=0 ORDER BY sequence",
        )
        .all(id)
        .map((row) => ({
          sequence: row.sequence,
          event: RunnerEventSchema.parse(JSON.parse(row.payload)),
        }));
    },
    transcriptCursor(id: string) {
      const row = db
        .query<{ offset: number; consumed: number }, [string]>(
          "SELECT transcript_offset AS offset,consumed FROM execution WHERE id=?",
        )
        .get(id);
      if (!row) throw new Error("Runner transcript execution is missing");
      return row;
    },
    transcriptUploaded(id: string, previous: number, offset: number) {
      if (!Number.isSafeInteger(offset) || offset <= previous)
        throw new Error("Runner transcript offset is invalid");
      const changed = db.run(
        "UPDATE execution SET transcript_offset=? WHERE id=? AND transcript_offset=? AND consumed>=?",
        [offset, id, previous, offset],
      );
      if (changed.changes !== 1) throw new Error("Runner transcript offset changed");
    },
    sent(id: string, sequence: number) {
      db.run("UPDATE delivery SET sent=1 WHERE execution_id=? AND sequence=?", [id, sequence]);
    },
    answerCursor(id: string) {
      return db
        .query<{ answer_cursor: number }, [string]>(
          "SELECT answer_cursor FROM execution WHERE id=?",
        )
        .get(id)!.answer_cursor;
    },
    requestId(id: string, sequence: number) {
      return (
        db
          .query<{ request_id: string | null }, [string, number]>(
            "SELECT request_id FROM delivery WHERE execution_id=? AND sequence=?",
          )
          .get(id, sequence)?.request_id ?? null
      );
    },
    answered(id: string, sequence: number) {
      const delivery = db
        .query<{ payload: string; sent: number }, [string, number]>(
          "SELECT payload,sent FROM delivery WHERE execution_id=? AND sequence=?",
        )
        .get(id, sequence);
      if (
        !delivery ||
        delivery.sent !== 1 ||
        !["question", "artifact"].includes(
          RunnerEventSchema.parse(JSON.parse(delivery.payload)).type,
        )
      )
        throw new Error("Answer does not match a delivered question or artifact");
      const earlier = db
        .query<{ sequence: number }, [string, number]>(
          "SELECT d.sequence FROM delivery d JOIN execution e ON e.id=d.execution_id WHERE d.execution_id=? AND d.sequence>e.answer_cursor AND d.sequence<? AND json_extract(d.payload,'$.type') IN ('question','artifact') LIMIT 1",
        )
        .get(id, sequence);
      if (earlier) throw new Error("Answer would skip an earlier question or artifact");
      db.run("UPDATE execution SET answer_cursor=? WHERE id=? AND answer_cursor<?", [
        sequence,
        id,
        sequence,
      ]);
    },
    close() {
      db.close();
    },
  };
}
