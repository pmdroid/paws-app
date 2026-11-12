import { and, asc, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { type Db, type Q, type Steps } from "./db";
import type { WorkItemRecord } from "./items";
import { parsedJson, jsonValue } from "./json-text";
import { ulid } from "./ulid";

const REASONS = "ci review conflict findings suggested follow_up";
export const FIX_RECORD_REASONS = REASONS.split(" ") as readonly FixReason[];
export type FixReason = "ci" | "review" | "conflict" | "findings" | "suggested" | "follow_up";

export type FixOutcome = "fixed" | "not_fixed" | "asked" | "abandoned";

export type FixTriggers = {
  checks?: { name: string; url: string | null }[];
  comments?: { id: number; author: string | null; excerpt: string }[];
  closeoutChecks?: string[];
  findings?: string[];
  base?: string;
};

export type FixRound = { reason?: FixReason; triggers?: FixTriggers; headBefore?: string | null };

type Row = Q["t"]["fixRecord"]["$inferSelect"];
export type FixRecord = Omit<Row, "reason" | "outcome" | "triggers"> & {
  reason: FixReason;
  outcome: FixOutcome | null;
  triggers: FixTriggers;
};

const EXCERPT_CHARS = 200;

export const checkTriggers = (checks: readonly { name: string; url: string | null }[]) =>
  checks.map(({ name, url }) => ({ name, url }));

type Comment = { commentId: number; author: string | null; body: string };
export const commentTriggers = (comments: readonly Comment[]) =>
  comments.map(({ commentId: id, author, body }) => ({
    id,
    author,
    excerpt: body.trim().slice(0, EXCERPT_CHARS),
  }));

function triggerKeys(triggers: FixTriggers): Set<string> {
  return new Set([
    ...(triggers.checks ?? []).map((check) => `check:${check.name}`),
    ...(triggers.comments ?? []).flatMap((comment) => [
      `comment:${comment.id}`,
      `text:${comment.author ?? ""}:${comment.excerpt}`,
    ]),
    ...(triggers.closeoutChecks ?? []).map((id) => `closeout:${id}`),
    ...(triggers.findings ?? []).map((id) => `finding:${id}`),
    ...(triggers.base ? [`base:${triggers.base}`] : []),
  ]);
}

function sameTrigger(open: FixRecord, reason: FixReason, triggers: FixTriggers): boolean {
  const before = triggerKeys(open.triggers);
  const after = triggerKeys(triggers);
  if (before.size === 0 && after.size === 0) return open.reason === reason && reason === "conflict";
  return [...after].some((key) => before.has(key));
}

export function* fixRecordSteps(
  q: Q,
  item: WorkItemRecord,
  input: { reason: FixReason; triggers: FixTriggers; headBefore: string | null; now: number },
): Steps<void> {
  const { fixRecord, workItemRepository } = q.t;
  for (const open of yield* openFixRecordsSteps(q, item.id))
    if (sameTrigger(open, input.reason, input.triggers))
      yield* endFixRecordSteps(q, open, { ...input, outcome: "not_fixed", head: input.headBefore });
  const count = yield* q.one(
    q.orm
      .select({ n: sql<number>`COUNT(*)`.mapWith(Number) })
      .from(fixRecord)
      .where(eq(fixRecord.itemId, item.id)),
  );
  const repository = yield* q.one(
    q.orm.select().from(workItemRepository).where(eq(workItemRepository.itemId, item.id)),
  );
  yield* q.exec(
    q.orm.insert(fixRecord).values({
      id: ulid(),
      itemId: item.id,
      runId: item.currentRunId,
      linearIdentifier: item.linearIdentifier,
      repository: repository ? `${repository.owner}/${repository.repo}` : null,
      reason: input.reason,
      triggers: jsonValue(q, input.triggers),
      round: (count?.n ?? 0) + 1,
      startedAt: input.now,
      headBefore: input.headBefore,
    }),
  );
}

export function* closeFixRecordsSteps(
  q: Q,
  itemId: string,
  input: { outcome: FixOutcome; head?: string | null; now: number },
): Steps<void> {
  for (const row of yield* openFixRecordsSteps(q, itemId))
    yield* endFixRecordSteps(q, row, { head: null, ...input });
}

function* endFixRecordSteps(
  q: Q,
  row: FixRecord,
  input: { outcome: FixOutcome; head: string | null; now: number },
): Steps<void> {
  const { fixRecord, runnerExecutionUsage: usage } = q.t;
  const turn = yield* q.one(
    q.orm
      .select({ agent: usage.agent, model: usage.model, resolved: usage.resolvedModel })
      .from(usage)
      .where(
        and(
          eq(usage.itemId, row.itemId),
          eq(usage.role, "implementer"),
          eq(usage.purpose, "work"),
          gte(usage.startedAt, row.startedAt),
        ),
      )
      .orderBy(desc(usage.startedAt))
      .limit(1),
  );
  yield* q.exec(
    q.orm
      .update(fixRecord)
      .set({
        endedAt: input.now,
        outcome: input.outcome,
        headAfter: input.head,
        durationMs: Math.max(0, input.now - row.startedAt),
        agent: turn?.agent ?? row.agent,
        model: turn?.resolved ?? turn?.model ?? row.model,
      })
      .where(and(eq(fixRecord.id, row.id), isNull(fixRecord.endedAt))),
  );
}

export function* openFixRecordsSteps(q: Q, itemId: string): Steps<FixRecord[]> {
  const { fixRecord } = q.t;
  const rows = yield* q.all(
    q.orm
      .select()
      .from(fixRecord)
      .where(and(eq(fixRecord.itemId, itemId), isNull(fixRecord.endedAt)))
      .orderBy(asc(fixRecord.startedAt), asc(fixRecord.id)),
  );
  return rows.map((row) => mapRow(q, row));
}

export type FixRecordFilter = {
  since?: number;
  reason?: FixReason;
  repository?: string;
  sessionIds?: readonly string[];
};

export function listFixRecords(store: Db, filter: FixRecordFilter = {}): Promise<FixRecord[]> {
  return store.run(function* (q) {
    const { fixRecord, workItem } = q.t;
    const scoped = filter.sessionIds !== undefined;
    if (scoped && filter.sessionIds!.length === 0) return [];
    const where = and(
      filter.since === undefined ? undefined : gte(fixRecord.startedAt, filter.since),
      filter.reason === undefined ? undefined : eq(fixRecord.reason, filter.reason),
      filter.repository === undefined ? undefined : eq(fixRecord.repository, filter.repository),
      scoped ? inArray(workItem.sessionKey, [...filter.sessionIds!]) : undefined,
    );
    const rows = yield* q.all(
      q.orm
        .select({ row: fixRecord })
        .from(fixRecord)
        .leftJoin(workItem, eq(workItem.id, fixRecord.itemId))
        .where(where)
        .orderBy(asc(fixRecord.startedAt), asc(fixRecord.id))
        .limit(1000),
    );
    return rows.map(({ row }) => mapRow(q, row));
  });
}

function mapRow(q: Q, row: Row): FixRecord {
  return {
    ...row,
    reason: row.reason as FixReason,
    outcome: row.outcome as FixOutcome | null,
    triggers: parsedJson<FixTriggers>(q, row.triggers),
  };
}
