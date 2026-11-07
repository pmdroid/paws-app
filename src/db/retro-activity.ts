import type { Database } from "bun:sqlite";
import { listImprovementProposals, listImprovements, type ImprovementSource } from "./improvements";
import { appliedMigrations } from "./migrate";
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

type ItemRow = {
  id: string;
  linear_identifier: string;
  title: string;
  repository: string;
  state: string;
  version: number;
  created_at: number;
  pull_number: number | null;
  opened_at: number | null;
  agent_ms: number;
  closeout_ms: number;
  waiting_ms: number;
  recheck_ms: number;
  awake_ms: number;
  turn_count: number;
  recovery_attempts: number;
  allowed: number;
};

const SCOPE = "SELECT value FROM json_each(?)";

export function readRetroActivity(
  db: Database,
  input: { workspaceId: string; repositories: readonly string[]; before: number },
): RetroActivitySnapshot {
  return db
    .transaction(() => {
      const repositories = JSON.stringify(input.repositories.map((name) => name.toLowerCase()));
      const rows = db
        .query<ItemRow, [string, string, number]>(
          `SELECT i.id, i.linear_identifier, i.title, lower(r.owner || '/' || r.repo) AS repository,
             i.state, i.version, i.created_at, p.pull_number, p.opened_at, i.agent_ms, i.closeout_ms,
             i.waiting_ms, i.recheck_ms, i.awake_ms, i.turn_count, i.recovery_attempts,
             (s.team_id IS NOT NULL AND ${teamRepositoryAllowedSql("w.id", "s.team_id", "lower(r.owner || '/' || r.repo)")}) AS allowed
           FROM work_item i
           JOIN work_item_repository r ON r.item_id = i.id
           JOIN linear_session s ON s.session_id = i.session_key
           JOIN workspace w ON w.linear_organization_id = s.organization_id
           LEFT JOIN item_pull_request p ON p.item_id = i.id
           WHERE w.id = ? AND lower(r.owner || '/' || r.repo) IN (${SCOPE}) AND i.created_at < ?
           ORDER BY i.created_at, i.id`,
        )
        .all(input.workspaceId, repositories, input.before);
      const allowed = rows.filter((row) => row.allowed === 1);
      const items = allowed.map((row): RetroActivityItem => ({
        id: row.id,
        identifier: row.linear_identifier,
        title: row.title,
        repository: row.repository,
        state: row.state,
        version: row.version,
        createdAt: row.created_at,
        pullNumber: row.pull_number,
        pullOpenedAt: row.opened_at,
        counters: {
          agentMs: row.agent_ms,
          closeoutMs: row.closeout_ms,
          waitingMs: row.waiting_ms,
          recheckMs: row.recheck_ms,
          awakeMs: row.awake_ms,
          turnCount: row.turn_count,
          recoveryAttempts: row.recovery_attempts,
        },
      }));
      const ids = JSON.stringify(items.map((item) => item.id));
      const before = input.before;
      const scopedRepositories = new Set(items.map((item) => item.repository));
      const findingRows = db
        .query<
          Omit<RetroActivityFinding, "itemId" | "seenAt"> & { itemId: string; seenAt: number },
          [string, number]
        >(
          `SELECT f.id AS findingId, f.dedupe_key AS key, m.item_id AS itemId,
             lower(f.repository) AS repository, f.path, f.severity, f.bug_class AS bugClass, f.why,
             f.text, f.status, f.filed_issue AS filedIssue, m.seen_at AS seenAt
           FROM review_finding_item m JOIN review_finding f ON f.id = m.finding_id
           WHERE m.item_id IN (${SCOPE}) AND m.seen_at < ? ORDER BY m.seen_at, f.id, m.item_id`,
        )
        .all(ids, before);
      const findingIds = new Set(findingRows.map((row) => row.findingId));
      return {
        workspaceId: input.workspaceId,
        schema: appliedMigrations(db),
        items,
        unauthorizedItems: rows.length - allowed.length,
        runs: db
          .query<RetroActivityRun, [string, number]>(
            `SELECT id, item_id AS itemId, kind, agent, status, created_at AS createdAt,
               updated_at AS updatedAt FROM run WHERE item_id IN (${SCOPE}) AND created_at < ?
             ORDER BY created_at, id`,
          )
          .all(ids, before),
        transitions: db
          .query<RetroActivityTransition, [string]>(
            `SELECT id, item_id AS itemId, version, at, from_state AS fromState, to_state AS toState,
               event, kind, reason FROM work_item_event WHERE item_id IN (${SCOPE})
             ORDER BY item_id, version`,
          )
          .all(ids),
        questions: db
          .query<RetroActivityQuestion, [string, number]>(
            `SELECT id, item_id AS itemId, run_id AS runId, kind, reason, body, answer, status,
               created_at AS createdAt, answered_at AS answeredAt, cancelled_at AS cancelledAt,
               answer_event_key AS answerEventKey
             FROM question WHERE item_id IN (${SCOPE}) AND created_at < ? ORDER BY created_at, id`,
          )
          .all(ids, before),
        messages: db
          .query<RetroActivityMessage, [string, number]>(
            `SELECT ordinal, event_key AS eventKey, activity_id AS activityId, item_id AS itemId,
               body, created_at_ms AS createdAt
             FROM linear_turn WHERE item_id IN (${SCOPE}) AND created_at_ms < ? AND state <> 'cancelled'
             ORDER BY created_at_ms, ordinal`,
          )
          .all(ids, before),
        checks: db
          .query<Omit<RetroActivityCheck, "timedOut"> & { timedOut: number }, [string, number]>(
            `SELECT s.progress_id AS progressId, s.step_id AS stepId, p.item_id AS itemId, p.head,
               s.kind, s.state, s.command, s.detail, s.exit_code AS exitCode, s.timed_out AS timedOut,
               s.finished_at AS finishedAt
             FROM closeout_step s JOIN closeout_progress p ON p.id = s.progress_id
             WHERE p.item_id IN (${SCOPE}) AND s.state IN ('failed','exhausted')
               AND s.finished_at IS NOT NULL AND s.finished_at < ?
             ORDER BY s.finished_at, s.progress_id, s.step_id`,
          )
          .all(ids, before)
          .map((row) => ({ ...row, timedOut: row.timedOut === 1 })),
        findings: findingRows,
        findingGroups: db
          .query<
            Omit<RetroActivityFindingGroup, "memberIds"> & { memberIds: string },
            [string, number]
          >(
            `SELECT id, lower(repository) AS repository, status, filed_issue AS filedIssue,
               member_ids AS memberIds, created_at AS createdAt
             FROM finding_group WHERE workspace_id = ? AND created_at < ?
             ORDER BY created_at DESC, id`,
          )
          .all(input.workspaceId, before)
          .map((row) => ({ ...row, memberIds: JSON.parse(row.memberIds) as number[] }))
          .filter(
            (group) =>
              scopedRepositories.has(group.repository) &&
              group.memberIds.some((id) => findingIds.has(id)),
          ),
        escapes: db
          .query<
            Omit<RetroActivityEscape, "isEscape"> & { isEscape: number | null },
            [string, number]
          >(
            `SELECT id, item_id AS itemId, trigger, pull_number AS pullNumber,
               recorded_at AS recordedAt, is_escape AS isEscape,
               not_escape_reason AS notEscapeReason, settled_at AS settledAt
             FROM review_escape WHERE item_id IN (${SCOPE}) AND recorded_at < ? ORDER BY recorded_at, id`,
          )
          .all(ids, before)
          .map((row) => ({ ...row, isEscape: row.isEscape === null ? null : row.isEscape === 1 })),
        rebaseReturns: db
          .query<RetroActivityRebaseReturn, [string, number]>(
            `SELECT job_id AS jobId, activation_id AS activationId, item_id AS itemId, reason,
               recorded_at AS recordedAt
             FROM rebase_return WHERE item_id IN (${SCOPE}) AND (recorded_at IS NULL OR recorded_at < ?)
             ORDER BY recorded_at, job_id, activation_id`,
          )
          .all(ids, before),
        ciRounds: db
          .query<Omit<RetroActivityCiRound, "failedChecks"> & { checks: string }, [string, number]>(
            `SELECT item_id AS itemId, head, next, fix, fix_limit AS fixLimit, checks,
               recorded_at AS recordedAt
             FROM ci_round WHERE item_id IN (${SCOPE}) AND recorded_at < ? ORDER BY recorded_at, item_id, head`,
          )
          .all(ids, before)
          .map(({ checks, ...row }) => ({
            ...row,
            failedChecks: (JSON.parse(checks) as { name: string; state: string }[])
              .filter((check) => check.state === "failed")
              .map((check) => check.name)
              .sort(),
          })),
        improvements: listImprovements(db, input.workspaceId)
          .filter(
            (improvement) =>
              improvement.createdAt < before &&
              input.repositories.some(
                (name) => name.toLowerCase() === improvement.repository.toLowerCase(),
              ),
          )
          .map((improvement) => {
            const proposals = listImprovementProposals(db, improvement.id).filter(
              (proposal) => proposal.createdAt < before,
            );
            return {
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
            };
          }),
      };
    })
    .deferred();
}
