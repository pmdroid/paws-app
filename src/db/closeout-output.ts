import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  max,
  ne,
  notInArray,
  or,
  type SQL,
} from "drizzle-orm";
import type { Db, Q, Steps } from "./db";
import { readSetting, updateSetting } from "./settings";
import type { CloseoutOutputPointer } from "./closeout-progress";

export type CloseoutOutputRef =
  | { table: "closeout_step"; progressId: string; stepId: string }
  | { table: "agent_closeout_event"; runId: string; sequence: number };

export type StoredCloseoutOutput = {
  ref: CloseoutOutputRef;
  itemId: string;
  head: string;
  checkId: string;
  stdout: string;
  stderr: string;
};

export type ExpiredCloseoutOutput = { ref: CloseoutOutputRef; key: string | null };

const ENDED = ["merged", "cancelled", "completed"];
const NO_OUTPUT = {
  stdout: "",
  stderr: "",
  outputKey: null,
  outputBytes: null,
  outputSha256: null,
};

function* stepOutputsSteps(q: Q, where: SQL | undefined, limit: number) {
  const { closeoutProgress: p, closeoutStep: s } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({
        progressId: s.progressId,
        stepId: s.stepId,
        itemId: p.itemId,
        head: p.head,
        stdout: s.stdout,
        stderr: s.stderr,
      })
      .from(s)
      .innerJoin(p, eq(p.id, s.progressId))
      .where(and(isNull(s.outputKey), or(ne(s.stdout, ""), ne(s.stderr, "")), where))
      .limit(limit),
  );
  return rows.map(({ progressId, stepId, ...row }) => ({
    ...row,
    checkId: stepId,
    ref: { table: "closeout_step" as const, progressId, stepId },
  }));
}

export function* finishedStepOutputSteps(
  q: Q,
  progressId: string,
  stepId: string,
): Steps<StoredCloseoutOutput | null> {
  const { closeoutStep: s } = q.t;
  const where = and(eq(s.progressId, progressId), eq(s.stepId, stepId));
  return (yield* stepOutputsSteps(q, and(where, unfinishedNot(q)), 1))[0] ?? null;
}

function unfinishedNot(q: Q) {
  return notInArray(q.t.closeoutStep.state, ["pending", "running"]);
}

function refWhere(q: Q, ref: CloseoutOutputRef) {
  const { closeoutStep: s, agentCloseoutEvent: e } = q.t;
  return ref.table === "closeout_step"
    ? and(eq(s.progressId, ref.progressId), eq(s.stepId, ref.stepId))
    : and(eq(e.runId, ref.runId), eq(e.sequence, ref.sequence));
}

export function* pointCloseoutOutputSteps(
  q: Q,
  row: Pick<StoredCloseoutOutput, "ref" | "stdout" | "stderr">,
  pointer: CloseoutOutputPointer,
): Steps<boolean> {
  const table = row.ref.table === "closeout_step" ? q.t.closeoutStep : q.t.agentCloseoutEvent;
  const updated = yield* q.all(
    q.orm
      .update(table)
      .set({
        stdout: "",
        stderr: "",
        outputKey: pointer.key,
        outputBytes: pointer.bytes,
        outputSha256: pointer.sha256,
      })
      .where(
        and(
          refWhere(q, row.ref),
          isNull(table.outputKey),
          eq(table.stdout, row.stdout),
          eq(table.stderr, row.stderr),
        ),
      )
      .returning({ key: table.outputKey }),
  );
  return updated.length > 0;
}

export function* expiredCloseoutOutputsSteps(
  q: Q,
  cutoff: number,
  limit: number,
): Steps<ExpiredCloseoutOutput[]> {
  const { closeoutProgress: p, closeoutStep: s, agentCloseoutEvent: e, workItem: w } = q.t;
  const { workItemEvent: h } = q.t;
  const quiet = q.orm
    .select({ itemId: h.itemId })
    .from(h)
    .groupBy(h.itemId)
    .having(lt(max(h.at), cutoff));
  const ended = and(inArray(w.state, ENDED), inArray(w.id, quiet));
  const steps = yield* q.all(
    q.orm
      .select({ progressId: s.progressId, stepId: s.stepId, key: s.outputKey })
      .from(s)
      .innerJoin(p, eq(p.id, s.progressId))
      .innerJoin(w, eq(w.id, p.itemId))
      .where(and(ended, or(isNotNull(s.outputKey), ne(s.stdout, ""), ne(s.stderr, ""))))
      .limit(limit),
  );
  const events = yield* q.all(
    q.orm
      .select({ runId: e.runId, sequence: e.sequence, key: e.outputKey })
      .from(e)
      .innerJoin(w, eq(w.id, e.itemId))
      .where(and(ended, or(isNotNull(e.outputKey), ne(e.stdout, ""), ne(e.stderr, ""))))
      .limit(Math.max(0, limit - steps.length)),
  );
  return [
    ...steps.map(({ key, progressId, stepId }) => ({
      key,
      ref: { table: "closeout_step" as const, progressId, stepId },
    })),
    ...events.map(({ key, runId, sequence }) => ({
      key,
      ref: { table: "agent_closeout_event" as const, runId, sequence },
    })),
  ];
}

export function* clearCloseoutOutputSteps(q: Q, ref: CloseoutOutputRef) {
  const table = ref.table === "closeout_step" ? q.t.closeoutStep : q.t.agentCloseoutEvent;
  yield* q.exec(q.orm.update(table).set(NO_OUTPUT).where(refWhere(q, ref)));
}

export const CLOSEOUT_LOG_RETENTION_KEY = "closeout.log_retention_days";
export const DEFAULT_CLOSEOUT_LOG_RETENTION_DAYS = 14;

export async function closeoutLogRetentionDays(store: Db): Promise<number> {
  const stored = await readSetting(store, CLOSEOUT_LOG_RETENTION_KEY);
  const days = stored === null ? NaN : Number(stored);
  return Number.isInteger(days) && days >= 0 ? days : DEFAULT_CLOSEOUT_LOG_RETENTION_DAYS;
}

export async function saveCloseoutLogRetentionDays(store: Db, days: number, now: number) {
  await updateSetting(store, CLOSEOUT_LOG_RETENTION_KEY, () => String(days), now);
}
