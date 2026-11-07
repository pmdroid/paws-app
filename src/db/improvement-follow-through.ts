import type { Database } from "bun:sqlite";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  lte,
  ne,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { settled, sqliteDb, type Q, type Steps } from "./db";
import { jsonText, jsonValue } from "./json-text";

export type ImprovementIssueSyncStatus = "available" | "missing" | "unauthorized" | "unavailable";

export type ImprovementIssueSync = {
  improvementId: string;
  issueId: string;
  status: ImprovementIssueSyncStatus;
  stateType: string | null;
  teamId: string | null;
  delegated: boolean | null;
  observedAt: number;
  confirmedAt: number | null;
};

const typed = (value: string | number | null, type: "text" | "bigint") =>
  sql`CAST(${value} AS ${sql.raw(type)})`;

export function* improvementIssueSyncSteps(
  q: Q,
  improvementId: string,
): Steps<ImprovementIssueSync | null> {
  const { improvementIssueSync: sync } = q.t;
  const row = yield* q.one(q.orm.select().from(sync).where(eq(sync.improvementId, improvementId)));
  return row
    ? {
        ...row,
        status: row.status as ImprovementIssueSyncStatus,
        delegated: row.delegated === null ? null : row.delegated === 1,
      }
    : null;
}

export function improvementIssueSync(
  db: Database,
  improvementId: string,
): ImprovementIssueSync | null {
  return settled(sqliteDb(db).run((q) => improvementIssueSyncSteps(q, improvementId)));
}

type IssueSyncInput = {
  improvementId: string;
  issueId: string;
  status: ImprovementIssueSyncStatus;
  stateType?: string;
  teamId?: string;
  delegated?: boolean;
  observedAt: number;
};

export function* recordImprovementIssueSyncSteps(q: Q, input: IssueSyncInput): Steps<boolean> {
  const { improvement, improvementIssueSync: sync } = q.t;
  const available = input.status === "available";
  const delegated = available && input.delegated !== undefined ? (input.delegated ? 1 : 0) : null;
  const rows = yield* q.all(
    q.orm
      .insert(sync)
      .select(
        sql`SELECT ${typed(input.improvementId, "text")}, ${typed(input.issueId, "text")},
          ${typed(input.status, "text")}, ${typed(available ? (input.stateType ?? null) : null, "text")},
          ${typed(input.teamId ?? null, "text")}, ${typed(delegated, "bigint")},
          ${typed(input.observedAt, "bigint")}, ${typed(available ? input.observedAt : null, "bigint")}
        WHERE EXISTS (SELECT 1 FROM ${improvement} WHERE ${improvement.id} = ${input.improvementId}
          AND ${improvement.issueId} = ${input.issueId})`,
      )
      .onConflictDoUpdate({
        target: sync.improvementId,
        set: {
          status: sql`excluded.status`,
          issueId: sql`excluded.issue_id`,
          stateType: sql`CASE WHEN excluded.status = 'available' THEN excluded.state_type ELSE ${sync.stateType} END`,
          teamId: sql`coalesce(excluded.team_id, ${sync.teamId})`,
          delegated: sql`CASE WHEN excluded.status = 'available' THEN excluded.delegated ELSE ${sync.delegated} END`,
          observedAt: sql`excluded.observed_at`,
          confirmedAt: sql`coalesce(excluded.confirmed_at, ${sync.confirmedAt})`,
        },
        setWhere: sql`excluded.observed_at > ${sync.observedAt} OR ${sync.issueId} <> excluded.issue_id`,
      })
      .returning({ improvementId: sync.improvementId }),
  );
  return rows.length === 1;
}

export function recordImprovementIssueSync(db: Database, input: IssueSyncInput): boolean {
  return settled(sqliteDb(db).run((q) => recordImprovementIssueSyncSteps(q, input)));
}

export function* followThroughCandidatesSteps(
  q: Q,
  limit: number,
): Steps<{ id: string; workspaceId: string; issueId: string }[]> {
  const { improvement, improvementSweep } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({
        id: improvement.id,
        workspaceId: improvement.workspaceId,
        issueId: improvement.issueId,
      })
      .from(improvement)
      .leftJoin(improvementSweep, eq(improvementSweep.improvementId, improvement.id))
      .where(and(eq(improvement.reviewState, "accepted"), sql`${improvement.issueId} IS NOT NULL`))
      .orderBy(sql`coalesce(${improvementSweep.checkedAt}, 0)`, asc(improvement.id))
      .limit(limit),
  );
  return rows.map((row) => ({ ...row, issueId: row.issueId! }));
}

export function followThroughCandidates(
  db: Database,
  limit: number,
): { id: string; workspaceId: string; issueId: string }[] {
  return settled(sqliteDb(db).run((q) => followThroughCandidatesSteps(q, limit)));
}

export function* markImprovementCheckedSteps(
  q: Q,
  improvementId: string,
  now: number,
): Steps<void> {
  const { improvementSweep } = q.t;
  yield* q.exec(
    q.orm
      .insert(improvementSweep)
      .values({ improvementId, checkedAt: now })
      .onConflictDoUpdate({
        target: improvementSweep.improvementId,
        set: { checkedAt: sql`excluded.checked_at` },
      }),
  );
}

export function markImprovementChecked(db: Database, improvementId: string, now: number): void {
  settled(sqliteDb(db).run((q) => markImprovementCheckedSteps(q, improvementId, now)));
}

export type ImprovementDelegationState = "requested" | "started" | "existing" | "failed";

export type ImprovementDelegation = {
  improvementId: string;
  issueId: string;
  state: ImprovementDelegationState;
  sessionId: string | null;
  error: string | null;
  attempts: number;
  leaseExpiresAt: number | null;
  actor: string;
  requestedAt: number;
  updatedAt: number;
};

const delegationFromRow = (row: { state: string }) =>
  ({ ...row, state: row.state as ImprovementDelegationState }) as ImprovementDelegation;

export function* improvementDelegationSteps(
  q: Q,
  improvementId: string,
): Steps<ImprovementDelegation | null> {
  const { improvementDelegation: delegation } = q.t;
  const row = yield* q.one(
    q.orm.select().from(delegation).where(eq(delegation.improvementId, improvementId)),
  );
  return row ? delegationFromRow(row) : null;
}

export function improvementDelegation(
  db: Database,
  improvementId: string,
): ImprovementDelegation | null {
  return settled(sqliteDb(db).run((q) => improvementDelegationSteps(q, improvementId)));
}

type DelegationClaim = {
  improvementId: string;
  issueId: string;
  actor: string;
  now: number;
  leaseMs: number;
  again?: boolean;
};

export function* claimImprovementDelegationSteps(
  q: Q,
  input: DelegationClaim,
): Steps<ImprovementDelegation | null> {
  const { improvementDelegation: delegation } = q.t;
  const row = yield* q.one(
    q.orm
      .insert(delegation)
      .values({
        improvementId: input.improvementId,
        issueId: input.issueId,
        state: "requested",
        attempts: 1,
        leaseExpiresAt: input.now + input.leaseMs,
        actor: input.actor,
        requestedAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoUpdate({
        target: delegation.improvementId,
        set: {
          state: "requested",
          issueId: sql`excluded.issue_id`,
          attempts: sql`${delegation.attempts} + 1`,
          leaseExpiresAt: sql`excluded.lease_expires_at`,
          error: null,
          requestedAt: sql`excluded.requested_at`,
          actor: sql`excluded.actor`,
          updatedAt: sql`excluded.updated_at`,
        },
        setWhere: or(
          eq(delegation.state, "failed"),
          and(eq(delegation.state, "requested"), lte(delegation.leaseExpiresAt, input.now)),
          input.again ? inArray(delegation.state, ["started", "existing"]) : undefined,
        ),
      })
      .returning(),
  );
  return row ? delegationFromRow(row) : null;
}

export function claimImprovementDelegation(
  db: Database,
  input: DelegationClaim,
): ImprovementDelegation | null {
  return settled(sqliteDb(db).run((q) => claimImprovementDelegationSteps(q, input)));
}

type DelegationSettlement = {
  improvementId: string;
  attempts: number;
  state: Exclude<ImprovementDelegationState, "requested">;
  sessionId?: string;
  error?: string;
  now: number;
};

export function* settleImprovementDelegationSteps(
  q: Q,
  input: DelegationSettlement,
): Steps<boolean> {
  const { improvementDelegation: delegation } = q.t;
  const rows = yield* q.all(
    q.orm
      .update(delegation)
      .set({
        state: input.state,
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        error: input.error ?? null,
        leaseExpiresAt: null,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(delegation.improvementId, input.improvementId),
          eq(delegation.state, "requested"),
          eq(delegation.attempts, input.attempts),
        ),
      )
      .returning({ improvementId: delegation.improvementId }),
  );
  return rows.length === 1;
}

export function settleImprovementDelegation(db: Database, input: DelegationSettlement): boolean {
  return settled(sqliteDb(db).run((q) => settleImprovementDelegationSteps(q, input)));
}

type OtherDelegationQuery = { improvementId: string; issueId: string; now: number };

export function* otherDelegationForIssueSteps(
  q: Q,
  input: OtherDelegationQuery,
): Steps<ImprovementDelegation | null> {
  const { improvementDelegation: d, workItem: w } = q.t;
  const row = yield* q.one(
    q.orm
      .select()
      .from(d)
      .where(
        and(
          eq(d.issueId, input.issueId),
          ne(d.improvementId, input.improvementId),
          or(
            and(eq(d.state, "requested"), gt(d.leaseExpiresAt, input.now)),
            and(
              inArray(d.state, ["started", "existing"]),
              notExists(
                q.orm
                  .select({ one: sql`1` })
                  .from(w)
                  .where(
                    and(
                      eq(w.linearIssueId, d.issueId),
                      sql`${w.createdAt} >= ${d.requestedAt}`,
                      inArray(w.state, ["completed", "merged", "cancelled", "failed"]),
                    ),
                  ),
              ),
            ),
          ),
        ),
      )
      .orderBy(desc(d.updatedAt))
      .limit(1),
  );
  return row ? delegationFromRow(row) : null;
}

export function otherDelegationForIssue(
  db: Database,
  input: OtherDelegationQuery,
): ImprovementDelegation | null {
  return settled(sqliteDb(db).run((q) => otherDelegationForIssueSteps(q, input)));
}

export function* bumpImprovementVersionSteps(q: Q, improvementId: string): Steps<void> {
  const { improvement } = q.t;
  yield* q.exec(
    q.orm
      .update(improvement)
      .set({ version: sql`${improvement.version} + 1` })
      .where(eq(improvement.id, improvementId)),
  );
}

export function bumpImprovementVersion(db: Database, improvementId: string): void {
  settled(sqliteDb(db).run((q) => bumpImprovementVersionSteps(q, improvementId)));
}

export function* expiredImprovementDelegationsSteps(
  q: Q,
  now: number,
): Steps<ImprovementDelegation[]> {
  const { improvementDelegation: delegation } = q.t;
  const rows = yield* q.all(
    q.orm
      .select()
      .from(delegation)
      .where(and(eq(delegation.state, "requested"), lte(delegation.leaseExpiresAt, now))),
  );
  return rows.map(delegationFromRow);
}

export function expiredImprovementDelegations(db: Database, now: number): ImprovementDelegation[] {
  return settled(sqliteDb(db).run((q) => expiredImprovementDelegationsSteps(q, now)));
}

export type ImprovementActionKind =
  | "delegate"
  | "verify"
  | "contradict"
  | "criterion"
  | "acknowledge"
  | "redelegate"
  | "return_to_review"
  | "follow_work";

export type ImprovementAction = {
  id: number;
  improvementId: string;
  action: ImprovementActionKind;
  version: number;
  prior: Record<string, unknown>;
  detail: Record<string, unknown>;
  actor: string;
  at: number;
};

type ActionInput = {
  improvementId: string;
  expectedVersion: number;
  action: ImprovementActionKind;
  prior: Record<string, unknown>;
  detail: Record<string, unknown>;
  actor: string;
  now: number;
};

export function* recordImprovementActionSteps(q: Q, input: ActionInput): Steps<number | null> {
  const { improvement, improvementAction } = q.t;
  const version = input.expectedVersion + 1;
  const bumped = yield* q.all(
    q.orm
      .update(improvement)
      .set({ version })
      .where(
        and(
          eq(improvement.id, input.improvementId),
          eq(improvement.version, input.expectedVersion),
        ),
      )
      .returning({ id: improvement.id }),
  );
  if (bumped.length !== 1) return null;
  yield* q.exec(
    q.orm.insert(improvementAction).values({
      improvementId: input.improvementId,
      action: input.action,
      version,
      prior: jsonValue(q, input.prior),
      detail: jsonValue(q, input.detail),
      actor: input.actor,
      at: input.now,
    }),
  );
  return version;
}

export function recordImprovementAction(db: Database, input: ActionInput): number | null {
  return settled(sqliteDb(db).transaction((q) => recordImprovementActionSteps(q, input)));
}

export function* listImprovementActionsSteps(
  q: Q,
  improvementId: string,
): Steps<ImprovementAction[]> {
  const { improvementAction: action } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({
        id: action.id,
        improvementId: action.improvementId,
        action: action.action,
        version: action.version,
        prior: jsonText(q, action.prior),
        detail: jsonText(q, action.detail),
        actor: action.actor,
        at: action.at,
      })
      .from(action)
      .where(eq(action.improvementId, improvementId))
      .orderBy(asc(action.id)),
  );
  return rows.map((row) => ({
    ...row,
    action: row.action as ImprovementActionKind,
    prior: JSON.parse(row.prior) as Record<string, unknown>,
    detail: JSON.parse(row.detail) as Record<string, unknown>,
  }));
}

export function listImprovementActions(db: Database, improvementId: string): ImprovementAction[] {
  return settled(sqliteDb(db).run((q) => listImprovementActionsSteps(q, improvementId)));
}

type CriterionInput = {
  improvementId: string;
  proposalVersion: number;
  criterion: string;
  actor: string;
  now: number;
};

export function* annotateImprovementCriterionSteps(q: Q, input: CriterionInput): Steps<void> {
  const { improvementCriterion: criterion } = q.t;
  yield* q.exec(
    q.orm.insert(criterion).values({
      improvementId: input.improvementId,
      revision: sql`(SELECT coalesce(max(${criterion.revision}), 0) + 1 FROM ${criterion}
        WHERE ${criterion.improvementId} = ${input.improvementId})`,
      proposalVersion: input.proposalVersion,
      criterion: input.criterion,
      actor: input.actor,
      at: input.now,
    }),
  );
}

export function annotateImprovementCriterion(db: Database, input: CriterionInput): void {
  settled(sqliteDb(db).run((q) => annotateImprovementCriterionSteps(q, input)));
}

type ReturnToReview = { improvementId: string; version: number; actor: string; now: number };

export function* returnImprovementToReviewSteps(q: Q, input: ReturnToReview): Steps<void> {
  const {
    improvement,
    improvementDecision,
    improvementDelegation: delegation,
    improvementDelivery,
    improvementDeliveryAttempt,
    improvementIssueSync: sync,
    improvementWork,
  } = q.t;
  const id = input.improvementId;
  yield* q.exec(
    q.orm
      .delete(improvementDeliveryAttempt)
      .where(
        inArray(
          improvementDeliveryAttempt.deliveryId,
          q.orm
            .select({ id: improvementDelivery.id })
            .from(improvementDelivery)
            .where(eq(improvementDelivery.improvementId, id)),
        ),
      ),
  );
  yield* q.exec(q.orm.delete(improvementDelivery).where(eq(improvementDelivery.improvementId, id)));
  yield* q.exec(q.orm.delete(sync).where(eq(sync.improvementId, id)));
  yield* q.exec(q.orm.delete(delegation).where(eq(delegation.improvementId, id)));
  yield* q.exec(q.orm.delete(improvementWork).where(eq(improvementWork.improvementId, id)));
  yield* q.exec(
    q.orm
      .update(improvement)
      .set({
        reviewState: "needs_review",
        reviewedProposal: null,
        reviewedBy: input.actor,
        reviewedAt: input.now,
        reviewReason: null,
        intent: null,
        intentIssueId: null,
        evidenceComment: 0,
        issueId: null,
        issueIdentifier: null,
        issueUrl: null,
        issueConfirmedAt: null,
        implementationState: "unknown",
        implementationAt: input.now,
        verificationState: "unknown",
        verificationAt: input.now,
      })
      .where(and(eq(improvement.id, id), eq(improvement.version, input.version))),
  );
  yield* q.exec(
    q.orm.insert(improvementDecision).values({
      improvementId: id,
      version: input.version,
      reviewState: "needs_review",
      evidenceComment: 0,
      actor: input.actor,
      at: input.now,
    }),
  );
}

export function returnImprovementToReview(db: Database, input: ReturnToReview): void {
  settled(sqliteDb(db).transaction((q) => returnImprovementToReviewSteps(q, input)));
}

export type IssueWork = {
  itemId: string;
  state: string;
  identifier: string;
  repository: string | null;
  createdAt: number;
  updatedAt: number;
  acceptedHead: string | null;
  pull: { number: number; url: string | null; openedAt: number } | null;
  merge: { number: number; url: string | null; sha: string | null; confirmedAt: number } | null;
};

function issueWorkQuery(q: Q, join: "bound" | "any", where: SQL | undefined) {
  const { itemPullRequest: p, remoteMergeFact: m, workItem: w, workItemEvent: e } = q.t;
  const { improvementWork: b, workItemRepository: r } = q.t;
  const select = q.orm
    .select({
      id: w.id,
      state: w.state,
      identifier: w.linearIdentifier,
      createdAt: w.createdAt,
      acceptedHead: w.acceptedHead,
      owner: r.owner,
      repo: r.repo,
      updatedAt: sql<
        number | null
      >`(SELECT max(${e.at}) FROM ${e} WHERE ${e.itemId} = ${w.id})`.mapWith(Number),
      pullNumber: p.pullNumber,
      pullUrl: p.pullUrl,
      openedAt: p.openedAt,
      mergeNumber: m.pullNumber,
      mergeUrl: m.pullUrl,
      mergeSha: m.mergeSha,
      confirmedAt: m.confirmedAt,
    })
    .from(w)
    .leftJoin(r, eq(r.itemId, w.id))
    .leftJoin(p, eq(p.itemId, w.id))
    .leftJoin(m, eq(m.itemId, w.id));
  return (join === "bound" ? select.innerJoin(b, eq(b.itemId, w.id)) : select).where(where);
}

function inRepository(q: Q, repository: string): SQL {
  const { workItemRepository: r } = q.t;
  return sql`(${r.itemId} IS NULL OR ${r.owner} || '/' || ${r.repo} = ${repository})`;
}

function workFromRow(row: {
  id: string;
  state: string;
  identifier: string;
  createdAt: number;
  acceptedHead: string | null;
  owner: string | null;
  repo: string | null;
  updatedAt: number | null;
  pullNumber: number | null;
  pullUrl: string | null;
  openedAt: number | null;
  mergeNumber: number | null;
  mergeUrl: string | null;
  mergeSha: string | null;
  confirmedAt: number | null;
}): IssueWork {
  return {
    itemId: row.id,
    state: row.state,
    identifier: row.identifier,
    repository: row.owner && row.repo ? `${row.owner}/${row.repo}` : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt ?? row.createdAt,
    acceptedHead: row.acceptedHead,
    pull:
      row.pullNumber === null
        ? null
        : { number: row.pullNumber, url: row.pullUrl, openedAt: row.openedAt ?? 0 },
    merge:
      row.mergeNumber === null
        ? null
        : {
            number: row.mergeNumber,
            url: row.mergeUrl,
            sha: row.mergeSha,
            confirmedAt: row.confirmedAt ?? 0,
          },
  };
}

export type ImprovementWorkBinding = { issueId: string; itemId: string; boundAt: number };

export function* improvementWorkBindingSteps(
  q: Q,
  improvementId: string,
): Steps<ImprovementWorkBinding | null> {
  const { improvementWork: b } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ issueId: b.issueId, itemId: b.itemId, boundAt: b.boundAt })
      .from(b)
      .where(eq(b.improvementId, improvementId)),
  );
  return row ?? null;
}

export function improvementWorkBinding(
  db: Database,
  improvementId: string,
): ImprovementWorkBinding | null {
  return settled(sqliteDb(db).run((q) => improvementWorkBindingSteps(q, improvementId)));
}

type BoundImprovement = { id: string; issueId: string; repository: string };

export function* boundImprovementWorkSteps(
  q: Q,
  improvement: BoundImprovement,
): Steps<IssueWork | null> {
  const { improvementWork: b, workItem: w } = q.t;
  const row = yield* q.one(
    issueWorkQuery(
      q,
      "bound",
      and(
        eq(b.improvementId, improvement.id),
        eq(b.issueId, improvement.issueId),
        eq(w.linearIssueId, b.issueId),
        inRepository(q, improvement.repository),
      ),
    ).limit(1),
  );
  return row ? workFromRow(row) : null;
}

export function boundImprovementWork(
  db: Database,
  improvement: BoundImprovement,
): IssueWork | null {
  return settled(sqliteDb(db).run((q) => boundImprovementWorkSteps(q, improvement)));
}

type IssueWorkQuery = {
  issueId: string;
  repository: string;
  createdSince: number;
  linkedAt: number;
  exceptItemId?: string;
};

export function* newestIssueWorkSteps(q: Q, input: IssueWorkQuery): Steps<IssueWork | null> {
  const { workItem: w } = q.t;
  const row = yield* q.one(
    issueWorkQuery(
      q,
      "any",
      and(
        eq(w.linearIssueId, input.issueId),
        inRepository(q, input.repository),
        sql`${w.createdAt} >= ${input.createdSince}`,
        or(
          sql`${w.createdAt} >= ${input.linkedAt}`,
          sql`${w.state} NOT IN ('completed','merged','cancelled','failed')`,
        ),
        ne(w.id, input.exceptItemId ?? ""),
      ),
    )
      .orderBy(desc(w.createdAt), desc(w.id))
      .limit(1),
  );
  return row ? workFromRow(row) : null;
}

export function newestIssueWork(db: Database, input: IssueWorkQuery): IssueWork | null {
  return settled(sqliteDb(db).run((q) => newestIssueWorkSteps(q, input)));
}

type WorkBindingInput = {
  improvementId: string;
  issueId: string;
  itemId: string;
  expectedItemId: string | null;
  now: number;
};

export function* bindImprovementWorkSteps(q: Q, input: WorkBindingInput): Steps<boolean> {
  const { improvement, improvementWork: b } = q.t;
  const insert = q.orm.insert(b).select(
    sql`SELECT ${typed(input.improvementId, "text")}, ${typed(input.issueId, "text")},
        ${typed(input.itemId, "text")}, ${typed(input.now, "bigint")}
      WHERE EXISTS (SELECT 1 FROM ${improvement} WHERE ${improvement.id} = ${input.improvementId}
        AND ${improvement.issueId} = ${input.issueId})${
          input.expectedItemId === null
            ? sql``
            : sql` AND EXISTS (SELECT 1 FROM ${b} WHERE ${b.improvementId} = ${input.improvementId})`
        }`,
  );
  const rows = yield* q.all(
    (input.expectedItemId === null
      ? insert.onConflictDoNothing({ target: b.improvementId })
      : insert.onConflictDoUpdate({
          target: b.improvementId,
          set: {
            issueId: sql`excluded.issue_id`,
            itemId: sql`excluded.item_id`,
            boundAt: sql`excluded.bound_at`,
          },
          setWhere: eq(b.itemId, input.expectedItemId),
        })
    ).returning({ improvementId: b.improvementId }),
  );
  return rows.length === 1;
}

export function bindImprovementWork(db: Database, input: WorkBindingInput): boolean {
  return settled(sqliteDb(db).run((q) => bindImprovementWorkSteps(q, input)));
}

export type CloseoutStepResult = {
  progressId: string;
  stepId: string;
  itemId: string;
  head: string;
  kind: string;
  state: string;
  command: string;
  finishedAt: number | null;
};

export function* closeoutStepResultSteps(
  q: Q,
  progressId: string,
  stepId: string,
): Steps<CloseoutStepResult | null> {
  const { closeoutProgress: p, closeoutStep: s } = q.t;
  const row = yield* q.one(
    q.orm
      .select({
        progressId: s.progressId,
        stepId: s.stepId,
        itemId: p.itemId,
        head: p.head,
        kind: s.kind,
        state: s.state,
        command: s.command,
        finishedAt: s.finishedAt,
      })
      .from(s)
      .innerJoin(p, eq(p.id, s.progressId))
      .where(and(eq(s.progressId, progressId), eq(s.stepId, stepId)))
      .orderBy(desc(s.attempt))
      .limit(1),
  );
  return row ?? null;
}

export function closeoutStepResult(
  db: Database,
  progressId: string,
  stepId: string,
): CloseoutStepResult | null {
  return settled(sqliteDb(db).run((q) => closeoutStepResultSteps(q, progressId, stepId)));
}
