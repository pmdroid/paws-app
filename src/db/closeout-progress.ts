import type { Database } from "bun:sqlite";
import { and, desc, eq, inArray, isNotNull, min, or, sql } from "drizzle-orm";
import { settled, sqliteDb, type Q, type Steps } from "./db";
import type * as pgSchema from "./schema-pg";

export const CLOSEOUT_OUTPUT_CAP_BYTES = 64 * 1024;

export type CloseoutProgressIdentity = {
  taskId: string;
  base: string;
  head: string;
  policyDigest: string;
  policyPath: string | null;
  /** The digest of the policy's checks marked `recheck: true`, `""` when none is. */
  recheckDigest?: string;
};

export type CloseoutStepWrite = {
  id: string;
  kind: "setup" | "command" | "review";
  state: "pending" | "running" | "passed" | "failed" | "blocked" | "skipped" | "exhausted";
  command: string;
  detail: string | null;
  attempt: number;
  timeoutSeconds: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  exitCode: number | null;
  timedOut: boolean;
  timeoutReason: string | null;
  truncated: boolean;
  logPath: string | null;
  evidencePath: string | null;
  findings: string | null;
  /** Structured severities of this exact review attempt; absent on legacy results. */
  findingSeverities?: readonly ("P0" | "P1" | "P2" | "P3")[] | null;
  ordinal: number;
  durationMs?: number | null;
  tokens?: number | null;
  /** A review's `failOn`. */
  failOn?: "P0" | "P1" | "P2" | "P3" | null;
  /** Indexes of the review record's findings that are in pre-existing code. */
  preExisting?: readonly number[] | null;
};

export type CloseoutStepRecord = CloseoutStepWrite & {
  stdout: string;
  stderr: string;
};

export type CloseoutProgressRecord = CloseoutProgressIdentity & {
  id: string;
  itemId: string;
  decision: string | null;
  startedAt: number;
  updatedAt: number;
  finishedAt: number | null;
  steps: CloseoutStepRecord[];
};

type ProgressRow = typeof pgSchema.closeoutProgress.$inferSelect;
type StepRow = typeof pgSchema.closeoutStep.$inferSelect;

type ExistingStep = Pick<
  StepRow,
  | "command"
  | "ordinal"
  | "attempt"
  | "state"
  | "startedAt"
  | "findings"
  | "truncated"
  | "durationMs"
  | "tokens"
  | "reviewFailOn"
  | "reviewPreExisting"
>;

export function ensureCloseoutProgress(
  db: Database,
  itemId: string,
  identity: CloseoutProgressIdentity,
  now: number,
  reset: boolean,
): string {
  return settled(
    sqliteDb(db).transaction((q) => ensureCloseoutProgressSteps(q, itemId, identity, now, reset)),
  );
}

export function* ensureCloseoutProgressSteps(
  q: Q,
  itemId: string,
  identity: CloseoutProgressIdentity,
  now: number,
  reset: boolean,
) {
  const { closeoutProgress } = q.t;
  const id = progressKey(itemId, identity);
  yield* q.exec(
    q.orm
      .insert(closeoutProgress)
      .values({
        id,
        itemId,
        taskId: identity.taskId,
        base: identity.base,
        head: identity.head,
        policyDigest: identity.policyDigest,
        policyPath: identity.policyPath,
        recheckDigest: identity.recheckDigest ?? null,
        decision: null,
        startedAt: now,
        updatedAt: now,
        finishedAt: null,
      })
      .onConflictDoUpdate({
        target: closeoutProgress.id,
        set: {
          updatedAt: now,
          base: identity.base,
          policyPath: sql`COALESCE(${identity.policyPath}, ${closeoutProgress.policyPath})`,
          recheckDigest: sql`COALESCE(${identity.recheckDigest ?? null}, ${closeoutProgress.recheckDigest})`,
          ...(reset ? { decision: null, finishedAt: null } : {}),
        },
      }),
  );
  return id;
}

export function upsertCloseoutStep(
  db: Database,
  itemId: string,
  identity: CloseoutProgressIdentity,
  step: CloseoutStepWrite,
  now: number,
): void {
  settled(sqliteDb(db).transaction((q) => upsertCloseoutStepSteps(q, itemId, identity, step, now)));
}

export function* upsertCloseoutStepSteps(
  q: Q,
  itemId: string,
  identity: CloseoutProgressIdentity,
  step: CloseoutStepWrite,
  now: number,
) {
  const { closeoutStep } = q.t;
  const progressId = yield* ensureCloseoutProgressSteps(q, itemId, identity, now, false);
  const key = and(eq(closeoutStep.progressId, progressId), eq(closeoutStep.stepId, step.id));
  const existing =
    (yield* q.one(
      q.orm
        .select({
          command: closeoutStep.command,
          ordinal: closeoutStep.ordinal,
          attempt: closeoutStep.attempt,
          state: closeoutStep.state,
          startedAt: closeoutStep.startedAt,
          findings: closeoutStep.findings,
          truncated: closeoutStep.truncated,
          durationMs: closeoutStep.durationMs,
          tokens: closeoutStep.tokens,
          reviewFailOn: closeoutStep.reviewFailOn,
          reviewPreExisting: closeoutStep.reviewPreExisting,
        })
        .from(closeoutStep)
        .where(key),
    )) ?? null;
  const clearOutput =
    existing !== null &&
    (step.state === "pending" || (step.state === "running" && existing.state !== "running"));
  const command = step.command.length > 0 ? step.command : (existing?.command ?? step.id);
  const ordinal = step.ordinal >= 0 ? step.ordinal : (existing?.ordinal ?? 0);
  const startedAt = startedAtFor(existing, step);
  const attempt = step.attempt > 0 ? step.attempt : (existing?.attempt ?? step.attempt);
  const findings = findingsFor(existing, step);
  const rerun = step.state === "running" || step.state === "pending";
  const durationMs = step.durationMs ?? (rerun ? null : (existing?.durationMs ?? null));
  const tokens = step.tokens ?? (rerun ? null : (existing?.tokens ?? null));
  const truncated = clearOutput ? step.truncated : step.truncated || existing?.truncated === 1;
  // A review keeps its marks until a new review of the step reports them again.
  const failOn = step.failOn ?? (rerun ? null : (existing?.reviewFailOn ?? null));
  const preExisting =
    step.preExisting != null
      ? JSON.stringify(step.preExisting)
      : rerun
        ? null
        : (existing?.reviewPreExisting ?? null);
  const values = {
    kind: step.kind,
    state: step.state,
    command,
    detail: step.detail,
    attempt,
    timeoutSeconds: step.timeoutSeconds,
    startedAt,
    finishedAt: step.finishedAt,
    exitCode: step.exitCode,
    timedOut: step.timedOut ? 1 : 0,
    timeoutReason: step.timeoutReason,
    truncated: truncated ? 1 : 0,
    logPath: step.logPath,
    evidencePath: step.evidencePath,
    findings,
    ordinal,
    durationMs,
    tokens,
    reviewFailOn: failOn,
    reviewPreExisting: preExisting,
  };
  yield* q.exec(
    q.orm
      .insert(closeoutStep)
      .values({ progressId, stepId: step.id, ...values, stdout: "", stderr: "" })
      .onConflictDoUpdate({
        target: [closeoutStep.progressId, closeoutStep.stepId],
        set: values,
      }),
  );
  if (clearOutput)
    yield* q.exec(q.orm.update(closeoutStep).set({ stdout: "", stderr: "" }).where(key));
}

function startedAtFor(existing: ExistingStep | null, step: CloseoutStepWrite): number | null {
  if (step.state === "pending") return null;
  if (existing?.state === "running") return existing.startedAt ?? step.startedAt;
  if (step.state === "running") return step.startedAt;
  return step.startedAt ?? existing?.startedAt ?? null;
}

function findingsFor(existing: ExistingStep | null, step: CloseoutStepWrite): string | null {
  // Store typed review evidence in the existing text column, atomically with the step.
  // mapStep restores the display text for existing consumers. This is never an approval.
  if (step.findingSeverities !== undefined)
    return JSON.stringify({
      reviewSnapshot: 1,
      attempt: step.attempt > 0 ? step.attempt : (existing?.attempt ?? step.attempt),
      text: step.findings,
      severities: step.findingSeverities,
    });
  if (step.kind === "review" && step.attempt > (existing?.attempt ?? 0)) return step.findings;
  if (step.findings !== null) return step.findings;
  if (step.state === "running" && existing?.state !== "running") return null;
  return existing?.findings ?? null;
}

export function appendCloseoutOutput(
  db: Database,
  itemId: string,
  identity: CloseoutProgressIdentity,
  stepId: string,
  stream: "stdout" | "stderr",
  text: string,
  truncated: boolean,
  now: number,
): void {
  settled(
    sqliteDb(db).transaction((q) =>
      appendCloseoutOutputSteps(q, itemId, identity, stepId, stream, text, truncated, now),
    ),
  );
}

export function* appendCloseoutOutputSteps(
  q: Q,
  itemId: string,
  identity: CloseoutProgressIdentity,
  stepId: string,
  stream: "stdout" | "stderr",
  text: string,
  truncated: boolean,
  now: number,
) {
  const { closeoutProgress, closeoutStep } = q.t;
  const progressId = progressKey(itemId, identity);
  const key = and(eq(closeoutStep.progressId, progressId), eq(closeoutStep.stepId, stepId));
  const row = yield* q.one(
    q.orm
      .select({ stdout: closeoutStep.stdout, stderr: closeoutStep.stderr })
      .from(closeoutStep)
      .where(key),
  );
  if (row === undefined) return;
  const column = stream === "stderr" ? "stderr" : "stdout";
  const appended = bound(row[column], text);
  yield* q.exec(
    q.orm
      .update(closeoutStep)
      .set({
        [column]: appended.text,
        ...(appended.truncated || truncated ? { truncated: 1 } : {}),
      })
      .where(key),
  );
  yield* q.exec(
    q.orm
      .update(closeoutProgress)
      .set({ updatedAt: now })
      .where(eq(closeoutProgress.id, progressId)),
  );
}

export function finishCloseoutProgress(
  db: Database,
  itemId: string,
  identity: CloseoutProgressIdentity,
  decision: string,
  now: number,
): void {
  settled(
    sqliteDb(db).transaction((q) =>
      finishCloseoutProgressSteps(q, itemId, identity, decision, now),
    ),
  );
}

export function* finishCloseoutProgressSteps(
  q: Q,
  itemId: string,
  identity: CloseoutProgressIdentity,
  decision: string,
  now: number,
) {
  const { closeoutProgress, mergeCarriedAccept, workItem } = q.t;
  const id = yield* ensureCloseoutProgressSteps(q, itemId, identity, now, false);
  yield* q.exec(
    q.orm
      .update(closeoutProgress)
      .set({ decision, finishedAt: now, updatedAt: now })
      .where(eq(closeoutProgress.id, id)),
  );
  if (decision === "rejected" || decision === "exhausted") {
    // A verdict against the head retires its acceptance, including one carried through a
    // permitted lane rebase. Infrastructure outcomes (blocked, invalid) leave it standing, but
    // the merge lane still refuses while such a run is the head's latest.
    const carried = q.orm
      .select({ acceptedHead: mergeCarriedAccept.acceptedHead })
      .from(mergeCarriedAccept)
      .where(
        and(eq(mergeCarriedAccept.itemId, itemId), eq(mergeCarriedAccept.head, identity.head)),
      );
    yield* q.exec(
      q.orm
        .update(workItem)
        .set({ acceptedHead: null })
        .where(
          and(
            eq(workItem.id, itemId),
            or(
              eq(workItem.acceptedHead, identity.head),
              sql`${workItem.acceptedHead} = (${carried})`,
            ),
          ),
        ),
    );
  }
}

function latestOf(q: Q, itemId: string, head?: string) {
  const { closeoutProgress } = q.t;
  return {
    where:
      head === undefined
        ? eq(closeoutProgress.itemId, itemId)
        : and(eq(closeoutProgress.itemId, itemId), eq(closeoutProgress.head, head)),
    order: [desc(closeoutProgress.updatedAt), desc(closeoutProgress.id)],
  };
}

export function latestCloseoutIdentity(
  db: Database,
  itemId: string,
): { head: string; policyDigest: string } | null {
  return settled(sqliteDb(db).run((q) => latestCloseoutIdentitySteps(q, itemId)));
}

export function* latestCloseoutIdentitySteps(q: Q, itemId: string) {
  const { closeoutProgress } = q.t;
  const latest = latestOf(q, itemId);
  const row = yield* q.one(
    q.orm
      .select({ head: closeoutProgress.head, policyDigest: closeoutProgress.policyDigest })
      .from(closeoutProgress)
      .where(latest.where)
      .orderBy(...latest.order)
      .limit(1),
  );
  return row ?? null;
}

/**
 * The policy digest of the latest Closeout run on `head` and the digest of its checks marked
 * `recheck: true`, or null when no run was recorded. `recheck` is null when the run did not say.
 */
export function closeoutPolicyDigests(
  db: Database,
  itemId: string,
  head: string,
): { digest: string; recheck: string | null; decision: string | null } | null {
  return settled(sqliteDb(db).run((q) => closeoutPolicyDigestsSteps(q, itemId, head)));
}

export function* closeoutPolicyDigestsSteps(q: Q, itemId: string, head: string) {
  const { closeoutProgress } = q.t;
  const latest = latestOf(q, itemId, head);
  const row = yield* q.one(
    q.orm
      .select({
        digest: closeoutProgress.policyDigest,
        recheck: closeoutProgress.recheckDigest,
        decision: closeoutProgress.decision,
      })
      .from(closeoutProgress)
      .where(latest.where)
      .orderBy(...latest.order)
      .limit(1),
  );
  return row ?? null;
}

/** The policy digest of the latest Closeout run on `head`, or null when none was recorded. */
export function closeoutPolicyDigest(db: Database, itemId: string, head: string): string | null {
  return settled(sqliteDb(db).run((q) => closeoutPolicyDigestSteps(q, itemId, head)));
}

export function* closeoutPolicyDigestSteps(q: Q, itemId: string, head: string) {
  const { closeoutProgress } = q.t;
  const latest = latestOf(q, itemId, head);
  const row = yield* q.one(
    q.orm
      .select({ policyDigest: closeoutProgress.policyDigest })
      .from(closeoutProgress)
      .where(latest.where)
      .orderBy(...latest.order)
      .limit(1),
  );
  return row?.policyDigest ?? null;
}

/** The review steps of an accepted Closeout run, with the marks Closeout gave their findings. */
export type AcceptedCloseoutReviews = {
  taskId: string;
  head: string;
  reviews: Array<Pick<CloseoutStepRecord, "id" | "attempt" | "failOn" | "preExisting">>;
};

/**
 * The latest applicable Closeout run, only if accepted. Prefer `head` when recorded;
 * otherwise a head rebased after acceptance can carry the latest run.
 */
export function acceptedCloseoutReviews(
  db: Database,
  itemId: string,
  head: string | null,
): AcceptedCloseoutReviews | null {
  return settled(sqliteDb(db).run((q) => acceptedCloseoutReviewsSteps(q, itemId, head)));
}

export function* acceptedCloseoutReviewsSteps(
  q: Q,
  itemId: string,
  head: string | null,
): Steps<AcceptedCloseoutReviews | null> {
  const { closeoutProgress } = q.t;
  const latest = latestOf(q, itemId);
  const onHead = head === null ? [] : [sql`${closeoutProgress.head} = ${head} DESC`];
  const run = yield* q.one(
    q.orm
      .select({
        id: closeoutProgress.id,
        taskId: closeoutProgress.taskId,
        head: closeoutProgress.head,
        decision: closeoutProgress.decision,
      })
      .from(closeoutProgress)
      .where(latest.where)
      .orderBy(...onHead, ...latest.order)
      .limit(1),
  );
  if (run === undefined || run.decision !== "accepted") return null;
  return { taskId: run.taskId, head: run.head, reviews: yield* reviewStepsSteps(q, run.id) };
}

/** An accepted Closeout run with its review steps and when Closeout finished it. */
export type AcceptedCloseoutRun = AcceptedCloseoutReviews & { itemId: string; at: number };

/** Every accepted Closeout run, oldest first. */
export function acceptedCloseoutRuns(db: Database): AcceptedCloseoutRun[] {
  return settled(sqliteDb(db).run(acceptedCloseoutRunsSteps));
}

export function* acceptedCloseoutRunsSteps(q: Q): Steps<AcceptedCloseoutRun[]> {
  const { closeoutProgress } = q.t;
  const at = sql`COALESCE(${closeoutProgress.finishedAt}, ${closeoutProgress.updatedAt})`;
  const runs = yield* q.all(
    q.orm
      .select({
        id: closeoutProgress.id,
        itemId: closeoutProgress.itemId,
        taskId: closeoutProgress.taskId,
        head: closeoutProgress.head,
        at: at.mapWith(Number),
      })
      .from(closeoutProgress)
      .where(eq(closeoutProgress.decision, "accepted"))
      .orderBy(at, closeoutProgress.id),
  );
  const accepted: AcceptedCloseoutRun[] = [];
  for (const run of runs)
    accepted.push({
      itemId: run.itemId,
      taskId: run.taskId,
      head: run.head,
      at: run.at,
      reviews: yield* reviewStepsSteps(q, run.id),
    });
  return accepted;
}

function* reviewStepsSteps(q: Q, progressId: string): Steps<AcceptedCloseoutReviews["reviews"]> {
  const { closeoutStep } = q.t;
  const steps = yield* q.all(
    q.orm
      .select({
        id: closeoutStep.stepId,
        attempt: closeoutStep.attempt,
        failOn: closeoutStep.reviewFailOn,
        preExisting: closeoutStep.reviewPreExisting,
      })
      .from(closeoutStep)
      .where(and(eq(closeoutStep.progressId, progressId), eq(closeoutStep.kind, "review")))
      .orderBy(closeoutStep.ordinal, closeoutStep.stepId),
  );
  return steps.map((step) => ({
    id: step.id,
    attempt: step.attempt,
    failOn: step.failOn as CloseoutStepRecord["failOn"],
    preExisting: indexes(step.preExisting),
  }));
}

/** When Closeout first evaluated each head of the item, by head. */
export function closeoutHeadsStarted(db: Database, itemId: string): Map<string, number> {
  return settled(sqliteDb(db).run((q) => closeoutHeadsStartedSteps(q, itemId)));
}

export function* closeoutHeadsStartedSteps(q: Q, itemId: string) {
  const { closeoutProgress } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({ head: closeoutProgress.head, startedAt: min(closeoutProgress.startedAt) })
      .from(closeoutProgress)
      .where(eq(closeoutProgress.itemId, itemId))
      .groupBy(closeoutProgress.head),
  );
  return new Map(rows.map((row) => [row.head, row.startedAt!]));
}

/** Latest stored Closeout results for this exact candidate, using the item index. */
export function getCloseoutProgress(
  db: Database,
  itemId: string,
  head: string,
): CloseoutProgressRecord | null {
  return settled(sqliteDb(db).run((q) => getCloseoutProgressSteps(q, itemId, head)));
}

export function* getCloseoutProgressSteps(q: Q, itemId: string, head: string) {
  const { closeoutProgress, closeoutStep } = q.t;
  const latest = latestOf(q, itemId, head);
  const run = yield* q.one(
    q.orm
      .select()
      .from(closeoutProgress)
      .where(latest.where)
      .orderBy(...latest.order)
      .limit(1),
  );
  if (run === undefined) return null;
  const steps = yield* q.all(
    q.orm
      .select()
      .from(closeoutStep)
      .where(eq(closeoutStep.progressId, run.id))
      .orderBy(closeoutStep.ordinal, closeoutStep.stepId),
  );
  return progressRecord(run, steps);
}

export function listCloseoutProgress(db: Database): CloseoutProgressRecord[] {
  return settled(sqliteDb(db).run(listCloseoutProgressSteps));
}

export function* listCloseoutProgressSteps(q: Q) {
  const { closeoutProgress, closeoutStep } = q.t;
  const runs = yield* q.all(
    q.orm.select().from(closeoutProgress).orderBy(closeoutProgress.updatedAt, closeoutProgress.id),
  );
  const steps = yield* q.all(
    q.orm.select().from(closeoutStep).orderBy(closeoutStep.ordinal, closeoutStep.stepId),
  );
  return runs.map((run) =>
    progressRecord(
      run,
      steps.filter((step) => step.progressId === run.id),
    ),
  );
}

export type CloseoutProgressState = Pick<
  CloseoutProgressRecord,
  "id" | "itemId" | "head" | "policyDigest" | "decision" | "updatedAt" | "finishedAt"
> & { steps: Pick<CloseoutStepRecord, "state">[] };

export function listCloseoutProgressStates(db: Database): CloseoutProgressState[] {
  return settled(sqliteDb(db).run(listCloseoutProgressStatesSteps));
}

export function* listCloseoutProgressStatesSteps(q: Q): Steps<CloseoutProgressState[]> {
  const { closeoutProgress, closeoutStep } = q.t;
  const runs = yield* q.all(
    q.orm
      .select({
        id: closeoutProgress.id,
        itemId: closeoutProgress.itemId,
        head: closeoutProgress.head,
        policyDigest: closeoutProgress.policyDigest,
        decision: closeoutProgress.decision,
        updatedAt: closeoutProgress.updatedAt,
        finishedAt: closeoutProgress.finishedAt,
      })
      .from(closeoutProgress)
      .orderBy(closeoutProgress.updatedAt, closeoutProgress.id),
  );
  const steps = new Map<string, Pick<CloseoutStepRecord, "state">[]>();
  for (const step of yield* q.all(
    q.orm
      .select({ progressId: closeoutStep.progressId, state: closeoutStep.state })
      .from(closeoutStep)
      .orderBy(closeoutStep.ordinal, closeoutStep.stepId),
  ))
    steps.set(step.progressId, [
      ...(steps.get(step.progressId) ?? []),
      { state: step.state as CloseoutStepRecord["state"] },
    ]);
  return runs.map((run) => ({ ...run, steps: steps.get(run.id) ?? [] }));
}

function progressRecord(run: ProgressRow, steps: StepRow[]): CloseoutProgressRecord {
  return {
    id: run.id,
    itemId: run.itemId,
    taskId: run.taskId,
    base: run.base,
    head: run.head,
    policyDigest: run.policyDigest,
    policyPath: run.policyPath,
    decision: run.decision,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    finishedAt: run.finishedAt,
    steps: steps.map(mapStep),
  };
}

function mapStep(row: StepRow): CloseoutStepRecord {
  return {
    id: row.stepId,
    kind: row.kind as CloseoutStepRecord["kind"],
    state: row.state as CloseoutStepRecord["state"],
    command: row.command,
    detail: row.detail,
    attempt: row.attempt,
    timeoutSeconds: row.timeoutSeconds,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    exitCode: row.exitCode,
    timedOut: row.timedOut === 1,
    timeoutReason: row.timeoutReason,
    truncated: row.truncated === 1,
    logPath: row.logPath,
    evidencePath: row.evidencePath,
    ...reviewSnapshot(row),
    ordinal: row.ordinal,
    durationMs: row.durationMs,
    tokens: row.tokens,
    failOn: row.reviewFailOn as CloseoutStepRecord["failOn"],
    preExisting: indexes(row.reviewPreExisting),
    stdout: row.stdout,
    stderr: row.stderr,
  };
}

function reviewSnapshot(
  row: Pick<StepRow, "kind" | "attempt" | "findings">,
): Pick<CloseoutStepRecord, "findings" | "findingSeverities"> {
  if (row.kind === "review" && row.findings?.startsWith("{")) {
    try {
      const value = JSON.parse(row.findings) as Record<string, unknown> | null;
      if (
        value?.reviewSnapshot === 1 &&
        value.attempt === row.attempt &&
        (value.text === null || typeof value.text === "string") &&
        (value.severities === null || Array.isArray(value.severities))
      )
        return {
          findings: value.text,
          findingSeverities:
            Array.isArray(value.severities) &&
            value.severities.every((s) => ["P0", "P1", "P2", "P3"].includes(s))
              ? value.severities
              : null,
        };
    } catch {
      // Preserve legacy text; malformed snapshot envelopes cannot authorize approval.
      return { findings: row.findings.includes('"reviewSnapshot"') ? null : row.findings };
    }
    return { findings: row.findings.includes('"reviewSnapshot"') ? null : row.findings };
  }
  return { findings: row.findings };
}

function indexes(value: string | null): number[] | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((entry): entry is number => Number.isInteger(entry) && entry >= 0);
  } catch {
    return null;
  }
}

function progressKey(itemId: string, identity: CloseoutProgressIdentity): string {
  return [itemId, identity.taskId, identity.base, identity.head, identity.policyDigest].join("\n");
}

function bound(current: string, chunk: string): { text: string; truncated: boolean } {
  if (chunk.length === 0) return { text: current, truncated: false };
  const room = CLOSEOUT_OUTPUT_CAP_BYTES - Buffer.byteLength(current);
  if (room <= 0) return { text: current, truncated: true };
  if (Buffer.byteLength(chunk) <= room) return { text: current + chunk, truncated: false };
  return { text: current + clipUtf8(chunk, room), truncated: true };
}

function clipUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0) {
    const byte = bytes.at(end);
    if (byte === undefined || (byte & 0xc0) !== 0x80) break;
    end -= 1;
  }
  return bytes.subarray(0, end).toString("utf8");
}

/**
 * Notes on a running step why it has not reached its runner yet. Null clears
 * the note. The step's own state and attempt stay as they are.
 */
export function setRunningCloseoutStepDetail(
  db: Database,
  itemId: string,
  head: string,
  stepId: string,
  detail: string | null,
  now: number,
): void {
  settled(
    sqliteDb(db).transaction((q) =>
      setRunningCloseoutStepDetailSteps(q, itemId, head, stepId, detail, now),
    ),
  );
}

export function* setRunningCloseoutStepDetailSteps(
  q: Q,
  itemId: string,
  head: string,
  stepId: string,
  detail: string | null,
  now: number,
) {
  const { closeoutProgress, closeoutStep } = q.t;
  const running = and(eq(closeoutStep.stepId, stepId), eq(closeoutStep.state, "running"));
  const onHead = and(eq(closeoutProgress.itemId, itemId), eq(closeoutProgress.head, head));
  yield* q.exec(
    q.orm
      .update(closeoutStep)
      .set({ detail })
      .where(
        and(
          running,
          inArray(
            closeoutStep.progressId,
            q.orm.select({ id: closeoutProgress.id }).from(closeoutProgress).where(onHead),
          ),
        ),
      ),
  );
  yield* q.exec(
    q.orm
      .update(closeoutProgress)
      .set({ updatedAt: now })
      .where(
        and(
          onHead,
          inArray(
            closeoutProgress.id,
            q.orm.select({ id: closeoutStep.progressId }).from(closeoutStep).where(running),
          ),
        ),
      ),
  );
}

export function failedCloseoutReviews(
  db: Database,
  itemId: string,
): AcceptedCloseoutReviews | null {
  return settled(sqliteDb(db).run((q) => failedCloseoutReviewsSteps(q, itemId)));
}

export function* failedCloseoutReviewsSteps(
  q: Q,
  itemId: string,
): Steps<AcceptedCloseoutReviews | null> {
  const { closeoutProgress, closeoutStep } = q.t;
  const run = yield* q.one(
    q.orm
      .select({
        id: closeoutProgress.id,
        taskId: closeoutProgress.taskId,
        head: closeoutProgress.head,
      })
      .from(closeoutProgress)
      .where(and(eq(closeoutProgress.itemId, itemId), isNotNull(closeoutProgress.decision)))
      .orderBy(desc(closeoutProgress.updatedAt), desc(closeoutProgress.id))
      .limit(1),
  );
  if (run === undefined) return null;
  const steps = yield* q.all(
    q.orm
      .select({
        id: closeoutStep.stepId,
        attempt: closeoutStep.attempt,
        failOn: closeoutStep.reviewFailOn,
        preExisting: closeoutStep.reviewPreExisting,
      })
      .from(closeoutStep)
      .where(
        and(
          eq(closeoutStep.progressId, run.id),
          eq(closeoutStep.kind, "review"),
          inArray(closeoutStep.state, ["failed", "exhausted"]),
        ),
      )
      .orderBy(closeoutStep.ordinal, closeoutStep.stepId),
  );
  const reviews = steps.map((step) => ({
    id: step.id,
    attempt: step.attempt,
    failOn: step.failOn as NonNullable<CloseoutStepWrite["failOn"]> | null,
    preExisting: indexes(step.preExisting),
  }));
  return { taskId: run.taskId, head: run.head, reviews };
}
