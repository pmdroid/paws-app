import { journalCaught } from "../journal";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
  immediate,
  insertRunnerFollowUp,
  insertRunnerQuestionAnswer,
  insertRunnerResult,
  itemRunnerFollowUpTarget,
  recordRunnerAgentUsage,
  runnerEventPage,
  runnerFollowUpsAfter,
  runnerLeaseCutoff,
  runnerQuestionAnswersAfter,
  runnerResultForCommand,
  runnerResultMatches,
  storedRunnerAnswer,
  storedRunnerEvent,
  unansweredRunnerQuestions,
} from "../db";
import {
  RUNNER_RESULT_BODY_LIMIT,
  RunnerResultSchema,
  runnerAccountEchoed,
  withRejectedFields,
  type RunnerResult,
} from "../runner-protocol";
import { RunnerWorkFencedError, runnerFailureStatus, type RunnerWork } from "../runner-work";

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

const QUESTION_TYPES: readonly string[] = ["question", "artifact", "closeout_policy", "ci_rerun"];

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
          !runnerAccountEchoed(command, result) ||
          result.role !== (command.type === "review" ? "reviewer" : "implementer") ||
          (command.type === "task" &&
            (result.candidateSha !== undefined || result.reviewText !== undefined)) ||
          (command.type === "run" && result.reviewText !== undefined) ||
          (command.type === "review" && result.candidateSha !== undefined) ||
          (result.candidateSha !== undefined && (result.cancelled || !result.agentExited)) ||
          (result.handedOver &&
            (command.type !== "run" || result.cancelled || !result.agentExited)) ||
          (result.handoverFailure !== undefined &&
            (command.type !== "run" || result.handedOver || result.cancelled))
        )
          throw new Error("Runner result command binding is invalid.");
        const payload = JSON.stringify(result);
        const existing = runnerResultMatches(db, input, payload);
        if (existing !== null) {
          if (!existing) throw new Error("Runner result is immutable.");
          return { duplicate: true };
        }
        const at = now();
        insertRunnerResult(db, {
          runId: input.runId,
          generation: input.generation,
          commandId: command.id,
          payload,
          receivedAt: at,
        });
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
      const payload = runnerResultForCommand(db, { runId, generation }, commandId);
      return payload === null ? null : RunnerResultSchema.parse(JSON.parse(payload));
    },
    events(runId: string, generation: number, after: number) {
      integer.parse(generation);
      z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(after);
      current(runId, generation);
      return runnerEventPage(db, { runId, generation }, after).map((row) => ({
        sequence: row.sequence,
        event: work.openEvent(row),
      }));
    },
    /** The stored answer to a runner event, or null before Paws answered it. */
    answered(runId: string, generation: number, sequence: number): string | null {
      integer.parse(generation);
      integer.parse(sequence);
      current(runId, generation);
      return storedRunnerAnswer(db, { runId, generation }, sequence);
    },
    answer(input: { runId: string; generation: number; sequence: number; answer: string }) {
      integer.parse(input.generation);
      integer.parse(input.sequence);
      const answer = z.string().min(1).max(65536).parse(input.answer);
      immediate(db, () => {
        current(input.runId, input.generation);
        const question = storedRunnerEvent(db, input, input.sequence);
        if (!question || !QUESTION_TYPES.includes(work.openEvent(question).type))
          throw new Error("Runner question is unavailable.");
        const existing = storedRunnerAnswer(db, input, input.sequence);
        if (existing !== null) {
          if (existing !== answer) throw new Error("Runner answer is immutable.");
          return;
        }
        insertRunnerQuestionAnswer(db, {
          runId: input.runId,
          generation: input.generation,
          sequence: input.sequence,
          answer,
          createdAt: now(),
        });
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
      const unanswered = unansweredRunnerQuestions(db, input, QUESTION_TYPES).find((row) =>
        QUESTION_TYPES.includes(work.openEvent(row).type),
      );
      return runnerQuestionAnswersAfter(db, input, input.after).filter(
        (answer) => !unanswered || answer.sequence < unanswered.sequence,
      );
    },
    deliverFollowUp(itemId: string, body: string): boolean {
      const text = z.string().min(1).max(65536).safeParse(body);
      if (!text.success) return false;
      return immediate(db, () => {
        const row = itemRunnerFollowUpTarget(db, itemId, runnerLeaseCutoff(now()));
        if (!row || !followUpsSupported(row.version)) return false;
        try {
          if (current(row.runId, row.generation).type !== "run") return false;
        } catch (caughtError1) {
          journalCaught(caughtError1, "runner-results.deliverFollowUp.current", itemId);
          return false;
        }
        insertRunnerFollowUp(db, {
          runId: row.runId,
          generation: row.generation,
          body: text.data,
          createdAt: now(),
        });
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
      return runnerFollowUpsAfter(db, input, input.after);
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
        journalCaught(error, "runner-results.fetch.get", null);
        const status = runnerFailureStatus(error);
        if (status === 409) return json({ error: "Runner work is fenced.", code: "fenced" }, 409);
        if (status === 503) return json({ error: "Paws is busy. Retry the request." }, 503);
        const denied = json({ error: "Runner result request is denied or invalid." }, 403);
        return withRejectedFields(denied, error);
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
  const cancel = () =>
    void reader.cancel().catch((caughtError2) => {
      journalCaught(caughtError2, "runner-results.readBody.cancel", null);
      return undefined;
    });
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
    await reader.cancel().catch((caughtError3) => {
      journalCaught(caughtError3, "runner-results.readBody.cancel", null);
      return undefined;
    });
    reader.releaseLock();
  }
}
