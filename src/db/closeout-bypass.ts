import { and, asc, eq, isNull } from "drizzle-orm";
import { type Q, type Steps, type Db } from "./db";

/**
 * A failed Closeout check a bypass link ask offers, as Closeout judged it on
 * the asked head. A person who bypasses it on the item page fills in the reason
 * and their name.
 */
export type CloseoutBypassCheck = {
  questionId: string;
  checkId: string;
  kind: string;
  state: string;
  attempt: number | null;
  message: string;
  reason: string | null;
  /** Linear user id of the person who bypassed the check. */
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: number | null;
};

export function* saveCloseoutBypassChecksSteps(
  q: Q,
  questionId: string,
  checks: readonly { id: string; kind: string; state: string; attempt?: number; message: string }[],
) {
  for (const [ordinal, check] of checks.entries())
    yield* q.exec(
      q.orm.insert(q.t.closeoutBypassCheck).values({
        questionId,
        checkId: check.id,
        kind: check.kind,
        state: check.state,
        attempt: check.attempt ?? null,
        message: check.message,
        ordinal,
      }),
    );
}

export async function saveCloseoutBypassChecks(
  store: Db,
  questionId: string,
  checks: readonly { id: string; kind: string; state: string; attempt?: number; message: string }[],
): Promise<void> {
  await store.run((q) => saveCloseoutBypassChecksSteps(q, questionId, checks));
}

export async function listCloseoutBypassChecks(
  store: Db,
  questionId: string,
): Promise<CloseoutBypassCheck[]> {
  return store.run((q) => listCloseoutBypassChecksSteps(q, questionId));
}

export function* listCloseoutBypassChecksSteps(
  q: Q,
  questionId: string,
): Steps<CloseoutBypassCheck[]> {
  const { closeoutBypassCheck: check } = q.t;
  const rows = yield* q.all(
    q.orm.select().from(check).where(eq(check.questionId, questionId)).orderBy(asc(check.ordinal)),
  );
  return rows.map((row) => ({
    questionId: row.questionId,
    checkId: row.checkId,
    kind: row.kind,
    state: row.state,
    attempt: row.attempt,
    message: row.message,
    reason: row.reason,
    approvedBy: row.approvedBy,
    approvedByName: row.approvedByName,
    approvedAt: row.approvedAt,
  }));
}

/** Records who bypassed which offered check and why. Returns false when a check was not offered or already decided. */
export function* approveCloseoutBypassChecksSteps(
  q: Q,
  questionId: string,
  input: {
    checks: readonly { checkId: string; reason: string }[];
    approvedBy: string;
    approvedByName: string;
    now: number;
  },
): Steps<boolean> {
  const { closeoutBypassCheck: table } = q.t;
  for (const check of input.checks) {
    const updated = yield* q.all(
      q.orm
        .update(table)
        .set({
          reason: check.reason,
          approvedBy: input.approvedBy,
          approvedByName: input.approvedByName,
          approvedAt: input.now,
        })
        .where(
          and(
            eq(table.questionId, questionId),
            eq(table.checkId, check.checkId),
            isNull(table.approvedAt),
          ),
        )
        .returning({ checkId: table.checkId }),
    );
    if (updated.length === 0) return false;
  }
  return true;
}

/** The synchronous `approveCloseoutBypassChecksSteps`, for callers that are not async yet. */
export async function approveCloseoutBypassChecks(
  store: Db,
  questionId: string,
  input: {
    checks: readonly { checkId: string; reason: string }[];
    approvedBy: string;
    approvedByName: string;
    now: number;
  },
): Promise<boolean> {
  return store.run((q) => approveCloseoutBypassChecksSteps(q, questionId, input));
}
