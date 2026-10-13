import type { Database } from "bun:sqlite";
import { z } from "zod";
import { verifyRunnerCheckResult } from "../runner-verifier";
import { immediate, getRunnerVerifier } from "../db";
import {
  deriveRunnerCheckInput,
  RunnerCheckResultSchema,
  RunnerCheckRequestSchema,
  runnerCheckInputHash,
  type RunnerCheckInput,
  type RunnerCheckRequest,
  type RunnerCheckResult,
} from "../runner-check";
import { RunnerCommandSchema } from "../runner-protocol";
import { RunnerWorkFencedError, type RunnerWork } from "../runner-work";
import { workspaceId, workspaceTokenHash } from "../workspace";

type Execution = {
  id: string;
  attemptId: string;
  commandId: string;
  generation: number;
  input: string;
  inputSha256: string;
  result: string | null;
  grantHash: string | null;
  receiptUntil: number | null;
  cancelledAt: number | null;
  runId: string;
  runnerId: string;
  workspaceId: string;
  runnerFence: number;
  candidateSha: string;
};
const executionColumns = `e.id,e.attempt_id AS attemptId,e.command_id AS commandId,e.generation,
  e.input,e.input_sha256 AS inputSha256,e.result,e.grant_hash AS grantHash,
  e.receipt_until AS receiptUntil,e.cancelled_at AS cancelledAt,a.run_id AS runId,
  a.runner_id AS runnerId,a.workspace_id AS workspaceId,a.runner_fence AS runnerFence,
  a.candidate_sha AS candidateSha`;

const dispatchSchema = RunnerCheckRequestSchema.omit({ executionId: true }).extend({
  runnerId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
  runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
});

export function createRunnerChecks(options: {
  db: Database;
  work: RunnerWork;
  now?: () => number;
}) {
  const { db, work } = options;
  const now = options.now ?? Date.now;
  function execution(id: string) {
    return db
      .query<Execution, [string]>(`SELECT ${executionColumns}
      FROM runner_check_execution e JOIN runner_check_attempt a ON a.id=e.attempt_id
      WHERE e.id=?`)
      .get(id);
  }
  function fenced(): never {
    throw new RunnerWorkFencedError("Runner verification is fenced.");
  }
  return {
    dispatch(raw: Omit<RunnerCheckRequest, "executionId"> & { runnerId: string; runId: string }) {
      const request = dispatchSchema.parse(raw);
      return immediate(db, () => {
        const at = now();
        const identity = work.identity(request.runnerId);
        if (!getRunnerVerifier(db, request.runnerId)) fenced();
        const scope = work.scope(request.runId, identity.workspaceId);
        const previous = db
          .query<
            {
              runId: string;
              runnerId: string;
              workspaceId: string;
              runnerFence: number;
              candidateSha: string;
            },
            [string]
          >(`SELECT run_id AS runId,runner_id AS runnerId,workspace_id AS workspaceId,
          runner_fence AS runnerFence,candidate_sha AS candidateSha FROM runner_check_attempt WHERE id=?`)
          .get(request.verificationAttemptId);
        if (
          previous &&
          (previous.runId !== request.runId ||
            previous.runnerId !== request.runnerId ||
            previous.workspaceId !== identity.workspaceId ||
            previous.runnerFence !== identity.fence ||
            previous.candidateSha !== request.candidateSha)
        )
          fenced();
        if (
          db
            .query(`SELECT 1 FROM runner_check_execution WHERE attempt_id=?
          AND (result IS NULL OR cancelled_at IS NOT NULL)`)
            .get(request.verificationAttemptId)
        )
          fenced();
        const executionId = workspaceId(at);
        const input = deriveRunnerCheckInput({
          executionId,
          verificationAttemptId: request.verificationAttemptId,
          candidateSha: request.candidateSha,
          argv: request.argv,
          cwd: request.cwd,
          timeoutMs: request.timeoutMs,
        });
        const assigned = db
          .query<{ generation: number }, [string]>(
            "SELECT generation FROM runner_work WHERE run_id=?",
          )
          .get(request.runId);
        const command = RunnerCommandSchema.parse({
          type: "check",
          id: workspaceId(at),
          runnerId: request.runnerId,
          workspaceId: identity.workspaceId,
          issuedAt: at,
          expiresAt: at + request.timeoutMs + 60_000,
          runId: request.runId,
          itemId: scope.item.id,
          generation: (assigned?.generation ?? 0) + 1,
          repository: { ...scope.repository, baseSha: request.candidateSha },
          executionId,
          verificationAttemptId: request.verificationAttemptId,
          candidateSha: request.candidateSha,
          argv: request.argv,
          cwd: request.cwd,
          timeoutMs: request.timeoutMs,
        });
        if (command.type !== "check") fenced();
        const assignment = work.assign(command);
        if (!previous)
          db.run("INSERT INTO runner_check_attempt VALUES(?,?,?,?,?,?)", [
            request.verificationAttemptId,
            request.runId,
            request.runnerId,
            identity.workspaceId,
            identity.fence,
            request.candidateSha,
          ]);
        db.run(
          `INSERT INTO runner_check_execution(id,attempt_id,command_id,generation,input,input_sha256)
          VALUES(?,?,?,?,?,?)`,
          [
            executionId,
            request.verificationAttemptId,
            command.id,
            command.generation,
            JSON.stringify(input),
            runnerCheckInputHash(input),
          ],
        );
        return { command: assignment.envelope, input, leaseUntil: assignment.leaseUntil };
      });
    },
    result(executionId: string): { input: RunnerCheckInput; result: RunnerCheckResult } | null {
      const row = execution(executionId);
      return row?.result ? { input: JSON.parse(row.input), result: JSON.parse(row.result) } : null;
    },
    receive(request: {
      runnerId: string;
      runId: string;
      generation: number;
      token: string;
      result: RunnerCheckResult;
      verifierSignature: string;
    }) {
      const result = RunnerCheckResultSchema.parse(request.result);
      const payload = JSON.stringify(result);
      return immediate(db, () => {
        const at = now();
        const row = execution(result.executionId);
        const identity = work.identity(request.runnerId);
        if (
          !row ||
          row.cancelledAt !== null ||
          row.runnerId !== request.runnerId ||
          row.workspaceId !== identity.workspaceId ||
          row.runnerFence !== identity.fence ||
          row.runId !== request.runId ||
          row.generation !== request.generation ||
          row.attemptId !== result.verificationAttemptId ||
          row.candidateSha !== result.candidateSha ||
          row.inputSha256 !== result.inputSha256
        )
          fenced();
        const verifier = getRunnerVerifier(db, request.runnerId);
        if (
          !verifier ||
          !verifyRunnerCheckResult(result, request.verifierSignature, verifier.publicKeyPem)
        )
          fenced();
        const grantHash = workspaceTokenHash(request.token);
        if (row.result !== null) {
          if (row.result !== payload || row.grantHash !== grantHash || row.receiptUntil! <= at)
            fenced();
          return { duplicate: true };
        }
        const authorized = work.authorize(request);
        if (
          authorized.command.type !== "check" ||
          authorized.command.id !== row.commandId ||
          authorized.command.executionId !== row.id ||
          authorized.command.verificationAttemptId !== row.attemptId ||
          authorized.command.candidateSha !== row.candidateSha
        )
          fenced();
        db.run(
          `UPDATE runner_check_execution SET result=?,grant_hash=?,receipt_until=? WHERE id=?`,
          [payload, grantHash, at + 600_000, row.id],
        );
        work.finish(row.runId, row.generation);
        return { duplicate: false };
      });
    },
    cancel(executionId: string) {
      immediate(db, () => {
        const row = execution(executionId);
        if (!row || row.result !== null || row.cancelledAt !== null) return;
        db.run("UPDATE runner_check_execution SET cancelled_at=? WHERE id=?", [now(), row.id]);
        const assigned = db
          .query<{ generation: number; endedAt: number | null }, [string]>(
            "SELECT generation,ended_at AS endedAt FROM runner_work WHERE run_id=?",
          )
          .get(row.runId);
        if (assigned?.generation !== row.generation || assigned.endedAt !== null) return;
        try {
          work.enqueue({
            type: "cancel",
            id: workspaceId(now()),
            runnerId: row.runnerId,
            workspaceId: row.workspaceId,
            issuedAt: now(),
            expiresAt: now() + 60_000,
            runId: row.runId,
            generation: row.generation,
          });
        } catch {
          work.finish(row.runId, row.generation);
        }
      });
    },
  };
}

export type RunnerChecks = ReturnType<typeof createRunnerChecks>;
