import { createHash } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  lte,
  max,
  or,
  sql,
} from "drizzle-orm";
import { type Q, type Steps, type Db } from "./db";
import type * as pgSchema from "./schema-pg";
import { ulid } from "./ulid";

export type ImprovementSourceKind = "retro_item" | "daily_finding";
export type ImprovementSource = { kind: ImprovementSourceKind; key: string };
export type ImprovementActionStep = "automatic" | "rule" | "convention" | "decision" | "issue";
export type ImprovementReviewState = "needs_review" | "accepted" | "rejected";
export type ImprovementImplementationState =
  | "unknown"
  | "not_started"
  | "in_progress"
  | "blocked"
  | "merged"
  | "completed"
  | "canceled"
  | "stale";
export type ImprovementVerificationState = "unknown" | "due" | "verified" | "contradicted";
export type ImprovementDeliveryOperation = "create_issue" | "link_issue" | "evidence_comment";
export type ImprovementDeliveryState = "pending" | "claimed" | "succeeded" | "failed" | "unknown";
export type ImprovementDeliveryBlock =
  | "destination"
  | "unauthorized"
  | "unavailable"
  | "conflict"
  | "attempts"
  | "workspace";

export type ImprovementProposalInput = {
  title: string;
  problem: string;
  proposedChange: string;
  actionStep: ImprovementActionStep;
  verificationCriterion: string;
  evidence: string[];
};

export type ImprovementProposal = ImprovementProposalInput & {
  improvementId: string;
  version: number;
  source: ImprovementSource;
  contentSha256: string;
  createdAt: number;
};

export type Improvement = {
  id: string;
  workspaceId: string;
  repository: string;
  createdAt: number;
  version: number;
  reviewState: ImprovementReviewState;
  reviewedProposal: number | null;
  reviewedBy: string | null;
  reviewedAt: number | null;
  reviewReason: string | null;
  intent: "create" | "link" | null;
  intentIssueId: string | null;
  evidenceComment: boolean;
  issue: { id: string; identifier: string | null; url: string | null; confirmedAt: number } | null;
  implementationState: ImprovementImplementationState;
  implementationAt: number | null;
  verificationState: ImprovementVerificationState;
  verificationAt: number | null;
};

export type ImprovementDecision = {
  improvementId: string;
  version: number;
  reviewState: ImprovementReviewState;
  proposalVersion: number | null;
  intent: "create" | "link" | null;
  intentIssueId: string | null;
  evidenceComment: boolean;
  reason: string | null;
  actor: string;
  at: number;
};

export type ImprovementDelivery = {
  id: string;
  improvementId: string;
  operation: ImprovementDeliveryOperation;
  targetIssueId: string | null;
  targetTeamId: string | null;
  content: Record<string, unknown> | null;
  state: ImprovementDeliveryState;
  claimOwner: string | null;
  claimExpiresAt: number | null;
  attempts: number;
  remoteId: string | null;
  remoteIdentifier: string | null;
  remoteUrl: string | null;
  error: string | null;
  nextAttemptAt: number | null;
  blocked: ImprovementDeliveryBlock | null;
  retryBase: number;
  createdAt: number;
  updatedAt: number;
};

export type ImprovementOutcome =
  | { track: "implementation"; state: ImprovementImplementationState }
  | { track: "verification"; state: ImprovementVerificationState };

export type ImprovementOutcomeRecord = ImprovementOutcome & {
  id: number;
  improvementId: string;
  evidence: string[];
  revision: string | null;
  deployment: string | null;
  actor: string;
  recordedAt: number;
};

export type ImprovementIntent =
  | { kind: "create"; teamId?: string }
  | { kind: "link"; issueId: string; teamId?: string; addEvidenceComment?: boolean };

export type ImprovementReview =
  | { kind: "accept"; proposalVersion: number; intent: ImprovementIntent }
  | { kind: "reject"; reason: string }
  | { kind: "reopen" };

export type ImprovementDecisionResult =
  | { ok: true; improvement: Improvement }
  | {
      ok: false;
      reason: "not_found" | "stale" | "accepted" | "unknown_proposal" | "unchanged";
      improvement: Improvement | null;
    };

type ImprovementRow = typeof pgSchema.improvement.$inferSelect;
type DeliveryRow = typeof pgSchema.improvementDelivery.$inferSelect;

/** SQLite stores JSON as text, Postgres as `jsonb`. */
function jsonIn(q: Q, value: unknown): unknown {
  return q.dialect === "sqlite" ? JSON.stringify(value) : value;
}

function jsonOut<T>(q: Q, stored: unknown): T {
  return (q.dialect === "sqlite" ? JSON.parse(stored as string) : stored) as T;
}

function improvementFromRow(row: ImprovementRow): Improvement {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    repository: row.repository,
    createdAt: row.createdAt,
    version: row.version,
    reviewState: row.reviewState as ImprovementReviewState,
    reviewedProposal: row.reviewedProposal,
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt,
    reviewReason: row.reviewReason,
    intent: row.intent as Improvement["intent"],
    intentIssueId: row.intentIssueId,
    evidenceComment: row.evidenceComment === 1,
    issue:
      row.issueId === null
        ? null
        : {
            id: row.issueId,
            identifier: row.issueIdentifier,
            url: row.issueUrl,
            confirmedAt: row.issueConfirmedAt!,
          },
    implementationState: row.implementationState as ImprovementImplementationState,
    implementationAt: row.implementationAt,
    verificationState: row.verificationState as ImprovementVerificationState,
    verificationAt: row.verificationAt,
  };
}

export async function getImprovement(store: Db, id: string): Promise<Improvement | null> {
  return store.run((q) => getImprovementSteps(q, id));
}

export function* getImprovementSteps(q: Q, id: string) {
  const { improvement } = q.t;
  const row = yield* q.one(q.orm.select().from(improvement).where(eq(improvement.id, id)));
  return row === undefined ? null : improvementFromRow(row);
}

export async function improvementBySource(
  store: Db,
  workspaceId: string,
  source: ImprovementSource,
): Promise<Improvement | null> {
  return store.run((q) => improvementBySourceSteps(q, workspaceId, source));
}

export function* improvementBySourceSteps(q: Q, workspaceId: string, source: ImprovementSource) {
  const { improvement, improvementSource } = q.t;
  const row = yield* q.one(
    q.orm
      .select(getTableColumns(improvement))
      .from(improvementSource)
      .innerJoin(improvement, eq(improvement.id, improvementSource.improvementId))
      .where(
        and(
          eq(improvementSource.workspaceId, workspaceId),
          eq(improvementSource.sourceKind, source.kind),
          eq(improvementSource.sourceKey, source.key),
        ),
      ),
  );
  return row === undefined ? null : improvementFromRow(row);
}

export async function improvementsForIssue(
  store: Db,
  workspaceId: string,
  issueId: string,
): Promise<Improvement[]> {
  return store.run((q) => improvementsForIssueSteps(q, workspaceId, issueId));
}

export function* improvementsForIssueSteps(q: Q, workspaceId: string, issueId: string) {
  const { improvement } = q.t;
  const rows = yield* q.all(
    q.orm
      .select()
      .from(improvement)
      .where(and(eq(improvement.workspaceId, workspaceId), eq(improvement.issueId, issueId)))
      .orderBy(asc(improvement.createdAt), asc(improvement.id)),
  );
  return rows.map(improvementFromRow);
}

export async function listImprovements(store: Db, workspaceId: string): Promise<Improvement[]> {
  return store.run((q) => listImprovementsSteps(q, workspaceId));
}

export function* listImprovementsSteps(q: Q, workspaceId: string) {
  const { improvement } = q.t;
  const rows = yield* q.all(
    q.orm
      .select()
      .from(improvement)
      .where(eq(improvement.workspaceId, workspaceId))
      .orderBy(desc(improvement.createdAt), asc(improvement.id)),
  );
  return rows.map(improvementFromRow);
}

function proposalDigest(proposal: ImprovementProposalInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        proposal.title,
        proposal.problem,
        proposal.proposedChange,
        proposal.actionStep,
        proposal.verificationCriterion,
        proposal.evidence,
      ]),
    )
    .digest("hex");
}

function* nextProposalVersionSteps(q: Q, improvementId: string) {
  const { improvementProposal } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ version: max(improvementProposal.version) })
      .from(improvementProposal)
      .where(eq(improvementProposal.improvementId, improvementId)),
  );
  return (row?.version ?? 0) + 1;
}

type ProposalRecord = {
  workspaceId: string;
  repository: string;
  source: ImprovementSource;
  proposal: ImprovementProposalInput;
  attachTo?: string;
  now: number;
};

export async function recordImprovementProposal(
  store: Db,
  input: ProposalRecord,
): Promise<{ improvementId: string; version: number; created: boolean; changed: boolean }> {
  return store.transaction((q) => recordImprovementProposalSteps(q, input));
}

export function* recordImprovementProposalSteps(q: Q, input: ProposalRecord) {
  const { improvement, improvementSource, improvementProposal } = q.t;
  const digest = proposalDigest(input.proposal);
  const existing = yield* q.one(
    q.orm
      .select({ id: improvementSource.improvementId })
      .from(improvementSource)
      .where(
        and(
          eq(improvementSource.workspaceId, input.workspaceId),
          eq(improvementSource.sourceKind, input.source.kind),
          eq(improvementSource.sourceKey, input.source.key),
        ),
      ),
  );
  if (existing !== undefined && input.attachTo !== undefined && existing.id !== input.attachTo)
    throw new Error(
      `Source ${input.source.kind}:${input.source.key} belongs to another improvement`,
    );
  let improvementId: string;
  let version = 1;
  if (existing === undefined) {
    if (input.attachTo === undefined) {
      improvementId = ulid(input.now);
      yield* q.exec(
        q.orm.insert(improvement).values({
          id: improvementId,
          workspaceId: input.workspaceId,
          repository: input.repository,
          createdAt: input.now,
        }),
      );
    } else {
      const target = yield* getImprovementSteps(q, input.attachTo);
      if (
        target === null ||
        target.workspaceId !== input.workspaceId ||
        target.repository.toLowerCase() !== input.repository.toLowerCase()
      )
        throw new Error(`Improvement ${input.attachTo} is not in this workspace and repository`);
      improvementId = target.id;
      version = yield* nextProposalVersionSteps(q, improvementId);
    }
    yield* q.exec(
      q.orm.insert(improvementSource).values({
        workspaceId: input.workspaceId,
        sourceKind: input.source.kind,
        sourceKey: input.source.key,
        improvementId,
        createdAt: input.now,
      }),
    );
  } else {
    improvementId = existing.id;
    const latest = yield* q.one(
      q.orm
        .select({
          version: improvementProposal.version,
          contentSha256: improvementProposal.contentSha256,
        })
        .from(improvementProposal)
        .where(
          and(
            eq(improvementProposal.improvementId, improvementId),
            eq(improvementProposal.sourceKind, input.source.kind),
            eq(improvementProposal.sourceKey, input.source.key),
          ),
        )
        .orderBy(desc(improvementProposal.version))
        .limit(1),
    );
    if (latest?.contentSha256 === digest)
      return { improvementId, version: latest.version, created: false, changed: false };
    version = yield* nextProposalVersionSteps(q, improvementId);
  }
  const proposal = input.proposal;
  yield* q.exec(
    q.orm.insert(improvementProposal).values({
      improvementId,
      version,
      sourceKind: input.source.kind,
      sourceKey: input.source.key,
      title: proposal.title,
      problem: proposal.problem,
      proposedChange: proposal.proposedChange,
      actionStep: proposal.actionStep,
      verificationCriterion: proposal.verificationCriterion,
      evidence: jsonIn(q, proposal.evidence),
      contentSha256: digest,
      createdAt: input.now,
    }),
  );
  return {
    improvementId,
    version,
    created: existing === undefined && input.attachTo === undefined,
    changed: true,
  };
}

export async function listImprovementProposals(
  store: Db,
  improvementId: string,
): Promise<ImprovementProposal[]> {
  return store.run((q) => listImprovementProposalsSteps(q, improvementId));
}

export function* listImprovementProposalsSteps(q: Q, improvementId: string) {
  const { improvementProposal } = q.t;
  const rows = yield* q.all(
    q.orm
      .select()
      .from(improvementProposal)
      .where(eq(improvementProposal.improvementId, improvementId))
      .orderBy(asc(improvementProposal.version)),
  );
  return rows.map((row): ImprovementProposal => ({
    improvementId: row.improvementId,
    version: row.version,
    source: { kind: row.sourceKind as ImprovementSourceKind, key: row.sourceKey },
    title: row.title,
    problem: row.problem,
    proposedChange: row.proposedChange,
    actionStep: row.actionStep as ImprovementActionStep,
    verificationCriterion: row.verificationCriterion,
    evidence: jsonOut<string[]>(q, row.evidence),
    contentSha256: row.contentSha256,
    createdAt: row.createdAt,
  }));
}

export function improvementDeliveryId(
  improvementId: string,
  operation: ImprovementDeliveryOperation,
): string {
  const hex = createHash("sha256")
    .update(`paws:improvement:${improvementId}:${operation}`)
    .digest("hex");
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

type DecisionInput = {
  improvementId: string;
  expectedVersion: number;
  review: ImprovementReview;
  actor: string;
  now: number;
  content?: Record<string, unknown>;
  criterion?: string;
};

export async function decideImprovement(
  store: Db,
  input: DecisionInput,
): Promise<ImprovementDecisionResult> {
  return store.transaction((q) => decideImprovementSteps(q, input));
}

export function* decideImprovementSteps(
  q: Q,
  input: DecisionInput,
): Steps<ImprovementDecisionResult> {
  const { improvement, improvementCriterion, improvementDecision, improvementDelivery } = q.t;
  const { improvementDeliveryAttempt, improvementProposal } = q.t;
  const current = yield* getImprovementSteps(q, input.improvementId);
  if (current === null) return { ok: false, reason: "not_found", improvement: null };
  if (current.version !== input.expectedVersion)
    return { ok: false, reason: "stale", improvement: current };
  const review = input.review;
  if (current.reviewState === "accepted") {
    if (review.kind !== "reopen" || !(yield* improvementWithdrawableSteps(q, input.improvementId)))
      return { ok: false, reason: "accepted", improvement: current };
    yield* q.exec(
      q.orm
        .delete(improvementDeliveryAttempt)
        .where(
          inArray(
            improvementDeliveryAttempt.deliveryId,
            q.orm
              .select({ id: improvementDelivery.id })
              .from(improvementDelivery)
              .where(eq(improvementDelivery.improvementId, input.improvementId)),
          ),
        ),
    );
    yield* q.exec(
      q.orm
        .delete(improvementDelivery)
        .where(eq(improvementDelivery.improvementId, input.improvementId)),
    );
  }
  if (review.kind === "reopen" && current.reviewState === "needs_review")
    return { ok: false, reason: "unchanged", improvement: current };
  if (
    review.kind === "accept" &&
    (yield* q.one(
      q.orm
        .select({ version: improvementProposal.version })
        .from(improvementProposal)
        .where(
          and(
            eq(improvementProposal.improvementId, input.improvementId),
            eq(improvementProposal.version, review.proposalVersion),
          ),
        ),
    )) === undefined
  )
    return { ok: false, reason: "unknown_proposal", improvement: current };
  const state: ImprovementReviewState =
    review.kind === "accept" ? "accepted" : review.kind === "reject" ? "rejected" : "needs_review";
  const proposal = review.kind === "accept" ? review.proposalVersion : null;
  const intent = review.kind === "accept" ? review.intent.kind : null;
  const intentIssue =
    review.kind === "accept" && review.intent.kind === "link" ? review.intent.issueId : null;
  const comment =
    review.kind === "accept" && review.intent.kind === "link" && review.intent.addEvidenceComment
      ? 1
      : 0;
  const reason = review.kind === "reject" ? review.reason : null;
  const version = current.version + 1;
  yield* q.exec(
    q.orm
      .update(improvement)
      .set({
        version,
        reviewState: state,
        reviewedProposal: proposal,
        reviewedBy: input.actor,
        reviewedAt: input.now,
        reviewReason: reason,
        intent,
        intentIssueId: intentIssue,
        evidenceComment: comment,
      })
      .where(
        and(eq(improvement.id, input.improvementId), eq(improvement.version, current.version)),
      ),
  );
  yield* q.exec(
    q.orm.insert(improvementDecision).values({
      improvementId: input.improvementId,
      version,
      reviewState: state,
      proposalVersion: proposal,
      intent,
      intentIssueId: intentIssue,
      evidenceComment: comment,
      reason,
      actor: input.actor,
      at: input.now,
    }),
  );
  if (review.kind === "accept") {
    const operation = review.intent.kind === "create" ? "create_issue" : "link_issue";
    const team = review.intent.teamId ?? null;
    const content = input.content === undefined ? null : jsonIn(q, input.content);
    const delivery = (kind: ImprovementDeliveryOperation) => ({
      id: improvementDeliveryId(input.improvementId, kind),
      improvementId: input.improvementId,
      operation: kind,
      targetIssueId: intentIssue,
      targetTeamId: team,
      content,
      state: "pending",
      createdAt: input.now,
      updatedAt: input.now,
    });
    yield* q.exec(q.orm.insert(improvementDelivery).values(delivery(operation)));
    if (comment === 1)
      yield* q.exec(q.orm.insert(improvementDelivery).values(delivery("evidence_comment")));
    if (input.criterion !== undefined)
      yield* q.exec(
        q.orm.insert(improvementCriterion).values({
          improvementId: input.improvementId,
          revision: sql`(SELECT coalesce(max(${improvementCriterion.revision}), 0) + 1
            FROM ${improvementCriterion}
            WHERE ${improvementCriterion.improvementId} = ${input.improvementId})`,
          proposalVersion: review.proposalVersion,
          criterion: input.criterion,
          actor: input.actor,
          at: input.now,
        }),
      );
  }
  return { ok: true, improvement: (yield* getImprovementSteps(q, input.improvementId))! };
}

export async function improvementWithdrawable(store: Db, improvementId: string): Promise<boolean> {
  return store.run((q) => improvementWithdrawableSteps(q, improvementId));
}

export function* improvementWithdrawableSteps(q: Q, improvementId: string) {
  const { improvementDelivery } = q.t;
  const rows = yield* q.all(
    q.orm
      .select()
      .from(improvementDelivery)
      .where(eq(improvementDelivery.improvementId, improvementId)),
  );
  const link = rows.find((row) => row.operation === "link_issue");
  return (
    link !== undefined &&
    link.state === "failed" &&
    link.blocked !== null &&
    rows.every(
      (row) =>
        row.operation !== "create_issue" &&
        row.remoteId === null &&
        (row.state === "pending" || row.state === "failed"),
    )
  );
}

export async function cancelImprovementEvidenceComment(
  store: Db,
  deliveryId: string,
): Promise<Improvement | null> {
  return store.transaction((q) => cancelImprovementEvidenceCommentSteps(q, deliveryId));
}

export function* cancelImprovementEvidenceCommentSteps(q: Q, deliveryId: string) {
  const { improvement, improvementDelivery, improvementDeliveryAttempt } = q.t;
  const current = yield* q.one(
    q.orm.select().from(improvementDelivery).where(eq(improvementDelivery.id, deliveryId)),
  );
  if (
    current === undefined ||
    current.operation !== "evidence_comment" ||
    current.state !== "failed" ||
    current.blocked === null ||
    current.remoteId !== null
  )
    return null;
  const link = yield* q.one(
    q.orm
      .select({ state: improvementDelivery.state })
      .from(improvementDelivery)
      .where(
        and(
          eq(improvementDelivery.improvementId, current.improvementId),
          eq(improvementDelivery.operation, "link_issue"),
        ),
      ),
  );
  if (link?.state !== "succeeded") return null;
  yield* q.exec(
    q.orm
      .delete(improvementDeliveryAttempt)
      .where(eq(improvementDeliveryAttempt.deliveryId, current.id)),
  );
  yield* q.exec(q.orm.delete(improvementDelivery).where(eq(improvementDelivery.id, current.id)));
  yield* q.exec(
    q.orm
      .update(improvement)
      .set({ evidenceComment: 0 })
      .where(eq(improvement.id, current.improvementId)),
  );
  return yield* getImprovementSteps(q, current.improvementId);
}

export type ImprovementCriterion = {
  revision: number;
  proposalVersion: number;
  criterion: string;
  actor: string;
  at: number;
};

export async function listImprovementCriteria(
  store: Db,
  improvementId: string,
): Promise<ImprovementCriterion[]> {
  return store.run((q) => listImprovementCriteriaSteps(q, improvementId));
}

export function* listImprovementCriteriaSteps(q: Q, improvementId: string) {
  const { improvementCriterion } = q.t;
  return yield* q.all(
    q.orm
      .select({
        revision: improvementCriterion.revision,
        proposalVersion: improvementCriterion.proposalVersion,
        criterion: improvementCriterion.criterion,
        actor: improvementCriterion.actor,
        at: improvementCriterion.at,
      })
      .from(improvementCriterion)
      .where(eq(improvementCriterion.improvementId, improvementId))
      .orderBy(asc(improvementCriterion.revision)),
  );
}

export async function requeueImprovementDelivery(
  store: Db,
  input: { deliveryId: string; now: number },
): Promise<ImprovementDelivery | null> {
  return store.run((q) => requeueImprovementDeliverySteps(q, input));
}

export function* requeueImprovementDeliverySteps(q: Q, input: { deliveryId: string; now: number }) {
  const { improvementDelivery: d } = q.t;
  const row = yield* q.one(
    q.orm
      .update(d)
      .set({
        state: sql`CASE ${d.state} WHEN 'unknown' THEN 'unknown' ELSE 'pending' END`,
        blocked: null,
        nextAttemptAt: null,
        retryBase: sql`${d.attempts}`,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(d.id, input.deliveryId),
          or(eq(d.state, "failed"), and(eq(d.state, "unknown"), isNotNull(d.blocked))),
        ),
      )
      .returning(),
  );
  return row === undefined ? null : deliveryFromRow(q, row);
}

export async function repairImprovementDestination(
  store: Db,
  input: { deliveryId: string; teamId: string; now: number },
): Promise<ImprovementDelivery | null> {
  return store.transaction((q) => repairImprovementDestinationSteps(q, input));
}

export function* repairImprovementDestinationSteps(
  q: Q,
  input: { deliveryId: string; teamId: string; now: number },
) {
  const { improvementDelivery: d } = q.t;
  const current = yield* q.one(q.orm.select().from(d).where(eq(d.id, input.deliveryId)));
  if (
    current === undefined ||
    current.operation !== "create_issue" ||
    current.state !== "failed" ||
    current.blocked !== "destination" ||
    current.remoteId !== null
  )
    return null;
  const row = yield* q.one(
    q.orm
      .update(d)
      .set({
        targetTeamId: input.teamId,
        state: "pending",
        blocked: null,
        nextAttemptAt: null,
        retryBase: sql`${d.attempts}`,
        error: null,
        updatedAt: input.now,
      })
      .where(eq(d.id, input.deliveryId))
      .returning(),
  );
  return row === undefined ? null : deliveryFromRow(q, row);
}

type RemoteReservation = { deliveryId: string; owner: string; attempt: number; remoteId: string };

export async function reserveImprovementDeliveryRemote(
  store: Db,
  input: RemoteReservation,
): Promise<boolean> {
  return store.run((q) => reserveImprovementDeliveryRemoteSteps(q, input));
}

export function* reserveImprovementDeliveryRemoteSteps(q: Q, input: RemoteReservation) {
  const { improvementDelivery: d } = q.t;
  const rows = yield* q.all(
    q.orm
      .update(d)
      .set({ remoteId: input.remoteId })
      .where(
        and(
          eq(d.id, input.deliveryId),
          eq(d.state, "claimed"),
          eq(d.claimOwner, input.owner),
          eq(d.attempts, input.attempt),
          or(isNull(d.remoteId), eq(d.remoteId, input.remoteId)),
        ),
      )
      .returning({ id: d.id }),
  );
  return rows.length === 1;
}

/** A delivery that is due: open and unblocked past its retry time, or claimed past its lease. */
function deliveryDue(q: Q, now: number) {
  const { improvementDelivery: d } = q.t;
  return or(
    and(
      inArray(d.state, ["pending", "failed", "unknown"]),
      isNull(d.blocked),
      or(isNull(d.nextAttemptAt), lte(d.nextAttemptAt, now)),
    ),
    and(eq(d.state, "claimed"), lte(d.claimExpiresAt, now)),
  );
}

export async function improvementDeliveryWorkspaces(store: Db, now: number): Promise<string[]> {
  return store.run((q) => improvementDeliveryWorkspacesSteps(q, now));
}

export function* improvementDeliveryWorkspacesSteps(q: Q, now: number) {
  const { improvement, improvementDelivery: d } = q.t;
  const rows = yield* q.all(
    q.orm
      .selectDistinct({ workspaceId: improvement.workspaceId })
      .from(d)
      .innerJoin(improvement, eq(improvement.id, d.improvementId))
      .where(deliveryDue(q, now))
      .orderBy(asc(improvement.workspaceId)),
  );
  return rows.map((row) => row.workspaceId);
}

export async function acceptedImprovementsForFindings(
  store: Db,
  workspaceId: string,
  findingIds: readonly number[],
): Promise<Improvement[]> {
  return store.run((q) => acceptedImprovementsForFindingsSteps(q, workspaceId, findingIds));
}

export function* acceptedImprovementsForFindingsSteps(
  q: Q,
  workspaceId: string,
  findingIds: readonly number[],
) {
  if (findingIds.length === 0) return [];
  const { improvement, improvementSource: source } = q.t;
  const ids = q.dialect === "sqlite" ? JSON.stringify(findingIds) : `{${findingIds.join(",")}}`;
  const findings =
    q.dialect === "sqlite"
      ? sql`SELECT 1 FROM json_each(${ids}) AS finding
          WHERE instr(${source.sourceKey}, '#' || finding.value || ':') > 0`
      : sql`SELECT 1 FROM unnest(${ids}::bigint[]) AS finding(value)
          WHERE strpos(${source.sourceKey}, '#' || finding.value || ':') > 0`;
  const rows = yield* q.all(
    q.orm
      .selectDistinct(getTableColumns(improvement))
      .from(source)
      .innerJoin(improvement, eq(improvement.id, source.improvementId))
      .where(
        and(
          eq(source.workspaceId, workspaceId),
          eq(source.sourceKind, "daily_finding"),
          eq(improvement.reviewState, "accepted"),
          sql`EXISTS (${findings})`,
        ),
      )
      .orderBy(asc(improvement.id)),
  );
  return rows.map(improvementFromRow);
}

export async function listImprovementDecisions(
  store: Db,
  improvementId: string,
): Promise<ImprovementDecision[]> {
  return store.run((q) => listImprovementDecisionsSteps(q, improvementId));
}

export function* listImprovementDecisionsSteps(q: Q, improvementId: string) {
  const { improvementDecision } = q.t;
  const rows = yield* q.all(
    q.orm
      .select()
      .from(improvementDecision)
      .where(eq(improvementDecision.improvementId, improvementId))
      .orderBy(asc(improvementDecision.version)),
  );
  return rows.map((row): ImprovementDecision => ({
    improvementId: row.improvementId,
    version: row.version,
    reviewState: row.reviewState as ImprovementReviewState,
    proposalVersion: row.proposalVersion,
    intent: row.intent as ImprovementDecision["intent"],
    intentIssueId: row.intentIssueId,
    evidenceComment: row.evidenceComment === 1,
    reason: row.reason,
    actor: row.actor,
    at: row.at,
  }));
}

function deliveryFromRow(q: Q, row: DeliveryRow): ImprovementDelivery {
  return {
    id: row.id,
    improvementId: row.improvementId,
    operation: row.operation as ImprovementDeliveryOperation,
    targetIssueId: row.targetIssueId,
    targetTeamId: row.targetTeamId,
    content: row.content === null ? null : jsonOut<Record<string, unknown>>(q, row.content),
    state: row.state as ImprovementDeliveryState,
    claimOwner: row.claimOwner,
    claimExpiresAt: row.claimExpiresAt,
    attempts: row.attempts,
    remoteId: row.remoteId,
    remoteIdentifier: row.remoteIdentifier,
    remoteUrl: row.remoteUrl,
    error: row.error,
    nextAttemptAt: row.nextAttemptAt,
    blocked: row.blocked as ImprovementDeliveryBlock | null,
    retryBase: row.retryBase,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listImprovementDeliveries(
  store: Db,
  improvementId: string,
): Promise<ImprovementDelivery[]> {
  return store.run((q) => listImprovementDeliveriesSteps(q, improvementId));
}

export function* listImprovementDeliveriesSteps(q: Q, improvementId: string) {
  const { improvementDelivery: d } = q.t;
  const rows = yield* q.all(
    q.orm
      .select()
      .from(d)
      .where(eq(d.improvementId, improvementId))
      .orderBy(asc(d.createdAt), asc(d.operation)),
  );
  return rows.map((row) => deliveryFromRow(q, row));
}

export async function claimableImprovementDeliveries(
  store: Db,
  workspaceId: string,
  now: number,
): Promise<ImprovementDelivery[]> {
  return store.run((q) => claimableImprovementDeliveriesSteps(q, workspaceId, now));
}

export function* claimableImprovementDeliveriesSteps(q: Q, workspaceId: string, now: number) {
  const { improvement, improvementDelivery: d } = q.t;
  const rows = yield* q.all(
    q.orm
      .select(getTableColumns(d))
      .from(d)
      .innerJoin(improvement, eq(improvement.id, d.improvementId))
      .where(and(eq(improvement.workspaceId, workspaceId), deliveryDue(q, now)))
      .orderBy(asc(d.createdAt), asc(d.id)),
  );
  return rows.map((row) => deliveryFromRow(q, row));
}

type DeliveryClaim = { deliveryId: string; owner: string; now: number; leaseMs: number };

export async function claimImprovementDelivery(
  store: Db,
  input: DeliveryClaim,
): Promise<ImprovementDelivery | null> {
  return store.transaction((q) => claimImprovementDeliverySteps(q, input));
}

export function* claimImprovementDeliverySteps(q: Q, input: DeliveryClaim) {
  const { improvementDelivery: d, improvementDeliveryAttempt: attempt } = q.t;
  const row = yield* q.one(
    q.orm
      .update(d)
      .set({
        state: "claimed",
        claimOwner: input.owner,
        claimExpiresAt: input.now + input.leaseMs,
        attempts: sql`${d.attempts} + 1`,
        updatedAt: input.now,
      })
      .where(and(eq(d.id, input.deliveryId), deliveryDue(q, input.now)))
      .returning(),
  );
  if (row === undefined) return null;
  yield* q.exec(
    q.orm
      .update(attempt)
      .set({ outcome: "expired", settledAt: input.now })
      .where(and(eq(attempt.deliveryId, row.id), eq(attempt.outcome, "claimed"))),
  );
  yield* q.exec(
    q.orm.insert(attempt).values({
      deliveryId: row.id,
      attempt: row.attempts,
      owner: input.owner,
      claimedAt: input.now,
      claimExpiresAt: input.now + input.leaseMs,
    }),
  );
  return deliveryFromRow(q, row);
}

type DeliverySettlement = {
  deliveryId: string;
  attempt: number;
  owner: string;
  outcome: "succeeded" | "failed" | "unknown";
  remote?: { id: string; identifier?: string; url?: string };
  error?: string;
  retryAt?: number;
  blocked?: ImprovementDeliveryBlock;
  now: number;
};

export async function settleImprovementDelivery(
  store: Db,
  input: DeliverySettlement,
): Promise<boolean> {
  return store.transaction((q) => settleImprovementDeliverySteps(q, input));
}

export function* settleImprovementDeliverySteps(q: Q, input: DeliverySettlement) {
  const { improvement, improvementDelivery: d, improvementDeliveryAttempt: attempt } = q.t;
  if (input.outcome === "succeeded" && input.remote === undefined)
    throw new Error("A succeeded delivery needs its remote record");
  const error = input.outcome === "succeeded" ? null : (input.error ?? null);
  const row = yield* q.one(
    q.orm
      .update(d)
      .set({
        state: input.outcome,
        remoteId: sql`coalesce(${input.remote?.id ?? null}, ${d.remoteId})`,
        remoteIdentifier: sql`coalesce(${input.remote?.identifier ?? null}, ${d.remoteIdentifier})`,
        remoteUrl: sql`coalesce(${input.remote?.url ?? null}, ${d.remoteUrl})`,
        error,
        nextAttemptAt: input.outcome === "succeeded" ? null : (input.retryAt ?? null),
        blocked: input.outcome === "succeeded" ? null : (input.blocked ?? null),
        claimOwner: null,
        claimExpiresAt: null,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(d.id, input.deliveryId),
          eq(d.state, "claimed"),
          eq(d.claimOwner, input.owner),
          eq(d.attempts, input.attempt),
        ),
      )
      .returning(),
  );
  if (row === undefined) return false;
  yield* q.exec(
    q.orm
      .update(attempt)
      .set({
        outcome: input.outcome,
        remoteId: input.remote?.id ?? null,
        remoteIdentifier: input.remote?.identifier ?? null,
        remoteUrl: input.remote?.url ?? null,
        error,
        settledAt: input.now,
      })
      .where(
        and(
          eq(attempt.deliveryId, input.deliveryId),
          eq(attempt.attempt, input.attempt),
          eq(attempt.outcome, "claimed"),
        ),
      ),
  );
  if (input.outcome === "succeeded" && row.operation !== "evidence_comment")
    yield* q.exec(
      q.orm
        .update(improvement)
        .set({
          issueId: row.operation === "link_issue" ? row.targetIssueId : row.remoteId,
          issueIdentifier: row.remoteIdentifier,
          issueUrl: row.remoteUrl,
          issueConfirmedAt: input.now,
        })
        .where(and(eq(improvement.id, row.improvementId), isNull(improvement.issueId))),
    );
  return true;
}

export type ImprovementDeliveryAttempt = {
  attempt: number;
  owner: string;
  claimedAt: number;
  claimExpiresAt: number;
  outcome: "claimed" | "succeeded" | "failed" | "unknown" | "expired";
  remoteId: string | null;
  remoteIdentifier: string | null;
  remoteUrl: string | null;
  error: string | null;
  settledAt: number | null;
};

export async function listImprovementDeliveryAttempts(
  store: Db,
  deliveryId: string,
): Promise<ImprovementDeliveryAttempt[]> {
  return store.run((q) => listImprovementDeliveryAttemptsSteps(q, deliveryId));
}

export function* listImprovementDeliveryAttemptsSteps(q: Q, deliveryId: string) {
  const { improvementDeliveryAttempt: attempt } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({
        attempt: attempt.attempt,
        owner: attempt.owner,
        claimedAt: attempt.claimedAt,
        claimExpiresAt: attempt.claimExpiresAt,
        outcome: attempt.outcome,
        remoteId: attempt.remoteId,
        remoteIdentifier: attempt.remoteIdentifier,
        remoteUrl: attempt.remoteUrl,
        error: attempt.error,
        settledAt: attempt.settledAt,
      })
      .from(attempt)
      .where(eq(attempt.deliveryId, deliveryId))
      .orderBy(asc(attempt.attempt)),
  );
  return rows as ImprovementDeliveryAttempt[];
}

type OutcomeInput = ImprovementOutcome & {
  improvementId: string;
  evidence: string[];
  revision?: string;
  deployment?: string;
  actor: string;
  now: number;
};

export async function recordImprovementOutcome(
  store: Db,
  input: OutcomeInput,
): Promise<ImprovementOutcomeRecord> {
  return store.transaction((q) => recordImprovementOutcomeSteps(q, input));
}

export function* recordImprovementOutcomeSteps(q: Q, input: OutcomeInput) {
  if (input.track === "verification" && input.state === "verified" && input.evidence.length === 0)
    throw new Error("Verified needs evidence for the stated criterion");
  const { improvement, improvementOutcome } = q.t;
  const inserted = yield* q.one(
    q.orm
      .insert(improvementOutcome)
      .values({
        improvementId: input.improvementId,
        track: input.track,
        state: input.state,
        evidence: jsonIn(q, input.evidence),
        revision: input.revision ?? null,
        deployment: input.deployment ?? null,
        actor: input.actor,
        recordedAt: input.now,
      })
      .returning({ id: improvementOutcome.id }),
  );
  const changed = yield* q.all(
    q.orm
      .update(improvement)
      .set(
        input.track === "implementation"
          ? { implementationState: input.state, implementationAt: input.now }
          : { verificationState: input.state, verificationAt: input.now },
      )
      .where(eq(improvement.id, input.improvementId))
      .returning({ id: improvement.id }),
  );
  if (changed.length !== 1) throw new Error(`Unknown improvement ${input.improvementId}`);
  return {
    id: inserted!.id,
    improvementId: input.improvementId,
    ...({ track: input.track, state: input.state } as ImprovementOutcome),
    evidence: input.evidence,
    revision: input.revision ?? null,
    deployment: input.deployment ?? null,
    actor: input.actor,
    recordedAt: input.now,
  } as ImprovementOutcomeRecord;
}

export async function listImprovementOutcomes(
  store: Db,
  improvementId: string,
): Promise<ImprovementOutcomeRecord[]> {
  return store.run((q) => listImprovementOutcomesSteps(q, improvementId));
}

export function* listImprovementOutcomesSteps(q: Q, improvementId: string) {
  const { improvementOutcome } = q.t;
  const rows = yield* q.all(
    q.orm
      .select()
      .from(improvementOutcome)
      .where(eq(improvementOutcome.improvementId, improvementId))
      .orderBy(asc(improvementOutcome.id)),
  );
  return rows.map(
    (row) =>
      ({
        id: row.id,
        improvementId: row.improvementId,
        track: row.track,
        state: row.state,
        evidence: jsonOut<string[]>(q, row.evidence),
        revision: row.revision,
        deployment: row.deployment,
        actor: row.actor,
        recordedAt: row.recordedAt,
      }) as ImprovementOutcomeRecord,
  );
}
