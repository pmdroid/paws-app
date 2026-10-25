import type { Database } from "bun:sqlite";
import { z } from "zod";
import { immediate, recordRunnerAgentUsage, runnerLeaseCutoff } from "../db";
import {
  RUNNER_RESULT_BODY_LIMIT,
  RunnerResultSchema,
  RunnerEventSchema,
  type RunnerResult,
} from "../runner-protocol";
import { RunnerWorkFencedError, type RunnerWork } from "../runner-work";

const integer = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const resultInput = z.strictObject({ generation: integer, result: RunnerResultSchema });
const answerInput = z.strictObject({
  generation: integer,
  after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

function followUpsSupported(version: string | null): boolean {
  const parts = version
    ?.match(/^(\d+)\.(\d+)\.(\d+)/)
    ?.slice(1)
    .map(Number);
  if (!parts) return false;
  const [major, minor, patch] = parts as [number, number, number];
  return major > 0 || minor > 1 || (minor === 1 && patch >= 12);
}

export function createRunnerResults(options: {
  db: Database;
  work: RunnerWork;
  now?: () => number;
}) {
  const { db, work } = options;
  const now = options.now ?? Date.now;
  function current(runId: string, generation: number, commandId?: string) {
    const { command } = work.current(runId, generation);
    if (commandId !== undefined && command.id !== commandId)
      throw new RunnerWorkFencedError("Runner result belongs to fenced work.");
    return command;
  }
  const api = {
    submit(input: {
      runnerId: string;
      runId: string;
      generation: number;
      token: string;
      result: RunnerResult;
    }) {
      const result = RunnerResultSchema.parse(input.result);
      return immediate(db, () => {
        const { command } = work.authorize(input);
        if (
          (command.type !== "run" && command.type !== "review" && command.type !== "task") ||
          result.commandId !== command.id ||
          result.role !== (command.type === "review" ? "reviewer" : "implementer") ||
          (command.type === "task" &&
            (result.candidateSha !== undefined || result.reviewText !== undefined)) ||
          (command.type === "run" && result.reviewText !== undefined) ||
          (command.type === "review" && result.candidateSha !== undefined) ||
          (result.candidateSha !== undefined && (result.cancelled || !result.agentExited))
        )
          throw new Error("Runner result command binding is invalid.");
        const payload = JSON.stringify(result);
        const existing = db
          .query<{ payload: string }, [string, number]>(
            "SELECT payload FROM runner_result WHERE run_id=? AND generation=?",
          )
          .get(input.runId, input.generation);
        if (existing) {
          if (existing.payload !== payload) throw new Error("Runner result is immutable.");
          return { duplicate: true };
        }
        const at = now();
        db.run("INSERT INTO runner_result VALUES(?,?,?,?,?)", [
          input.runId,
          input.generation,
          command.id,
          payload,
          at,
        ]);
        if (result.agentLimits)
          recordRunnerAgentUsage(db, {
            runnerId: input.runnerId,
            agent: command.profile.agent,
            limits: result.agentLimits,
            observedAt: at,
          });
        return { duplicate: false };
      });
    },
    read(runId: string, generation: number, commandId: string): RunnerResult | null {
      current(runId, generation, commandId);
      const row = db
        .query<{ payload: string }, [string, number, string]>(
          "SELECT payload FROM runner_result WHERE run_id=? AND generation=? AND command_id=?",
        )
        .get(runId, generation, commandId);
      return row ? RunnerResultSchema.parse(JSON.parse(row.payload)) : null;
    },
    events(runId: string, generation: number, after: number) {
      integer.parse(generation);
      z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(after);
      current(runId, generation);
      return db
        .query<{ sequence: number; payload: string }, [string, number, number]>(
          "SELECT sequence,payload FROM runner_event WHERE run_id=? AND generation=? AND sequence>? ORDER BY sequence LIMIT 64",
        )
        .all(runId, generation, after)
        .map((row) => ({
          sequence: row.sequence,
          event: RunnerEventSchema.parse(JSON.parse(row.payload)),
        }));
    },
    answer(input: { runId: string; generation: number; sequence: number; answer: string }) {
      integer.parse(input.generation);
      integer.parse(input.sequence);
      const answer = z.string().min(1).max(65536).parse(input.answer);
      immediate(db, () => {
        current(input.runId, input.generation);
        const question = db
          .query<{ payload: string }, [string, number, number]>(
            "SELECT payload FROM runner_event WHERE run_id=? AND generation=? AND sequence=?",
          )
          .get(input.runId, input.generation, input.sequence);
        if (
          !question ||
          !["question", "artifact", "closeout_policy"].includes(JSON.parse(question.payload).type)
        )
          throw new Error("Runner question is unavailable.");
        const existing = db
          .query<{ answer: string }, [string, number, number]>(
            "SELECT answer FROM runner_question_answer WHERE run_id=? AND generation=? AND sequence=?",
          )
          .get(input.runId, input.generation, input.sequence);
        if (existing) {
          if (existing.answer !== answer) throw new Error("Runner answer is immutable.");
          return;
        }
        db.run("INSERT INTO runner_question_answer VALUES(?,?,?,?,?)", [
          input.runId,
          input.generation,
          input.sequence,
          answer,
          now(),
        ]);
      });
    },
    answers(input: {
      runnerId: string;
      runId: string;
      generation: number;
      token: string;
      after: number;
    }) {
      work.authorize(input);
      z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(input.after);
      const unanswered = db
        .query<{ sequence: number }, [string, number]>(
          `SELECT e.sequence FROM runner_event e
           LEFT JOIN runner_question_answer a
             ON a.run_id=e.run_id AND a.generation=e.generation AND a.sequence=e.sequence
           WHERE e.run_id=? AND e.generation=? AND a.sequence IS NULL
             AND json_extract(e.payload, '$.type') IN ('question','artifact','closeout_policy')
           ORDER BY e.sequence LIMIT 1`,
        )
        .get(input.runId, input.generation);
      return db
        .query<{ sequence: number; answer: string }, [string, number, number]>(
          "SELECT sequence,answer FROM runner_question_answer WHERE run_id=? AND generation=? AND sequence>? ORDER BY sequence LIMIT 64",
        )
        .all(input.runId, input.generation, input.after)
        .filter((answer) => !unanswered || answer.sequence < unanswered.sequence);
    },
    deliverFollowUp(itemId: string, body: string): boolean {
      const text = z.string().min(1).max(65536).safeParse(body);
      if (!text.success) return false;
      return immediate(db, () => {
        const row = db
          .query<{ runId: string; generation: number; version: string | null }, [string, number]>(
            `SELECT w.run_id AS runId,w.generation,h.runner_version AS version FROM work_item i
             JOIN runner_work w ON w.run_id=i.current_run_id
             JOIN runner_host_status h ON h.runner_id=w.runner_id
             WHERE i.id=? AND w.ended_at IS NULL AND w.lease_until>?`,
          )
          .get(itemId, runnerLeaseCutoff(now()));
        if (!row || !followUpsSupported(row.version)) return false;
        try {
          if (current(row.runId, row.generation).type !== "run") return false;
        } catch {
          return false;
        }
        const next = db
          .query<{ sequence: number }, [string, number]>(
            "SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM runner_follow_up WHERE run_id=? AND generation=?",
          )
          .get(row.runId, row.generation)!.sequence;
        db.run("INSERT INTO runner_follow_up VALUES(?,?,?,?,?)", [
          row.runId,
          row.generation,
          next,
          text.data,
          now(),
        ]);
        return true;
      });
    },
    followUps(input: {
      runnerId: string;
      runId: string;
      generation: number;
      token: string;
      after: number;
    }) {
      work.authorize(input);
      z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(input.after);
      return db
        .query<{ sequence: number; body: string }, [string, number, number]>(
          "SELECT sequence,body FROM runner_follow_up WHERE run_id=? AND generation=? AND sequence>? ORDER BY sequence LIMIT 64",
        )
        .all(input.runId, input.generation, input.after);
    },
    async fetch(request: Request, runnerId: string): Promise<Response | null> {
      const match = /^\/v1\/runs\/([^/]+)\/(result|answers|follow-ups)$/.exec(
        new URL(request.url).pathname,
      );
      if (!match || request.method !== "POST") return null;
      const json = (value: unknown, status = 200) =>
        Response.json(value, { status, headers: { "cache-control": "no-store" } });
      try {
        const authorization = request.headers.get("authorization");
        if (!authorization || !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization))
          throw new Error("Run grant is required.");
        const input = {
          runnerId,
          runId: id.parse(decodeURIComponent(match[1]!)),
          token: authorization.slice(7),
        };
        const body = await readBody(request);
        if (match[2] === "result")
          return json(api.submit({ ...input, ...resultInput.parse(body) }));
        if (match[2] === "follow-ups")
          return json({ followUps: api.followUps({ ...input, ...answerInput.parse(body) }) });
        return json({ answers: api.answers({ ...input, ...answerInput.parse(body) }) });
      } catch (error) {
        if (error instanceof RunnerWorkFencedError)
          return json({ error: "Runner work is fenced.", code: "fenced" }, 409);
        return json({ error: "Runner result request is denied or invalid." }, 403);
      }
    },
  };
  return api;
}

export type RunnerResults = ReturnType<typeof createRunnerResults>;

async function readBody(request: Request) {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json")
    throw new Error("JSON is required.");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("JSON is required");
  const timeout = AbortSignal.timeout(10_000);
  const cancel = () => void reader.cancel().catch(() => undefined);
  timeout.addEventListener("abort", cancel, { once: true });
  request.signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      timeout.throwIfAborted();
      request.signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > RUNNER_RESULT_BODY_LIMIT) throw new Error("Runner result input is too large");
      chunks.push(part.value);
    }
    timeout.throwIfAborted();
    request.signal.throwIfAborted();
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    timeout.removeEventListener("abort", cancel);
    request.signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
