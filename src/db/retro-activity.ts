import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { Db, Q, Steps } from "./db";
import {
  listImprovementProposalsSteps,
  listImprovementsSteps,
  type ImprovementSource,
} from "./improvements";
import { jsonText } from "./json-text";
import { MIGRATIONS_FOLDER, migrationTags, PG_MIGRATIONS_FOLDER } from "./migrate";
import { teamRepositoryAllowedSql } from "./repository-catalog";

export type RetroActivityItem = {
  id: string;
  identifier: string;
  title: string;
  repository: string;
  state: string;
  version: number;
  createdAt: number;
  pullNumber: number | null;
  pullOpenedAt: number | null;
  counters: {
    agentMs: number;
    closeoutMs: number;
    waitingMs: number;
    recheckMs: number;
    awakeMs: number;
    turnCount: number;
    recoveryAttempts: number;
  };
};

export type RetroActivityRun = {
  id: string;
  itemId: string;
  kind: string;
  agent: string;
  status: string;
  createdAt: number;
  updatedAt: number;
};

export type RetroActivityTransition = {
  id: number;
  itemId: string;
  version: number;
  at: number;
  fromState: string;
  toState: string;
  event: string;
  kind: "transition" | "restart" | "ask";
  reason: string | null;
};

export type RetroActivityQuestion = {
  id: string;
  itemId: string;
  runId: string | null;
  kind: string;
  reason: string | null;
  body: string;
  answer: string | null;
  status: string;
  createdAt: number;
  answeredAt: number | null;
  cancelledAt: number | null;
  answerEventKey: string | null;
};

export type RetroActivityMessage = {
  ordinal: number;
  eventKey: string;
  activityId: string | null;
  itemId: string;
  body: string;
  createdAt: number;
};

export type RetroActivityCheck = {
  progressId: string;
  stepId: string;
  itemId: string;
  head: string;
  kind: string;
  state: "failed" | "exhausted";
  command: string;
  detail: string | null;
  exitCode: number | null;
  timedOut: boolean;
  finishedAt: number;
};

export type RetroActivityFinding = {
  findingId: number;
  key: string;
  itemId: string;
  repository: string;
  path: string;
  severity: string;
  bugClass: string;
  why: string;
  text: string;
  status: string;
  filedIssue: string | null;
  seenAt: number;
};

export type RetroActivityFindingGroup = {
  id: string;
  repository: string;
  status: string;
  filedIssue: string | null;
  memberIds: number[];
  createdAt: number;
};

export type RetroActivityEscape = {
  id: number;
  itemId: string;
  trigger: string;
  pullNumber: number | null;
  recordedAt: number;
  isEscape: boolean | null;
  notEscapeReason: string | null;
  settledAt: number | null;
};

export type RetroActivityRebaseReturn = {
  jobId: number;
  activationId: number;
  itemId: string;
  reason: string;
  recordedAt: number | null;
};

export type RetroActivityCiRound = {
  itemId: string;
  head: string;
  next: string;
  fix: number | null;
  fixLimit: number;
  failedChecks: string[];
  recordedAt: number;
};

export type RetroActivityImprovement = {
  id: string;
  repository: string;
  reviewState: string;
  issueIdentifier: string | null;
  implementationState: string;
  implementationAt: number | null;
  verificationState: string;
  verificationAt: number | null;
  sources: ImprovementSource[];
  evidence: string[];
};

export type RetroActivitySnapshot = {
  workspaceId: string;
  schema: { latest: string | null; applied: number };
  items: RetroActivityItem[];
  unauthorizedItems: number;
  runs: RetroActivityRun[];
  transitions: RetroActivityTransition[];
  questions: RetroActivityQuestion[];
  messages: RetroActivityMessage[];
  checks: RetroActivityCheck[];
  findings: RetroActivityFinding[];
  findingGroups: RetroActivityFindingGroup[];
  escapes: RetroActivityEscape[];
  rebaseReturns: RetroActivityRebaseReturn[];
  ciRounds: RetroActivityCiRound[];
  improvements: RetroActivityImprovement[];
};

type RetroActivityInput = { workspaceId: string; repositories: readonly string[]; before: number };

export function* readRetroActivitySteps(
  q: Q,
  input: RetroActivityInput,
  schema: RetroActivitySnapshot["schema"],
): Steps<RetroActivitySnapshot> {
  const t = q.t;
  const before = input.before;
  const repositoryOf = sql<string>`lower(${t.workItemRepository.owner} || '/' || ${t.workItemRepository.repo})`;
  const rows = yield* q.all(
    q.orm
      .select({
        id: t.workItem.id,
        identifier: t.workItem.linearIdentifier,
        title: t.workItem.title,
        repository: repositoryOf,
        state: t.workItem.state,
        version: t.workItem.version,
        createdAt: t.workItem.createdAt,
        pullNumber: t.itemPullRequest.pullNumber,
        pullOpenedAt: t.itemPullRequest.openedAt,
        agentMs: t.workItem.agentMs,
        closeoutMs: t.workItem.closeoutMs,
        waitingMs: t.workItem.waitingMs,
        recheckMs: t.workItem.recheckMs,
        awakeMs: t.workItem.awakeMs,
        turnCount: t.workItem.turnCount,
        recoveryAttempts: t.workItem.recoveryAttempts,
        allowed: sql<unknown>`(${t.linearSession.teamId} IS NOT NULL AND ${sql.raw(
          teamRepositoryAllowedSql(
            "workspace.id",
            "linear_session.team_id",
            "lower(work_item_repository.owner || '/' || work_item_repository.repo)",
          ),
        )})`,
      })
      .from(t.workItem)
      .innerJoin(t.workItemRepository, eq(t.workItemRepository.itemId, t.workItem.id))
      .innerJoin(t.linearSession, eq(t.linearSession.sessionId, t.workItem.sessionKey))
      .innerJoin(t.workspace, eq(t.workspace.linearOrganizationId, t.linearSession.organizationId))
      .leftJoin(t.itemPullRequest, eq(t.itemPullRequest.itemId, t.workItem.id))
      .where(
        and(
          eq(t.workspace.id, input.workspaceId),
          inArray(
            repositoryOf,
            input.repositories.map((name) => name.toLowerCase()),
          ),
          lt(t.workItem.createdAt, before),
        ),
      )
      .orderBy(asc(t.workItem.createdAt), asc(t.workItem.id)),
  );
  const allowed = rows.filter((row) => truthy(row.allowed));
  const items = allowed.map((row): RetroActivityItem => ({
    id: row.id,
    identifier: row.identifier!,
    title: row.title,
    repository: row.repository,
    state: row.state,
    version: row.version,
    createdAt: row.createdAt,
    pullNumber: row.pullNumber,
    pullOpenedAt: row.pullOpenedAt,
    counters: {
      agentMs: row.agentMs,
      closeoutMs: row.closeoutMs,
      waitingMs: row.waitingMs,
      recheckMs: row.recheckMs,
      awakeMs: row.awakeMs,
      turnCount: row.turnCount,
      recoveryAttempts: row.recoveryAttempts,
    },
  }));
  const ids = items.map((item) => item.id);
  const scopedRepositories = new Set(items.map((item) => item.repository));
  const { reviewFindingItem: m, reviewFinding: f } = t;
  const findings = yield* q.all(
    q.orm
      .select({
        findingId: f.id,
        key: f.dedupeKey,
        itemId: m.itemId,
        repository: sql<string>`lower(${f.repository})`,
        path: f.path,
        severity: f.severity,
        bugClass: f.bugClass,
        why: f.why,
        text: f.text,
        status: f.status,
        filedIssue: f.filedIssue,
        seenAt: m.seenAt,
      })
      .from(m)
      .innerJoin(f, eq(f.id, m.findingId))
      .where(and(inArray(m.itemId, ids), lt(m.seenAt, before)))
      .orderBy(asc(m.seenAt), asc(f.id), asc(m.itemId)),
  );
  const findingIds = new Set(findings.map((row) => row.findingId));
  const r = t.run;
  const runs = yield* q.all(
    q.orm
      .select({
        id: r.id,
        itemId: r.itemId,
        kind: r.kind,
        agent: r.agent,
        status: r.status,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })
      .from(r)
      .where(and(inArray(r.itemId, ids), lt(r.createdAt, before)))
      .orderBy(asc(r.createdAt), asc(r.id)),
  );
  const e = t.workItemEvent;
  const transitions = yield* q.all(
    q.orm
      .select({
        id: e.id,
        itemId: e.itemId,
        version: e.version,
        at: e.at,
        fromState: e.fromState,
        toState: e.toState,
        event: e.event,
        kind: e.kind,
        reason: e.reason,
      })
      .from(e)
      .where(inArray(e.itemId, ids))
      .orderBy(asc(e.itemId), asc(e.version)),
  );
  const question = t.question;
  const questions = yield* q.all(
    q.orm
      .select({
        id: question.id,
        itemId: question.itemId,
        runId: question.runId,
        kind: question.kind,
        reason: question.reason,
        body: question.body,
        answer: question.answer,
        status: question.status,
        createdAt: question.createdAt,
        answeredAt: question.answeredAt,
        cancelledAt: question.cancelledAt,
        answerEventKey: question.answerEventKey,
      })
      .from(question)
      .where(and(inArray(question.itemId, ids), lt(question.createdAt, before)))
      .orderBy(asc(question.createdAt), asc(question.id)),
  );
  const turn = t.linearTurn;
  const messages = yield* q.all(
    q.orm
      .select({
        ordinal: turn.ordinal,
        eventKey: turn.eventKey,
        activityId: turn.activityId,
        itemId: turn.itemId,
        body: turn.body,
        createdAt: turn.createdAtMs,
      })
      .from(turn)
      .where(
        and(inArray(turn.itemId, ids), lt(turn.createdAtMs, before), ne(turn.state, "cancelled")),
      )
      .orderBy(asc(turn.createdAtMs), asc(turn.ordinal)),
  );
  const { closeoutStep: s, closeoutProgress: p } = t;
  const checks = yield* q.all(
    q.orm
      .select({
        progressId: s.progressId,
        stepId: s.stepId,
        itemId: p.itemId,
        head: p.head,
        kind: s.kind,
        state: s.state,
        command: s.command,
        detail: s.detail,
        exitCode: s.exitCode,
        timedOut: s.timedOut,
        finishedAt: s.finishedAt,
      })
      .from(s)
      .innerJoin(p, eq(p.id, s.progressId))
      .where(
        and(
          inArray(p.itemId, ids),
          inArray(s.state, ["failed", "exhausted"]),
          isNotNull(s.finishedAt),
          lt(s.finishedAt, before),
        ),
      )
      .orderBy(asc(s.finishedAt), asc(s.progressId), asc(s.stepId)),
  );
  const g = t.findingGroup;
  const groups = yield* q.all(
    q.orm
      .select({
        id: g.id,
        repository: sql<string>`lower(${g.repository})`,
        status: g.status,
        filedIssue: g.filedIssue,
        memberIds: jsonText(q, g.memberIds),
        createdAt: g.createdAt,
      })
      .from(g)
      .where(and(eq(g.workspaceId, input.workspaceId), lt(g.createdAt, before)))
      .orderBy(desc(g.createdAt), asc(g.id)),
  );
  const x = t.reviewEscape;
  const escapes = yield* q.all(
    q.orm
      .select({
        id: x.id,
        itemId: x.itemId,
        trigger: x.trigger,
        pullNumber: x.pullNumber,
        recordedAt: x.recordedAt,
        isEscape: x.isEscape,
        notEscapeReason: x.notEscapeReason,
        settledAt: x.settledAt,
      })
      .from(x)
      .where(and(inArray(x.itemId, ids), lt(x.recordedAt, before)))
      .orderBy(asc(x.recordedAt), asc(x.id)),
  );
  const b = t.rebaseReturn;
  const rebaseReturns = yield* q.all(
    q.orm
      .select({
        jobId: b.jobId,
        activationId: b.activationId,
        itemId: b.itemId,
        reason: b.reason,
        recordedAt: b.recordedAt,
      })
      .from(b)
      .where(and(inArray(b.itemId, ids), or(isNull(b.recordedAt), lt(b.recordedAt, before))))
      .orderBy(sql`${b.recordedAt} ASC NULLS FIRST`, asc(b.jobId), asc(b.activationId)),
  );
  const c = t.ciRound;
  const ciRounds = yield* q.all(
    q.orm
      .select({
        itemId: c.itemId,
        head: c.head,
        next: c.next,
        fix: c.fix,
        fixLimit: c.fixLimit,
        checks: jsonText(q, c.checks),
        recordedAt: c.recordedAt,
      })
      .from(c)
      .where(and(inArray(c.itemId, ids), lt(c.recordedAt, before)))
      .orderBy(asc(c.recordedAt), asc(c.itemId), asc(c.head)),
  );
  const improvements: RetroActivityImprovement[] = [];
  for (const improvement of yield* listImprovementsSteps(q, input.workspaceId)) {
    if (
      improvement.createdAt >= before ||
      !input.repositories.some(
        (name) => name.toLowerCase() === improvement.repository.toLowerCase(),
      )
    )
      continue;
    const proposals = (yield* listImprovementProposalsSteps(q, improvement.id)).filter(
      (proposal) => proposal.createdAt < before,
    );
    improvements.push({
      id: improvement.id,
      repository: improvement.repository.toLowerCase(),
      reviewState: improvement.reviewState,
      issueIdentifier: improvement.issue?.identifier ?? null,
      implementationState: improvement.implementationState,
      implementationAt: improvement.implementationAt,
      verificationState: improvement.verificationState,
      verificationAt: improvement.verificationAt,
      sources: proposals.map((proposal) => proposal.source),
      evidence: [...new Set(proposals.flatMap((proposal) => proposal.evidence))].sort(),
    });
  }
  return {
    workspaceId: input.workspaceId,
    schema,
    items,
    unauthorizedItems: rows.length - allowed.length,
    runs,
    transitions: transitions as RetroActivityTransition[],
    questions,
    messages: messages as RetroActivityMessage[],
    checks: checks.map((row) => ({
      ...row,
      state: row.state as RetroActivityCheck["state"],
      finishedAt: row.finishedAt!,
      timedOut: row.timedOut === 1,
    })),
    findings,
    findingGroups: groups
      .map((row) => ({ ...row, memberIds: JSON.parse(row.memberIds) as number[] }))
      .filter(
        (group) =>
          scopedRepositories.has(group.repository) &&
          group.memberIds.some((id) => findingIds.has(id)),
      ),
    escapes: escapes.map((row) => ({
      ...row,
      isEscape: row.isEscape === null ? null : row.isEscape === 1,
    })),
    rebaseReturns,
    ciRounds: ciRounds.map(({ checks: checkJson, ...row }) => ({
      ...row,
      failedChecks: (JSON.parse(checkJson) as { name: string; state: string }[])
        .filter((check) => check.state === "failed")
        .map((check) => check.name)
        .sort(),
    })),
    improvements,
  };
}

function truthy(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function* appliedMigrationsSteps(q: Q): Steps<RetroActivitySnapshot["schema"]> {
  const sqlite = q.dialect === "sqlite";
  const recorded = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(sqlite ? sql`sqlite_master` : sql`information_schema.tables`)
      .where(
        sqlite
          ? sql`type = 'table' AND name = '__drizzle_migrations'`
          : sql`table_schema = 'drizzle' AND table_name = '__drizzle_migrations'`,
      ),
  );
  const counted = recorded
    ? yield* q.one(
        q.orm
          .select({ n: sql<number>`count(*)` })
          .from(sqlite ? sql`__drizzle_migrations` : sql`drizzle.__drizzle_migrations`),
      )
    : undefined;
  const applied = Number(counted?.n ?? 0);
  const tags = migrationTags(sqlite ? MIGRATIONS_FOLDER : PG_MIGRATIONS_FOLDER);
  return { latest: applied === 0 ? null : (tags[applied - 1] ?? null), applied };
}

export async function readRetroActivity(
  store: Db,
  input: RetroActivityInput,
): Promise<RetroActivitySnapshot> {
  const schema = await store.run(appliedMigrationsSteps);
  return store.transaction((q) => readRetroActivitySteps(q, input, schema));
}
