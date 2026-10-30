/**
 * Live status snapshot.
 *
 * Reads through `src/db`'s public index only. There is no SQL here.
 *
 * `src/db/index.ts` does not export every row the dashboard shows. Where a
 * reader is missing, this file uses the closest exported row and leaves the
 * gap empty rather than querying a table directly:
 *
 * - `listRuns` supplies every stored run for the visible items. The run row
 *   has no reviewer, summary, or activity log; those still come from outbox
 *   activity. `currentRunId` is the item's linked run.
 * - `listOpenQuestions` supplies open question rows. An outbox elicitation
 *   is still used when the question table has no row for that item.
 *   Recommended option and claim are not stored.
 * - No Closeout table. Verdicts are parsed from outbox activity
 *   (`${itemId}:verdict:${head}:${outcome}` and `${itemId}:exhausted`) and
 *   from `github.merge` job payloads. Checks are parsed from the evidence
 *   summary text. `closeout-verdict.json` on disk is not read.
 * - No pull-request table. Number and URL come from outbox activity
 *   `${itemId}:pr:${number}`.
 * - No enqueue timestamp on the work item. Merge `enqueuedAt` is the merge
 *   job's `createdAt`, or the snapshot time when no job exists. Step state
 *   follows that job's status.
 */

import { journalCaught } from "../journal";
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentCloseoutEvent,
  Job,
  StoredRun,
  ItemHold,
  OpenQuestionRecord,
  OutboxRow,
  MergeQueuePosition,
  QueuePosition,
  WorkItemEventRow,
  WorkItemFact,
  WorkItemRecord,
} from "../../../db";
import {
  getCandidateRisk,
  getRiskFix,
  latestCandidateRisk,
  latestRiskFix,
  getCloseoutRecovery,
  getConversation,
  getLinkAsk,
  listCloseoutBypassChecks,
  listDeadDeliveries,
  describeLinearWebhookWarning,
  getConfirmedRemoteMerge,
  LINEAR_WEBHOOK_FIX,
  linearWebhookWarning,
  linearConversationUrl,
  listVisualReviewMarks,
  listVisualReviews,
  getTaskMergeSettings,
  getTaskMode,
  getWorkItemRepository,
  getRun,
  listAgentCloseout,
  listCloseoutProgress,
  listCiRounds,
  listCloseoutRounds,
  listEvidence,
  linearRequestsByItem,
  listIntakeQueue,
  listItemHolds,
  listJobs,
  listLinearTurnsForItem,
  listOpenQuestions,
  listOutbox,
  listMergeQueues,
  runnerCapacityWait,
  listQueuePositions,
  listRuns,
  runAgentSetup,
  runRunnerName,
  usagePause,
  listPolicyRunnerWarnings,
  listPushOutages,
  listTaskBlockers,
  listWorkItemFacts,
  listWorkItemsByStates,
  listWorkItemEventRows,
  listLastWorkItemEventTimes,
  type CloseoutProgressRecord,
  type CloseoutRound,
  type CloseoutStepRecord,
} from "../../../db";
import { isTerminalWorkItemState, riskCarryOverReason } from "../../../core";
import { redactCloseoutText } from "../server/artifact";
import { agentCloseoutOf } from "./agent-closeout";
import { itemReviews } from "./reviews";
import { isRuleStep, skippedRules, withRuleDetail } from "./rules";
import { mergedTimes, stateTotals, toStateTimes, type StateTotals } from "./state-times";
import {
  STATUS_API_VERSION,
  agentCloseoutSummary,
  isBlockerSatisfied,
  verdictSummary,
  type StatusDeadDelivery,
  type ActivityKind,
  type CheckKind,
  type CheckState,
  type ItemState,
  type RunState,
  type StatusActivity,
  type StatusAgentCloseout,
  type StatusCiRound,
  type StatusCheck,
  type StatusCloseoutAttempt,
  type StatusEvidence,
  type StatusGitHubQueue,
  type StatusHeld,
  type StatusItem,
  type StatusItemDetail,
  type StatusItemRisk,
  type StatusItemEvent,
  type StatusMergedTimes,
  type StatusStateTimes,
  type StatusMergeQueue,
  type StatusMergeEntry,
  type StatusMergeOutcome,
  type StatusMergeSettings,
  type StatusProject,
  type StatusPullRequest,
  type StatusQuestion,
  type StatusRun,
  type StatusSnapshot,
  type StatusSnapshotBase,
  type StatusVerdict,
  type StatusVisualReview,
  type StatusRiskCarryOver,
  type VerdictDecision,
} from "../contract";

/** Keep aligned with `WORK_ITEM_STATES` / the `work_item.state` check. */
const WORK_ITEM_STATES = [
  "planning",
  "queued",
  "running",
  "paused",
  "awaiting_input",
  "recovering",
  "verifying",
  "failed",
  "merge_queue",
  "manual",
  "merged",
  "completed",
  "cancelled",
] as const;

const MERGE_QUEUE = "github.merge";
const RESUME_QUEUE = "run.resume";
const REVERIFY_QUEUE = "run.reverify";
/** Merge-queue work goes to the next free runner slot ahead of any other task. */
const SLOT_WAIT_DETAIL = "Waiting for a runner slot (next in line).";
const DAY_MS = 24 * 60 * 60 * 1000;
/** A task that went back to the agent after CI or a conflict is still on its way back. */
const BACK_WITH_AGENT_STATES = new Set<string>([
  "queued",
  "running",
  "paused",
  "awaiting_input",
  "recovering",
  "verifying",
]);
const MAX_CLOSEOUT_ATTEMPTS = 3;

/** Closeout evidence ids are relative paths. A `..` segment or an absolute path stays off the status API. */
function safeEvidenceId(id: string): boolean {
  if (
    id.length === 0 ||
    id.length > 512 ||
    id.startsWith("/") ||
    id.includes("\\") ||
    id.includes("\0")
  )
    return false;
  return id.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

const MERGE_STEPS = ["Rebase onto main", "Re-run Closeout", "Squash merge"] as const;

export type LiveStatusOptions = {
  sessionIds?: readonly string[];
  now?: () => Date;
  pawsHome?: string;
  project?: {
    name?: string;
    team?: string;
    repo?: string;
    workspace?: string | null;
  };
  env?: NodeJS.ProcessEnv;
  automaticRisk?: (itemId: string, head: string) => Promise<string[] | null>;
  linearUsage?: () => LinearUsageView;
};

export type LinearUsageView = {
  budget: {
    requestsRemaining: number | null;
    requestsLimit: number | null;
    requestsResetMs: number | null;
  } | null;
  holdUntilMs: number | null;
};

export function createLiveStatusProvider(
  db: Database,
  options?: LiveStatusOptions & { automaticRisk?: undefined },
): {
  snapshot(): StatusSnapshot;
  item(id: string): StatusItemDetail | null;
  checkLog(request: CheckLogRequest): CheckOutput | null;
};
export function createLiveStatusProvider(
  db: Database,
  options: LiveStatusOptions,
): {
  snapshot(): StatusSnapshot;
  item(id: string): StatusItemDetail | null | Promise<StatusItemDetail | null>;
  checkLog(request: CheckLogRequest): CheckOutput | null;
};
export function createLiveStatusProvider(
  db: Database,
  options: LiveStatusOptions = {},
): {
  snapshot(): StatusSnapshot;
  item(id: string): StatusItemDetail | null | Promise<StatusItemDetail | null>;
  checkLog(request: CheckLogRequest): CheckOutput | null;
} {
  return {
    snapshot() {
      return {
        ...readLiveSnapshot(db, options),
        ...readIntake(db, options),
        ...readPushOutages(db),
        ...readPolicyRunnerWarnings(db),
      };
    },
    item(id) {
      const detail = readItemDetail(db, id, options);
      if (!detail?.risk?.head || !options.automaticRisk) return detail;
      const itemId = readScopedSnapshot(db, options, id).current?.record.id;
      if (!itemId) return detail;
      return options.automaticRisk(itemId, detail.risk.head).then((evidenceIds) => {
        const ids = evidenceIds?.every(safeEvidenceId) ? evidenceIds : null;
        return {
          ...detail,
          risk: {
            ...detail.risk!,
            automaticPass: ids && ids.length > 0 ? { evidenceIds: ids } : null,
          },
        };
      });
    },
    checkLog(request) {
      return readCheckLog(db, request, options);
    },
  };
}

/** One check of one Closeout attempt of a visible issue. `run` picks that run's agent Closeout. */
export interface CheckLogRequest {
  itemId: string;
  attempt: number;
  checkId: string;
  run: string | null;
}

export interface CheckOutput {
  stdout: string;
  stderr: string;
}

/** Finished items stay in `/api/status` this long after their last state change. */
export const STATUS_RECENT_MS = 24 * 60 * 60 * 1000;
/** At most this many finished items are in `/api/status`, the most recently finished first. */
export const STATUS_RECENT_LIMIT = 50;

/** Every field of the visible items, before the list trims it or the detail picks one item. */
type FullSnapshot = StatusSnapshotBase & {
  verdicts: StatusVerdict[];
  agentCloseout?: StatusAgentCloseout[];
};

/**
 * The status list: one Closeout summary per item and each run's latest agent Closeout state.
 * Attempts, check output and findings are only in the item detail.
 */
function toList(snapshot: FullSnapshot): StatusSnapshot {
  const { verdicts, agentCloseout, ...rest } = snapshot;
  return {
    ...rest,
    verdicts: verdicts.map(verdictSummary),
    ...(agentCloseout ? { agentCloseout: agentCloseout.map(agentCloseoutSummary) } : {}),
  };
}

/**
 * The items `/api/status` lists, in `visible` order: every open item, and the
 * `STATUS_RECENT_LIMIT` most recently finished ones that finished within `STATUS_RECENT_MS`.
 * An item finished when it last changed state; one from before `work_item_event` counts from
 * its creation.
 */
function listedRecords(
  db: Database,
  visible: readonly WorkItemRecord[],
  facts: ReadonlyMap<string, WorkItemFact>,
  nowMs: number,
): WorkItemRecord[] {
  const changed = listLastWorkItemEventTimes(db);
  const recent = new Set(
    visible
      .filter((record) => isTerminalWorkItemState(record.state))
      .map((record) => ({
        record,
        at: changed.get(record.id) ?? facts.get(record.id)?.createdAt ?? 0,
      }))
      .filter(({ at }) => nowMs - at <= STATUS_RECENT_MS)
      .sort((left, right) => right.at - left.at)
      .slice(0, STATUS_RECENT_LIMIT)
      .map(({ record }) => record),
  );
  return visible.filter((record) => !isTerminalWorkItemState(record.state) || recent.has(record));
}

/**
 * One issue's sessions with their runs, Closeout attempts, agent Closeout, evidence and CI
 * rounds, for `GET /api/status/items/:id`, also for an issue that left the list. Null when no
 * visible item has that id. Check `stdout` and `stderr` are left out; the issue page loads
 * logs separately.
 */
function readItemDetail(
  db: Database,
  id: string,
  options: LiveStatusOptions,
): StatusItemDetail | null {
  const { snapshot, blocks, records, current } = readScopedSnapshot(db, options, id);
  if (snapshot.items.length === 0 || current === null) return null;
  const risk = itemRisk(db, current);
  const detail = withoutOutputs(snapshot);
  const env = options.env ?? process.env;
  const pawsHome = options.pawsHome ?? env.PAWS_HOME;
  if (!pawsHome || detail.verdicts.length === 0) return { ...detail, id, blocks, risk };
  const progress = listCloseoutProgress(db);
  return {
    ...detail,
    verdicts: detail.verdicts.map((verdict) => {
      const record = records.find((entry) => publicId(entry) === verdict.itemId);
      if (!record) return verdict;
      const reviews = itemReviews(db, record.id, pawsHome, env, progress);
      return reviews.length === 0 ? verdict : { ...verdict, reviews };
    }),
    id,
    blocks,
    risk,
  };
}

/** Closeout's check id for the security review of high-risk paths. */
const SECURITY_REVIEW_CHECK = "security-review";

/**
 * The Risk card of the newest session: the tier of its latest classified head with the paths
 * and lists that matched, and the `security-review` step of its latest Closeout run. The step
 * comes from Closeout's progress because the verdict leaves out skipped checks.
 */
function itemRisk(db: Database, current: CurrentItem): StatusItemRisk | null {
  const stored = latestCandidateRisk(db, current.record.id);
  const step = current.progress?.steps.find((entry) => entry.id === SECURITY_REVIEW_CHECK);
  const check = current.verdict?.checks.find((entry) => entry.id === SECURITY_REVIEW_CHECK);
  const securityReview: StatusItemRisk["securityReview"] = step
    ? {
        state: checkState(step.state),
        detail: step.detail?.trim() || null,
        head: blank(current.progress!.head),
      }
    : check
      ? { state: check.state, detail: check.detail?.trim() || null, head: current.verdict!.headSha }
      : null;
  if (stored === null && securityReview === null) return null;
  const lists = new Map((stored?.matches ?? []).map((match) => [match.path, match.lists]));
  return {
    automaticPass: null,
    tier: stored?.tier ?? null,
    head: stored?.head ?? null,
    base: stored?.base ?? null,
    classifiedAt: stored === null ? null : new Date(stored.classifiedAt).toISOString(),
    paths: (stored?.paths ?? []).map((path) => ({ path, lists: lists.get(path) ?? [] })),
    securityReview,
  };
}

/**
 * The whole output of one check, for `GET /api/status/items/:id/attempts/:n/checks/:check/log`.
 * Null when the issue is not visible or that attempt of its Closeout has no such check.
 */
function readCheckLog(
  db: Database,
  request: CheckLogRequest,
  options: LiveStatusOptions,
): CheckOutput | null {
  const { snapshot } = readScopedSnapshot(db, options, request.itemId);
  if (snapshot.items.length === 0) return null;
  // A verdict without recorded attempts is one attempt, as the issue page shows it.
  let attempts: Array<Pick<StatusCloseoutAttempt, "number" | "checks">>;
  if (request.run === null) {
    const verdict = snapshot.verdicts.find((entry) => entry.itemId === request.itemId);
    if (!verdict) return null;
    attempts = verdict.attempts?.length
      ? verdict.attempts
      : [{ number: Math.max(verdict.attempt, 1), checks: verdict.checks }];
  } else {
    attempts = snapshot.agentCloseout?.find((entry) => entry.runId === request.run)?.attempts ?? [];
  }
  const check = attempts
    .find((entry) => entry.number === request.attempt)
    ?.checks.find((entry) => entry.id === request.checkId);
  if (!check) return null;
  return { stdout: check.stdout ?? "", stderr: check.stderr ?? "" };
}

/** The snapshot without check `stdout` and `stderr`, which the issue page loads per check. */
function withoutOutputs<T extends FullSnapshot>(snapshot: T): T {
  return {
    ...snapshot,
    verdicts: snapshot.verdicts.map((verdict) => ({
      ...verdict,
      checks: verdict.checks.map(withoutOutput),
      ...(verdict.attempts ? { attempts: verdict.attempts.map(attemptWithoutOutput) } : {}),
    })),
    ...(snapshot.agentCloseout
      ? {
          agentCloseout: snapshot.agentCloseout.map((entry) => ({
            ...entry,
            attempts: entry.attempts.map(attemptWithoutOutput),
          })),
        }
      : {}),
  };
}

function attemptWithoutOutput(attempt: StatusCloseoutAttempt): StatusCloseoutAttempt {
  return { ...attempt, checks: attempt.checks.map(withoutOutput) };
}

function withoutOutput(check: StatusCheck): StatusCheck {
  const { stdout: _stdout, stderr: _stderr, ...rest } = check;
  return rest;
}

export function emptyLiveSnapshot(
  now = new Date(),
  project?: LiveStatusOptions["project"],
): StatusSnapshot {
  return { ...emptyBase(now, project), verdicts: [] };
}

function emptyBase(now: Date, project: LiveStatusOptions["project"]): StatusSnapshotBase {
  return {
    version: STATUS_API_VERSION,
    source: "live",
    generatedAt: now.toISOString(),
    project: projectOf([], project),
    items: [],
    runs: [],
    questions: [],
    mergeQueue: [],
  };
}

/** Repositories GitHub refuses pushes from the Paws App for (PAS-867). */
function readPushOutages(db: Database): Pick<StatusSnapshot, "pushOutages"> {
  const outages = listPushOutages(db);
  if (!outages.length) return {};
  return {
    pushOutages: outages.map((outage) => ({
      repository: outage.repository,
      since: iso(outage.startedAt),
      lastError: outage.lastError,
      nextProbeAt: iso(outage.nextProbeAt),
      installationUrl: outage.installationUrl,
    })),
  };
}

/** Repositories whose Closeout policy uses keys the lowest online runner does not know (PAS-888). */
function readPolicyRunnerWarnings(db: Database): Pick<StatusSnapshot, "policyRunnerWarnings"> {
  const warnings = listPolicyRunnerWarnings(db);
  if (!warnings.length) return {};
  return {
    policyRunnerWarnings: warnings.map((warning) => ({
      repository: warning.repository,
      policyDigest: warning.policyDigest,
      runnerVersion: warning.runnerVersion,
      keys: warning.keys,
      checkedAt: iso(warning.checkedAt),
    })),
  };
}

function readIntake(
  db: Database,
  options: LiveStatusOptions,
): Pick<StatusSnapshot, "intake" | "linearBudget" | "linearWebhook"> {
  const at = (ms: number | null) => (ms === null ? null : iso(ms));
  const warning = linearWebhookWarning(db, (options.now?.() ?? new Date()).getTime());
  const webhook =
    warning === null
      ? {}
      : {
          linearWebhook: {
            warning: describeLinearWebhookWarning(warning),
            fix: LINEAR_WEBHOOK_FIX,
            lastVerifiedAt: iso(warning.lastVerifiedMs),
          },
        };
  const intake = listIntakeQueue(db)
    .filter(
      (entry) =>
        options.sessionIds === undefined ||
        (entry.sessionId !== null && options.sessionIds.includes(entry.sessionId)),
    )
    .map((entry) => ({
      issue: entry.issue,
      title: entry.title,
      receivedAt: iso(entry.receivedAt),
      attempts: entry.attempts,
      nextAttemptAt: at(entry.nextAttemptAt),
      lastError: entry.lastError,
    }));
  const usage = options.linearUsage?.();
  if (usage === undefined) return { intake, ...webhook };
  return {
    intake,
    ...webhook,
    linearBudget: {
      requestsRemaining: usage.budget?.requestsRemaining ?? null,
      requestsLimit: usage.budget?.requestsLimit ?? null,
      resetAt: at(usage.budget?.requestsResetMs ?? null),
      holdUntil: at(usage.holdUntilMs),
    },
  };
}

type ScopedSnapshot = {
  snapshot: FullSnapshot;
  blocks: string[];
  records: WorkItemRecord[];
  /** The newest of the scoped items, with its Closeout verdict and its latest Closeout run. */
  current: CurrentItem | null;
};

type CurrentItem = {
  record: WorkItemRecord;
  verdict: StatusVerdict | undefined;
  progress: CloseoutProgressRecord | null;
};

function readLiveSnapshot(db: Database, options: LiveStatusOptions): StatusSnapshot {
  return toList(readScopedSnapshot(db, options).snapshot);
}

/**
 * The listed items (see `listedRecords`), or with `only` the visible items with that public id.
 * Blockers, shared sessions and merge places still read every visible item; `blocks` lists
 * the issues `only` blocks.
 */
function readScopedSnapshot(
  db: Database,
  options: LiveStatusOptions,
  only?: string,
): ScopedSnapshot {
  const now = options.now?.() ?? new Date();
  const generatedAt = now.toISOString();
  const facts = new Map(listWorkItemFacts(db).map((fact) => [fact.itemId, fact]));
  const visible = listWorkItemsByStates(db, WORK_ITEM_STATES)
    .filter(
      (record) =>
        options.sessionIds === undefined ||
        (record.sessionKey !== null && options.sessionIds.includes(record.sessionKey)),
    )
    .sort((left, right) => compareNewest(left, right, facts));
  const records =
    only === undefined
      ? listedRecords(db, visible, facts, now.getTime())
      : visible.filter((record) => publicId(record) === only);
  if (records.length === 0)
    return {
      snapshot: { ...emptyBase(now, options.project), verdicts: [] },
      blocks: [],
      records: [],
      current: null,
    };
  const rows = listOutbox(db).filter(
    (row) =>
      options.sessionIds === undefined ||
      (row.orderingKey !== null && options.sessionIds.includes(row.orderingKey)),
  );
  const jobs = listJobs(db);
  const itemsByIssue = latestByLinearIssue(visible, facts);
  const openQuestions = listOpenQuestions(db);
  const env = options.env ?? process.env;
  const runs = runsFor(records, rows, generatedAt, db, options.pawsHome ?? env.PAWS_HOME);
  const queue = new Map(listQueuePositions(db).map((entry) => [entry.itemId, entry]));
  const recordsById = new Map(visible.map((record) => [record.id, record]));
  const queues = listMergeQueues(db);
  const merging = new Map<string, StatusMergeQueue>(
    queues.map((entry) => {
      const ahead = entry.nextItemId ? recordsById.get(entry.nextItemId) : undefined;
      return [
        entry.itemId,
        {
          repository: entry.repository,
          position: entry.position,
          total: entry.total,
          ahead: ahead ? publicId(ahead) : null,
          ...(entry.busy ? { rechecking: true } : {}),
        },
      ];
    }),
  );
  const linearRequests = linearRequestsByItem(db);
  const holds = new Map(listItemHolds(db).map((hold) => [hold.itemId, hold]));
  const storedRuns = new Map<string, StoredRun[]>();
  for (const run of listRuns(db))
    storedRuns.set(run.itemId, [...(storedRuns.get(run.itemId) ?? []), run]);
  const items = records.map((record) => ({
    ...toItem(
      db,
      record,
      rows,
      runs,
      options.project?.repo,
      itemsByIssue,
      facts,
      queue,
      merging,
      jobs,
    ),
    linearRequests: linearRequests.get(record.id) ?? 0,
    ...heldOf(record, holds),
    ...sessionAttempt(db, record, visible, itemsByIssue, storedRuns, facts),
    ...historyOf(db, record, facts, now.getTime()),
  }));
  const progress = listCloseoutProgress(db);
  const rounds = listCloseoutRounds(db);
  const merge = mergeQueueFor(db, {
    records: visible,
    items,
    jobs,
    queues,
    generatedAt,
    now: now.getTime(),
    repo: options.project?.repo,
  });
  const listed = new Set(items.map((item) => item.id));
  const recordVerdicts = new Map(
    records.map((record) => {
      const runId = storedRuns.get(record.id)?.[0]?.id;
      return [
        record.id,
        verdictFor(record, rows, jobs, progress, rounds, now.getTime(), env).map((found) => {
          const verdict = runId === undefined ? found : { ...found, runId };
          // Only the item detail reads each rule's evidence record and bypass decisions.
          return only === undefined
            ? verdict
            : withRuleDetail(db, record.id, verdict, progress, evidenceRoot(options, env));
        }),
      ];
    }),
  );
  const snapshot: FullSnapshot = {
    version: STATUS_API_VERSION,
    source: "live",
    generatedAt,
    project: projectOf(visible, options.project),
    items,
    runs,
    questions: [],
    verdicts: records.flatMap((record) => recordVerdicts.get(record.id) ?? []),
    mergeQueue: merge.mergeQueue.filter((entry) => listed.has(entry.itemId)),
    ...(merge.mergeHistory === undefined
      ? {}
      : { mergeHistory: merge.mergeHistory.filter((entry) => listed.has(entry.itemId)) }),
    evidence: evidenceFor(db, records),
    agentCloseout: agentCloseoutFor(db, records, now.getTime(), env),
    ciRounds: ciRoundsFor(db, records, env),
    dead: deadFor(db, records),
    ...(only === undefined ? mergedTimesFor(db, visible, facts, now.getTime()) : {}),
  };
  snapshot.questions = questionsFor(db, records, rows, runs, openQuestions).map((question) =>
    withRiskDetail(db, withBypassChecks(db, question, snapshot.verdicts, env), snapshot.verdicts),
  );
  const blocks =
    only === undefined
      ? []
      : [
          ...new Set(
            visible
              .filter(
                (record) =>
                  publicId(record) !== only && blockersFor(db, record, itemsByIssue).includes(only),
              )
              .map(publicId),
          ),
        ];
  const current = records[0]!;
  return {
    snapshot,
    blocks,
    records,
    current: {
      record: current,
      verdict: recordVerdicts.get(current.id)?.[0],
      progress: progressFor(current, progress),
    },
  };
}

/** Dead outbox rows and dead jobs of the visible items, so none blocks a session unseen. */
function deadFor(db: Database, records: readonly WorkItemRecord[]): StatusDeadDelivery[] {
  return records
    .flatMap((record) =>
      listDeadDeliveries(db, record.id).map((dead) => ({
        itemId: publicId(record),
        kind: dead.kind,
        target: `${dead.kind}:${dead.id}`,
        name: dead.name,
        attempts: dead.attempts,
        lastError: dead.error,
        at: iso(dead.at),
        retryable: dead.retryable,
      })),
    )
    .sort((left, right) => left.at.localeCompare(right.at));
}

/**
 * The item's Linear session and, for an attempt a newer session on the same issue replaced,
 * when it ended. The issue page shows that attempt as an earlier section.
 */
function sessionAttempt(
  db: Database,
  record: WorkItemRecord,
  records: readonly WorkItemRecord[],
  itemsByIssue: ReadonlyMap<string, WorkItemRecord>,
  storedRuns: ReadonlyMap<string, readonly StoredRun[]>,
  facts: ReadonlyMap<string, WorkItemFact>,
): Pick<StatusItem, "session" | "endedAt"> {
  const sessionId = record.sessionKey;
  const session =
    sessionId === null
      ? {}
      : {
          session: {
            id: sessionId,
            url: linearConversationUrl(db, sessionId, publicId(record)),
            shared: [
              ...new Set(
                records
                  .filter(
                    (other) =>
                      other.sessionKey === sessionId &&
                      other.linearIssueId !== record.linearIssueId,
                  )
                  .map(publicId),
              ),
            ],
          },
        };
  if (itemsByIssue.get(record.linearIssueId) === record) return session;
  const last = storedRuns.get(record.id)?.at(-1);
  const endedAt = last?.updatedAt ?? facts.get(record.id)?.createdAt;
  return endedAt === undefined ? session : { ...session, endedAt: iso(endedAt) };
}

function agentCloseoutFor(
  db: Database,
  records: readonly WorkItemRecord[],
  nowMs: number,
  env: NodeJS.ProcessEnv,
): StatusAgentCloseout[] {
  const stored = new Map<string, StoredRun[]>();
  for (const run of listRuns(db)) stored.set(run.itemId, [...(stored.get(run.itemId) ?? []), run]);
  const shown = records.flatMap((record) => {
    const runs = stored.get(record.id) ?? [];
    const current = runs.find((run) => run.id === record.currentRunId);
    if (current === undefined) return [];
    return [...new Set([runs[0]!, current])].map((run) => ({ record, run, current }));
  });
  const byRun = new Map<string, AgentCloseoutEvent[]>();
  for (const event of listAgentCloseout(
    db,
    shown.map(({ run }) => run.id),
  )) {
    const events = byRun.get(event.runId) ?? [];
    events.push(event);
    byRun.set(event.runId, events);
  }
  return shown.flatMap(({ record, run, current }) => {
    const endedAt = run.status === "ended" || run.status === "lost" ? run.updatedAt : null;
    const folded = agentCloseoutOf(
      publicId(record),
      run.id,
      byRun.get(run.id) ?? [],
      nowMs,
      env,
      endedAt,
    );
    if (folded === null) return [];
    if (endedAt === null) return [folded];
    return [
      {
        ...folded,
        endedAt: iso(endedAt),
        ...(current === run ? {} : { continuesIn: current.id }),
      },
    ];
  });
}

/** CI rounds of the visible items, numbered per item. Log tails are redacted like Closeout output. */
function ciRoundsFor(
  db: Database,
  records: readonly WorkItemRecord[],
  env: NodeJS.ProcessEnv,
): StatusCiRound[] {
  return records.flatMap((record) =>
    listCiRounds(db, record.id).map((round, index) => ({
      itemId: publicId(record),
      runId: round.runId,
      round: index + 1,
      head: round.head,
      next: round.next,
      fix: round.fix,
      fixLimit: round.fixLimit,
      recordedAt: new Date(round.recordedAt).toISOString(),
      checks: round.checks.map((check) => ({
        ...check,
        logTail: check.logTail === null ? null : redactCloseoutText(check.logTail, env),
      })),
    })),
  );
}

/** Evidence of the visible items only, so a reader without the item's session sees none of it. */
function evidenceFor(db: Database, records: readonly WorkItemRecord[]): StatusEvidence[] {
  return records
    .flatMap((record) =>
      listEvidence(db, record.id).map((stored) => ({
        id: stored.id,
        itemId: publicId(record),
        runId: stored.runId,
        checkId: stored.checkId,
        attempt: stored.attempt,
        kind: stored.mediaType.startsWith("video/") ? ("video" as const) : ("image" as const),
        mediaType: stored.mediaType,
        displayName: stored.displayName,
        sizeBytes: stored.sizeBytes,
        headCommit: stored.headCommit,
        publishedAt: new Date(stored.createdAt).toISOString(),
        publisher: agentName(getRun(db, stored.runId)?.agent ?? "paws"),
      })),
    )
    .sort(
      (left, right) =>
        left.publishedAt.localeCompare(right.publishedAt) || left.id.localeCompare(right.id),
    );
}

/** Finished items offer no Pause, Stop or take over; only a stuck agent can still be cleared. */
const NO_CONTROL_STATES: readonly WorkItemRecord["state"][] = [
  "completed",
  "merged",
  "cancelled",
  "failed",
];

function toItem(
  db: Database,
  record: WorkItemRecord,
  rows: readonly OutboxRow[],
  runs: readonly StatusRun[],
  repo: string | undefined,
  itemsByIssue: ReadonlyMap<string, WorkItemRecord>,
  facts: ReadonlyMap<string, WorkItemFact>,
  queue: ReadonlyMap<string, QueuePosition>,
  merging: ReadonlyMap<string, StatusMergeQueue>,
  jobs: readonly Job[],
): StatusItem {
  const id = publicId(record);
  const runId = linkedRunId(record, runs);
  const pr = pullRequest(record, rows, repo);
  const fact = facts.get(record.id);
  const waiting = record.state === "queued" ? queue.get(record.id) : undefined;
  const mergeQueue =
    record.state === "merge_queue" || record.state === "verifying"
      ? merging.get(record.id)
      : undefined;
  const githubQueue =
    record.state === "merge_queue" ? githubQueueOf(mergeJob(record.id, jobs)) : undefined;
  return {
    id,
    title: textOr(record.title, id),
    state: itemState(record.state),
    agent: runs.find((run) => run.id === runId)?.agent ?? "Paws",
    assignee: "Unassigned",
    owner: ownerName(fact),
    project: itemProject(fact),
    blockers: blockersFor(db, record, itemsByIssue),
    attempts: record.turnCount,
    branch: record.branchName.trim() ? record.branchName : null,
    runId,
    pr,
    links: pr === null ? [] : [{ label: `PR #${pr.number}`, href: pr.url }],
    version: record.version,
    ...(NO_CONTROL_STATES.includes(record.state) && !getConversation(db, record.id).blocked
      ? { noControls: true }
      : {}),
    ...(waiting
      ? {
          queue: {
            position: waiting.position,
            busySlots: waiting.busySlots,
            totalSlots: waiting.totalSlots,
            ...(waiting.ownerCap === null ? {} : { ownerCap: waiting.ownerCap }),
          },
        }
      : {}),
    ...(mergeQueue ? { mergeQueue } : {}),
    ...(githubQueue ? { githubQueue } : {}),
    ...visualReviewsOf(db, record),
    ...riskCarryOverOf(db, record),
  };
}

/**
 * The approval a fix kept: the item's latest classified head carried over a person's approval of
 * an earlier head because the fix changed no high-risk path.
 */
function riskCarryOverOf(
  db: Database,
  record: WorkItemRecord,
): { riskCarryOver?: StatusRiskCarryOver } {
  const fix = latestRiskFix(db, record.id);
  if (fix === null || fix.paths.length > 0) return {};
  if (latestCandidateRisk(db, record.id)?.head !== fix.head) return {};
  return {
    riskCarryOver: {
      head: fix.head,
      approvedHead: fix.approvedHead,
      changed: fix.changed,
      reason: riskCarryOverReason(fix.approvedHead, fix.changed),
    },
  };
}

/** The newest state changes the timeline shows. `stateTimes` reads every one. */
const TIMELINE_LIMIT = 200;
/** Enough rows for any item's whole history, so its state times start at its creation. */
const HISTORY_LIMIT = 100_000;

/**
 * The item's state changes from `work_item_event`, oldest first, omitted while it has none,
 * and the time it spent in each state since it was created, up to `now` while it is open.
 */
function historyOf(
  db: Database,
  record: WorkItemRecord,
  facts: ReadonlyMap<string, WorkItemFact>,
  now: number,
): { timeline?: StatusItemEvent[]; stateTimes?: StatusStateTimes } {
  const rows = listWorkItemEventRows(db, record.id, HISTORY_LIMIT);
  const created = facts.get(record.id)?.createdAt;
  const stateTimes =
    created === undefined ? {} : { stateTimes: toStateTimes(totalsOf(record, created, rows, now)) };
  if (rows.length === 0) return stateTimes;
  return {
    timeline: rows.slice(-TIMELINE_LIMIT).map((row) => ({
      at: iso(row.at),
      kind: row.kind,
      from: row.fromState,
      to: row.toState,
      event: row.event,
      reason: row.reason,
      actor: row.actor,
    })),
    ...stateTimes,
  };
}

function totalsOf(
  record: WorkItemRecord,
  created: number,
  rows: readonly WorkItemEventRow[],
  now: number,
): StateTotals {
  return stateTotals(Math.min(created, rows[0]?.at ?? created), rows, record.state, now);
}

/**
 * The visible items that merged in the last `STATUS_RECENT_MS`: their median and p90 time from
 * creation to merge and their average time in each state. Omitted when none merged.
 */
function mergedTimesFor(
  db: Database,
  visible: readonly WorkItemRecord[],
  facts: ReadonlyMap<string, WorkItemFact>,
  now: number,
): { mergedTimes?: StatusMergedTimes } {
  const since = now - STATUS_RECENT_MS;
  const changed = listLastWorkItemEventTimes(db);
  const merged = visible.flatMap((record) => {
    const created = facts.get(record.id)?.createdAt;
    const last = changed.get(record.id);
    if (record.state !== "merged" || created === undefined || last === undefined || last < since)
      return [];
    return [totalsOf(record, created, listWorkItemEventRows(db, record.id, HISTORY_LIMIT), now)];
  });
  const times = mergedTimes(merged, since);
  return times === null ? {} : { mergedTimes: times };
}

function heldOf(
  record: WorkItemRecord,
  holds: ReadonlyMap<string, ItemHold>,
): { held?: StatusHeld } {
  const hold = record.state === "queued" ? holds.get(record.id) : undefined;
  return hold
    ? {
        held: {
          reason: hold.reason,
          blockers: hold.blockers,
          ...(hold.files ? { files: hold.files } : {}),
        },
      }
    : {};
}

function visualReviewsOf(
  db: Database,
  record: WorkItemRecord,
): { visualReviews?: StatusVisualReview[] } {
  const reviews = listVisualReviews(db, record.id);
  if (reviews.length === 0) return {};
  const commits = new Map(listEvidence(db, record.id).map((row) => [row.id, row.headCommit]));
  const rounds = new Map<string, number>();
  return {
    visualReviews: reviews.map((review) => {
      // Nobody was asked when every screen carried over, so it is not a new round.
      const full =
        review.carried.length > 0 &&
        review.evidenceIds.every((id) => review.carried.some((entry) => entry.evidenceId === id));
      const round = Math.max(1, (rounds.get(review.checkId) ?? 0) + (full ? 0 : 1));
      rounds.set(review.checkId, round);
      const marks = listVisualReviewMarks(db, review.questionId).map((mark) => ({
        id: mark.id,
        evidenceId: mark.evidenceId,
      }));
      return {
        questionId: review.questionId,
        checkId: review.checkId,
        round,
        state: review.outcome ?? "waiting",
        evidenceIds: review.evidenceIds,
        commit:
          review.headCommit ||
          review.evidenceIds.map((id) => commits.get(id)).findLast(Boolean) ||
          null,
        askedAt: iso(review.createdAt),
        answeredBy: review.answeredBy || null,
        answeredAt: review.answeredAt === null ? null : iso(review.answeredAt),
        feedback: review.feedback?.trim() || null,
        ...(marks.length ? { marks } : {}),
        ...(review.carried.length
          ? {
              carried: review.carried.map((entry) => ({
                ...entry,
                approvedAt: iso(entry.approvedAt),
              })),
            }
          : {}),
      };
    }),
  };
}

/** What the merge job last saw of the pull request in GitHub's merge queue. */
function githubQueueOf(job: Job | undefined): StatusGitHubQueue | undefined {
  if (job === undefined || (job.status !== "pending" && job.status !== "running")) return undefined;
  const payload = job.payload;
  if (typeof payload !== "object" || payload === null) return undefined;
  const value = (payload as Record<string, unknown>).githubQueue;
  if (typeof value !== "object" || value === null) return undefined;
  const watch = value as Record<string, unknown>;
  if (watch.queued !== true || typeof watch.line !== "string" || typeof watch.state !== "string")
    return undefined;
  const position =
    typeof watch.position === "number" && Number.isInteger(watch.position) && watch.position >= 1
      ? watch.position
      : null;
  return { position, state: watch.state, line: watch.line };
}

function runsFor(
  records: readonly WorkItemRecord[],
  rows: readonly OutboxRow[],
  generatedAt: string,
  db: Database,
  pawsHome: string | undefined,
): StatusRun[] {
  const byItem = new Map(records.map((record) => [record.id, record]));
  const attempts = new Map<string, StoredRun[]>();
  for (const stored of listRuns(db))
    if (byItem.has(stored.itemId))
      attempts.set(stored.itemId, [...(attempts.get(stored.itemId) ?? []), stored]);
  const activityRows = indexActivityRows(rows);
  const runs: StatusRun[] = [];
  for (const [itemId, stored] of attempts) {
    const record = byItem.get(itemId)!;
    const first = stored[0]!;
    const current = stored.find((run) => run.id === record.currentRunId) ?? stored.at(-1)!;
    const activity = activityFor(db, record, stored, activityRows.for(record, stored), generatedAt);
    const recent = activity.at(-1);
    const pause = record.currentRunId === current.id ? usagePause(db, current.id) : null;
    const setup = runAgentSetup(db, current.id);
    runs.push({
      id: first.id,
      attempts: stored.map((run) => run.id),
      itemId: publicId(record),
      state: stored.some((run) => run.id === record.currentRunId)
        ? runState(record, current.status)
        : "done",
      agent: agentName(current.agent),
      reviewer: runReviewer(pawsHome, current.id),
      runner: runRunnerName(db, current.id),
      startedAt: iso(first.createdAt, generatedAt),
      attempt: Math.max(record.turnCount, record.checkpoint?.turn ?? 0),
      summary: recent?.text ?? textOr(record.title, publicId(record)),
      activity,
      links: [],
      ...(pause
        ? {
            usagePause: {
              agent: agentName(pause.agent),
              resumeAt: iso(pause.resumeAt, generatedAt),
            },
          }
        : {}),
      ...(setup
        ? {
            setup: {
              skills: setup.skills.map((skill) => ({
                name: skill.name,
                version: skill.version,
                installing: skill.status === "pending",
              })),
              hooks: setup.hooks,
            },
          }
        : {}),
    });
  }
  return runs;
}

function runReviewer(pawsHome: string | undefined, runId: string): string {
  if (!pawsHome || !/^[A-Za-z0-9_-]+$/.test(runId)) return "Unknown";
  try {
    const snapshot = JSON.parse(
      readFileSync(join(pawsHome, "runs", runId, "agent-profile.json"), "utf8"),
    );
    const reviewer = snapshot?.profiles?.reviewer?.agent;
    return ["claude", "codex", "grok", "opencode"].includes(reviewer)
      ? agentName(reviewer)
      : "Unknown";
  } catch (caughtError1) {
    journalCaught(caughtError1, "provider.runReviewer.parse", null);
    return "Unknown";
  }
}

function blockersFor(
  db: Database,
  record: WorkItemRecord,
  itemsByIssue: ReadonlyMap<string, WorkItemRecord>,
): string[] {
  const ids: string[] = [];
  for (const issueId of listTaskBlockers(db, record.linearIssueId)) {
    const blocker = itemsByIssue.get(issueId);
    if (blocker === undefined) continue;
    if (
      isBlockerSatisfied({
        state: blocker.state,
        mode: getTaskMode(db, blocker.id),
        mergeSha: getConfirmedRemoteMerge(db, blocker.id)?.mergeSha ?? null,
      })
    )
      continue;
    const id = publicId(blocker);
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function latestByLinearIssue(
  records: readonly WorkItemRecord[],
  facts: ReadonlyMap<string, WorkItemFact>,
): Map<string, WorkItemRecord> {
  const itemsByIssue = new Map<string, WorkItemRecord>();
  for (const record of records) {
    const current = itemsByIssue.get(record.linearIssueId);
    if (current === undefined || newerItem(record, current, facts)) {
      itemsByIssue.set(record.linearIssueId, record);
    }
  }
  return itemsByIssue;
}

function newerItem(
  candidate: WorkItemRecord,
  current: WorkItemRecord,
  facts: ReadonlyMap<string, WorkItemFact>,
): boolean {
  const candidateAt = facts.get(candidate.id)?.createdAt ?? 0;
  const currentAt = facts.get(current.id)?.createdAt ?? 0;
  if (candidateAt !== currentAt) return candidateAt > currentAt;
  return candidate.id > current.id;
}

function compareNewest(
  left: WorkItemRecord,
  right: WorkItemRecord,
  facts: ReadonlyMap<string, WorkItemFact>,
): number {
  const delta = (facts.get(right.id)?.createdAt ?? 0) - (facts.get(left.id)?.createdAt ?? 0);
  if (delta !== 0) return delta;
  if (left.id === right.id) return 0;
  return left.id < right.id ? 1 : -1;
}

function ownerName(fact: WorkItemFact | undefined): string | null {
  const name = fact?.owner?.trim() ?? "";
  return name.length > 0 ? name : null;
}

function itemProject(fact: WorkItemFact | undefined): StatusItem["project"] {
  const id = fact?.projectId?.trim() ?? "";
  const name = fact?.projectName?.trim() ?? "";
  if (id.length === 0 || name.length === 0) return null;
  return { id, name };
}

/** Lines of a failed check's output the bypass card shows when Closeout recorded no finding. */
const BYPASS_OUTPUT_LINES = 8;

/**
 * A bypass ask carries the failed checks of its head for the "Closeout needs
 * your help" card: state, attempt, and the finding or the end of the output.
 */
function withBypassChecks(
  db: Database,
  question: StatusQuestion,
  verdicts: readonly StatusVerdict[],
  env: NodeJS.ProcessEnv,
): StatusQuestion {
  const ask = question.linkAsk;
  if (ask?.kind !== "bypass" && ask?.kind !== "rule") return question;
  const recovery = getCloseoutRecovery(db, question.id);
  if (recovery === null) return question;
  const verdict = verdicts.find(
    (entry) => entry.itemId === question.itemId && entry.headSha === recovery.head,
  );
  const shown = verdict?.checks ?? [];
  const tail = (output: string | null | undefined) =>
    output?.trim().split("\n").slice(-BYPASS_OUTPUT_LINES).join("\n") ?? "";
  return {
    ...question,
    linkAsk: {
      ...ask,
      bypass: {
        policyDigest: recovery.policyDigest,
        passed: shown.filter((check) => check.state === "passed").map((check) => check.id),
        checks: listCloseoutBypassChecks(db, question.id).map((stored) => {
          const check = shown.find((entry) => entry.id === stored.checkId);
          return {
            id: stored.checkId,
            kind: stored.kind || check?.kind || "",
            state: stored.state,
            attempt: stored.attempt ?? check?.attempt ?? null,
            finding:
              check?.findings?.trim() ||
              tail(check?.stderr) ||
              tail(check?.stdout) ||
              redactCloseoutText(stored.message, env) ||
              check?.detail ||
              "",
          };
        }),
      },
    },
  };
}

/**
 * A risk ask carries what the Risk card shows: the head's high-risk paths, Closeout's summary of
 * the head and the findings of its review checks.
 */
function withRiskDetail(
  db: Database,
  question: StatusQuestion,
  verdicts: readonly StatusVerdict[],
): StatusQuestion {
  const ask = question.linkAsk;
  if (ask?.kind !== "risk") return question;
  const itemId = getLinkAsk(db, question.id)?.itemId;
  const risk = itemId ? getCandidateRisk(db, itemId, ask.head) : null;
  // After an approval the ask lists only what the fix changed since the approved head.
  const fix = itemId ? getRiskFix(db, itemId, ask.head) : null;
  const since = fix !== null && fix.paths.length > 0 ? fix : null;
  const verdict = verdicts.findLast(
    (entry) => entry.itemId === question.itemId && entry.headSha === ask.head,
  );
  return {
    ...question,
    linkAsk: {
      ...ask,
      risk: {
        paths: since?.paths ?? risk?.paths ?? [],
        ...(since ? { since: since.approvedHead } : {}),
        summary: verdict?.summary ?? "",
        findings: (verdict?.checks ?? []).flatMap((check) =>
          check.kind === "review" && check.findings?.trim()
            ? [{ id: check.id, finding: check.findings.trim() }]
            : [],
        ),
      },
    },
  };
}

function questionsFor(
  db: Database,
  records: readonly WorkItemRecord[],
  rows: readonly OutboxRow[],
  runs: readonly StatusRun[],
  openQuestions: readonly OpenQuestionRecord[],
): StatusQuestion[] {
  const questions: StatusQuestion[] = [];
  const seen = new Set<string>();
  const coveredItems = new Set<string>();
  for (const question of openQuestions) {
    const record = records.find((item) => item.id === question.itemId);
    if (record === undefined || seen.has(question.id)) continue;
    seen.add(question.id);
    coveredItems.add(record.id);
    const parsed = parseQuestion(question.body);
    const linkAsk = getLinkAsk(db, question.id);
    questions.push({
      id: question.id,
      itemId: publicId(record),
      runId: sessionRunId(question.runId, runs) ?? linkedRunId(record, runs),
      title: linkAsk?.title ?? (parsed.title || question.body),
      body: linkAsk?.detail ?? (parsed.body || question.body),
      context: linkAsk ? "" : parsed.context,
      ...(linkAsk && linkAsk.closedAt === null
        ? {
            linkAsk: {
              kind: linkAsk.kind,
              head: linkAsk.headCommit,
              title: linkAsk.title,
              detail: linkAsk.detail,
              link: linkAsk.link,
              ...(linkAsk.rounds === null
                ? {}
                : {
                    rounds: {
                      rounds: linkAsk.rounds.rounds,
                      open: linkAsk.rounds.open,
                      bugClass: linkAsk.rounds.bugClass,
                      limit: linkAsk.rounds.limit,
                    },
                  }),
            },
          }
        : {}),
      kind: "decision",
      urgency: "blocking",
      options: question.options,
      recommendedOption: null,
      askedAt: iso(question.createdAt),
      claimedBy: null,
      links: questionLinks(db, question.sessionId, record.linearIdentifier),
    });
  }
  const waiting = records.filter((record) => record.state === "awaiting_input");
  for (const record of waiting) {
    if (coveredItems.has(record.id)) continue;
    const session = record.sessionKey;
    if (session === null || session.length === 0) continue;
    const row = latest(rows, (candidate) => {
      if (candidate.op !== "elicitation") return false;
      if (
        candidate.orderingKey !== session &&
        readString(candidate.payload, "sessionId") !== session
      )
        return false;
      return questionId(candidate.idempotencyKey) !== null;
    });
    if (row === undefined) continue;
    const id = questionId(row.idempotencyKey);
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    const parsed = parseQuestion(readString(row.payload, "body") ?? "");
    if (parsed.title.length === 0) continue;
    const runId = linkedRunId(record, runs);
    questions.push({
      id,
      itemId: publicId(record),
      runId,
      title: parsed.title,
      body: parsed.body,
      context: parsed.context,
      kind: "decision",
      urgency: "blocking",
      options: stringList(row.payload, "options"),
      recommendedOption: null,
      askedAt: iso(row.createdAt),
      claimedBy: null,
      links: questionLinks(db, session, record.linearIdentifier),
    });
  }
  return questions;
}

function questionLinks(
  db: Database,
  sessionId: string,
  identifier: string,
): StatusQuestion["links"] {
  return [{ label: "Answer in Linear", href: linearConversationUrl(db, sessionId, identifier) }];
}

function verdictFor(
  record: WorkItemRecord,
  rows: readonly OutboxRow[],
  jobs: readonly Job[],
  progress: readonly CloseoutProgressRecord[],
  rounds: readonly CloseoutRound[],
  nowMs: number,
  env: NodeJS.ProcessEnv,
): StatusVerdict[] {
  const live = progressFor(record, progress);
  const candidates = verdictCandidates(record, rows, jobs);
  const best = candidates
    .sort((left, right) => left.at - right.at || left.score - right.score)
    .at(-1);
  const base = best ? toVerdict(record, best) : impliedVerdict(record);
  if (base === null) return [];
  if (!live) return [base];
  const verdict = withProgress(base, live, nowMs, env);
  return [
    { ...verdict, attempts: attemptsFor(record, progress, rounds, live, verdict, nowMs, env) },
  ];
}

function attemptsFor(
  record: WorkItemRecord,
  progress: readonly CloseoutProgressRecord[],
  rounds: readonly CloseoutRound[],
  live: CloseoutProgressRecord,
  verdict: StatusVerdict,
  nowMs: number,
  env: NodeJS.ProcessEnv,
): StatusCloseoutAttempt[] {
  const mine = progress
    .filter((row) => row.itemId === record.id && row.id !== live.id)
    .sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id));
  const starts = rounds
    .filter((round) => round.itemId === record.id)
    .map((round) => round.startedAt);
  return [...mine, live].map((row, index) => ({
    number: index + 1,
    ...(starts.length === 0
      ? {}
      : { round: 1 + starts.filter((start) => start <= row.startedAt).length }),
    decision:
      row === live
        ? verdict.decision
        : unfinished(row)
          ? "running"
          : (mapDecision(row.decision) ?? "running"),
    startedAt: new Date(row.startedAt).toISOString(),
    baseSha: blank(row.base),
    headSha: blank(row.head),
    policyDigest: blank(row.policyDigest),
    checks:
      row === live
        ? verdict.checks
        : row.steps
            .filter((step) => step.state !== "skipped")
            .map((step) => toLiveCheck(step, nowMs, env, row)),
    ...withSkippedRules(row === live ? (verdict.skippedRules ?? []) : skippedRules(row)),
  }));
}

function withSkippedRules(skipped: string[]): { skippedRules?: string[] } {
  return skipped.length > 0 ? { skippedRules: skipped } : {};
}

/** Where Closeout keeps each task's evidence records, as the artifact route reads them. */
function evidenceRoot(options: LiveStatusOptions, env: NodeJS.ProcessEnv): string | null {
  const home = options.pawsHome ?? env.PAWS_HOME;
  return home ? join(home, "closeout", "evidence") : null;
}

function progressFor(
  record: WorkItemRecord,
  progress: readonly CloseoutProgressRecord[],
): CloseoutProgressRecord | null {
  const mine = progress.filter((row) => row.itemId === record.id);
  if (mine.length === 0) return null;
  const running = mine.filter((row) => row.steps.some((step) => step.state === "running"));
  if (running.length > 0) return latestProgress(running);
  const open = mine.filter((row) => row.decision === null || row.finishedAt === null);
  if (open.length > 0) return latestProgress(open);
  const restarted = mine.filter(
    (row) =>
      row.finishedAt !== null &&
      row.updatedAt > row.finishedAt &&
      row.steps.some((step) => step.state === "pending" || step.state === "running"),
  );
  if (restarted.length > 0) return latestProgress(restarted);
  return latestProgress(mine);
}

function latestProgress(rows: readonly CloseoutProgressRecord[]): CloseoutProgressRecord | null {
  return (
    [...rows]
      .sort((left, right) => left.updatedAt - right.updatedAt || left.id.localeCompare(right.id))
      .at(-1) ?? null
  );
}

function unfinished(row: CloseoutProgressRecord): boolean {
  if (row.decision === null || row.finishedAt === null) return true;
  if (row.steps.some((step) => step.state === "running")) return true;
  return (
    row.updatedAt > row.finishedAt &&
    row.steps.some((step) => step.state === "pending" || step.state === "running")
  );
}

function sameCandidate(verdict: StatusVerdict, live: CloseoutProgressRecord): boolean {
  const verdictHead = (verdict.headSha ?? "").trim().toLowerCase();
  const liveHead = live.head.trim().toLowerCase();
  if (verdictHead.length === 0 || liveHead.length === 0 || verdictHead !== liveHead) return false;
  const verdictPolicy = (verdict.policyDigest ?? "").trim();
  if (verdictPolicy.length === 0) return true;
  return verdictPolicy === live.policyDigest;
}

function withProgress(
  verdict: StatusVerdict,
  live: CloseoutProgressRecord,
  nowMs: number,
  env: NodeJS.ProcessEnv,
): StatusVerdict {
  const checks = live.steps
    .filter((step) => step.state !== "skipped")
    .map((step) => toLiveCheck(step, nowMs, env, live));
  const skipped = skippedRules(live);
  const failing = checks.find(
    (check) => check.state === "failed" || check.state === "blocked" || check.state === "exhausted",
  );
  const fromProgress = mapDecision(live.decision);
  const open = unfinished(live);
  const attached =
    !open &&
    sameCandidate(verdict, live) &&
    (fromProgress === null || fromProgress === verdict.decision);
  const decision = open ? "running" : (fromProgress ?? (attached ? verdict.decision : "running"));
  return {
    ...verdict,
    decision,
    sealed: !open && decision !== "running",
    summary: open ? "Closeout is running." : attached ? verdict.summary : liveSummary(fromProgress),
    baseSha: blank(live.base) ?? (attached ? verdict.baseSha : null),
    headSha: blank(live.head) ?? (attached ? verdict.headSha : null),
    checks: checks.length > 0 ? checks : attached ? verdict.checks : [],
    failingCheck:
      decision === "accepted" ? null : (failing?.id ?? (attached ? verdict.failingCheck : null)),
    policyDigest: blank(live.policyDigest),
    policyPath: live.policyPath,
    ...(skipped.length > 0 ? { skippedRules: skipped } : {}),
  };
}

function liveSummary(decision: VerdictDecision | null): string {
  if (decision === "accepted") return "Closeout accepted.";
  if (decision === "rejected") return "Closeout rejected.";
  if (decision === "exhausted") return "Closeout exhausted its retry budget.";
  if (decision === "blocked") return "Closeout stopped and needs a person.";
  return "Closeout is running.";
}

function toLiveCheck(
  step: CloseoutStepRecord,
  nowMs: number,
  env: NodeJS.ProcessEnv,
  row: CloseoutProgressRecord,
): StatusCheck {
  const end = step.finishedAt ?? nowMs;
  return {
    id: step.id,
    kind: isRuleStep(step, row) ? "rule" : step.kind,
    state: step.state,
    command: step.command,
    detail: step.detail,
    attempt: step.attempt,
    timeoutSeconds: step.timeoutSeconds,
    elapsedMs:
      step.durationMs ?? (step.startedAt === null ? null : Math.max(0, end - step.startedAt)),
    exitCode: step.exitCode,
    timedOut: step.timedOut,
    timeoutReason: step.timeoutReason,
    stdout: redactCloseoutText(step.stdout, env),
    stderr: redactCloseoutText(step.stderr, env),
    truncated: step.truncated,
    findings: step.findings === null ? null : redactCloseoutText(step.findings, env),
    logPath: step.logPath,
    evidencePath: step.evidencePath,
    active: step.state === "running",
    tokens: step.tokens ?? null,
  };
}

function mapDecision(decision: string | null): VerdictDecision | null {
  if (decision === null) return null;
  return decisionOf(decision);
}

type VerdictCandidate = {
  at: number;
  score: number;
  decision: VerdictDecision;
  summary: string;
  head: string | null;
};

function verdictCandidates(
  record: WorkItemRecord,
  rows: readonly OutboxRow[],
  jobs: readonly Job[],
): VerdictCandidate[] {
  const found: VerdictCandidate[] = [];
  for (const row of rows) {
    const parsed = verdictKey(record.id, row.idempotencyKey);
    if (parsed) {
      const summary = readString(row.payload, "body") ?? "";
      const decision = decisionOf(parsed.outcome) ?? decisionFromSummary(summary);
      if (decision && summary.trim()) {
        found.push({
          at: row.createdAt,
          score: summary.includes("Items:") ? 1 : 0,
          decision,
          summary,
          head: parsed.head,
        });
      }
    }
    if (row.idempotencyKey === `${record.id}:exhausted`) {
      const summary = readString(row.payload, "body") ?? "";
      if (summary.trim()) {
        found.push({
          at: row.createdAt,
          score: 0,
          decision: "exhausted",
          summary,
          head: null,
        });
      }
    }
  }
  for (const job of jobs) {
    if (!isMergeJob(job.queue) || readString(job.payload, "itemId") !== record.id) continue;
    const summary = readString(job.payload, "summary");
    if (!summary?.trim()) continue;
    found.push({
      at: job.createdAt,
      score: summary.includes("Items:") ? 1 : 0,
      decision: decisionFromSummary(summary) ?? "accepted",
      summary,
      head: readString(job.payload, "head"),
    });
  }
  return found;
}

function toVerdict(record: WorkItemRecord, candidate: VerdictCandidate): StatusVerdict {
  const checks = parseChecks(candidate.summary);
  const attempt = attemptOf(candidate.summary, record);
  const failing = checks.find((check) => check.state === "failed");
  return {
    itemId: publicId(record),
    decision: candidate.decision,
    attempt,
    maxAttempts: Math.max(MAX_CLOSEOUT_ATTEMPTS, attempt),
    summary: candidate.summary.trim(),
    failingCheck: candidate.decision === "accepted" ? null : (failing?.id ?? null),
    baseSha: shaField(candidate.summary, "Base") ?? blank(record.checkpoint?.baseSha),
    headSha:
      shaField(candidate.summary, "Head") ??
      blank(candidate.head) ??
      blank(record.checkpoint?.wipCommit),
    sealed: candidate.decision !== "running",
    checks,
    links: [],
  };
}

function impliedVerdict(record: WorkItemRecord): StatusVerdict | null {
  const decision = impliedDecision(record.state);
  if (decision === null) return null;
  const attempt = Math.max(record.turnCount, 1);
  const summary =
    decision === "running"
      ? "Closeout is running."
      : decision === "exhausted"
        ? "Closeout exhausted its retry budget."
        : "Closeout accepted.";
  return {
    itemId: publicId(record),
    decision,
    attempt,
    maxAttempts: Math.max(MAX_CLOSEOUT_ATTEMPTS, attempt),
    summary,
    failingCheck: null,
    baseSha: blank(record.checkpoint?.baseSha),
    headSha: blank(record.checkpoint?.wipCommit),
    sealed: decision !== "running",
    checks: [],
    links: [],
  };
}

function impliedDecision(state: WorkItemRecord["state"]): VerdictDecision | null {
  switch (state) {
    case "verifying":
      return "running";
    case "merge_queue":
    case "merged":
      return "accepted";
    default:
      return null;
  }
}

type MergeQueueInput = {
  records: readonly WorkItemRecord[];
  items: readonly StatusItem[];
  jobs: readonly Job[];
  queues: readonly MergeQueuePosition[];
  generatedAt: string;
  now: number;
  repo: string | undefined;
};

/**
 * Every task Closeout accepted that waits to merge, per repository in queue order, and what
 * merged or went back to the agent in the last 24 hours. A task waiting for a review is listed
 * without a place: it holds none until it is approved.
 */
function mergeQueueFor(
  db: Database,
  input: MergeQueueInput,
): Pick<StatusSnapshot, "mergeQueue" | "mergeHistory"> {
  const { records, jobs, generatedAt } = input;
  const items = new Map(input.items.map((item) => [item.id, item]));
  const places = new Map(input.queues.map((entry) => [entry.itemId, entry]));
  // The repository Paws bound the item to names it. `config.repo` only names items from before
  // repository binding, and an item with none of these is under "Repository not known".
  const repositoryOf = (record: WorkItemRecord): string | null => {
    const bound = getWorkItemRepository(db, record.id);
    return (
      (bound ? `${bound.owner}/${bound.repo}` : null) ??
      places.get(record.id)?.repository ??
      pullRepository(items.get(publicId(record))?.pr?.url) ??
      input.repo ??
      null
    );
  };
  const waiting = records
    .filter(
      (record) =>
        record.state === "merge_queue" || (record.state === "verifying" && places.has(record.id)),
    )
    .map((record): StatusMergeEntry => {
      const job = mergeJob(record.id, jobs);
      const place = places.get(record.id);
      const wait = mergeWait(job);
      const reason =
        record.state === "verifying"
          ? "closeout"
          : place?.nextItemId
            ? "ahead"
            : (wait?.reason ?? "ci");
      const ahead = place?.nextItemId
        ? records.find((candidate) => candidate.id === place.nextItemId)
        : undefined;
      return {
        position: place?.position ?? null,
        itemId: publicId(record),
        repository: repositoryOf(record),
        enqueuedAt: place
          ? iso(place.readyAt, generatedAt)
          : enqueuedAt(record.id, jobs, generatedAt),
        acceptedAt: acceptedAt(record.id, jobs, generatedAt),
        waitingFor: reason,
        detail: waitsForRunnerSlot(record.id, jobs)
          ? SLOT_WAIT_DETAIL
          : reason === "ahead"
            ? ahead
              ? `Starts when ${aheadLabel(ahead, items)} merges`
              : null
            : reason === "closeout"
              ? "Re-checking, keeps its place."
              : (wait?.message ?? null),
        settings: mergeSettings(db, record.id),
        steps: mergeSteps(job),
      };
    })
    .sort(
      (left, right) =>
        compareRepositories(left.repository, right.repository) ||
        (left.position ?? Number.MAX_SAFE_INTEGER) - (right.position ?? Number.MAX_SAFE_INTEGER) ||
        left.acceptedAt.localeCompare(right.acceptedAt) ||
        left.itemId.localeCompare(right.itemId),
    );
  const since = input.now - DAY_MS;
  const history: StatusMergeOutcome[] = [];
  for (const record of records) {
    if (record.state === "merged" || record.state === "completed") {
      const merge = getConfirmedRemoteMerge(db, record.id);
      if (!merge || merge.confirmedAt < since) continue;
      history.push({
        itemId: publicId(record),
        repository: `${merge.repositoryOwner}/${merge.repositoryName}`,
        outcome: "merged",
        reason: null,
        at: iso(merge.confirmedAt, generatedAt),
        settings: mergeSettings(db, record.id),
      });
      continue;
    }
    if (!BACK_WITH_AGENT_STATES.has(record.state) || places.has(record.id)) continue;
    const back = backWithAgent(record.id, jobs);
    if (!back || back.at < since) continue;
    history.push({
      itemId: publicId(record),
      repository: repositoryOf(record),
      outcome: "back_with_agent",
      reason: back.reason,
      at: iso(back.at, generatedAt),
      settings: mergeSettings(db, record.id),
    });
  }
  history.sort((left, right) => right.at.localeCompare(left.at));
  return { mergeQueue: waiting, mergeHistory: history };
}

/** By name, with entries whose repository is not known last. */
function compareRepositories(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left.localeCompare(right);
}

function aheadLabel(record: WorkItemRecord, items: ReadonlyMap<string, StatusItem>): string {
  const pr = items.get(publicId(record))?.pr;
  return pr ? `#${pr.number}` : publicId(record);
}

/** `https://github.com/acme/platform/pull/412` is `acme/platform`. */
function pullRepository(url: string | undefined): string | null {
  const match = url ? /github\.com\/([^/\s]+\/[^/\s]+)\/pull\//.exec(url) : null;
  return match?.[1] ?? null;
}

/** The settings the task resolved when its merge started. The workspace default until then. */
function mergeSettings(db: Database, itemId: string): StatusMergeSettings {
  const kept = getTaskMergeSettings(db, itemId);
  if (!kept) return { order: "queue", mainMoved: "ci", rule: null };
  const sources = isRecord(kept.resolved.sources) ? kept.resolved.sources : {};
  const rule = isRecord(kept.resolved.rule) ? readString(kept.resolved.rule, "label") : null;
  const ruled = sources.order === "rule" || sources.mainMoved === "rule";
  return { order: kept.order, mainMoved: kept.mainMoved, rule: ruled ? rule : null };
}

/** What the merge job said it waits for the last time it parked. */
function mergeWait(
  job: Job | undefined,
): { reason: "ci" | "review" | "branch_update" | "ahead"; message: string | null } | null {
  const wait = isRecord(job?.payload) ? job.payload.mergeWait : undefined;
  if (!isRecord(wait)) return null;
  const reason = wait.reason;
  if (reason !== "ci" && reason !== "review" && reason !== "branch_update" && reason !== "ahead")
    return null;
  return { reason, message: blank(readString(wait, "message")) };
}

/** The latest hand-back to the agent after a merge, when no merge started since. */
function backWithAgent(
  itemId: string,
  jobs: readonly Job[],
): { reason: "ci_failed" | "conflict"; at: number } | null {
  const resume = newest(
    jobs.filter(
      (job) => job.queue === RESUME_QUEUE && readString(job.payload, "itemId") === itemId,
    ),
  );
  const reason = readString(resume?.payload, "reason");
  if (!resume || (reason !== "ci-failed" && reason !== "rebase-conflict")) return null;
  const merge = newest(
    jobs.filter((job) => isMergeJob(job.queue) && readString(job.payload, "itemId") === itemId),
  );
  if (merge && merge.createdAt > resume.createdAt) return null;
  return { reason: reason === "ci-failed" ? "ci_failed" : "conflict", at: resume.createdAt };
}

function newest(jobs: readonly Job[]): Job | undefined {
  return jobs.reduce<Job | undefined>(
    (best, job) =>
      best === undefined ||
      job.createdAt > best.createdAt ||
      (job.createdAt === best.createdAt && job.id > best.id)
        ? job
        : best,
    undefined,
  );
}

/**
 * When Closeout accepted the change now waiting: the first merge job since the agent last
 * resumed. A Closeout re-check after a branch update keeps the original time.
 */
function acceptedAt(itemId: string, jobs: readonly Job[], generatedAt: string): string {
  const mine = (queue: (name: string) => boolean) =>
    jobs.filter((job) => queue(job.queue) && readString(job.payload, "itemId") === itemId);
  const resumed = newest(mine((name) => name === RESUME_QUEUE))?.createdAt ?? -1;
  const since = mine(isMergeJob).filter((job) => job.createdAt > resumed);
  const first = since.reduce<Job | undefined>(
    (best, job) => (best === undefined || job.createdAt < best.createdAt ? job : best),
    undefined,
  );
  return first === undefined
    ? enqueuedAt(itemId, jobs, generatedAt)
    : iso(first.createdAt, generatedAt);
}

/** Whether the item's re-verify or resume waits for a busy runner to free a slot. */
function waitsForRunnerSlot(itemId: string, jobs: readonly Job[]): boolean {
  return jobs.some(
    (job) =>
      job.status === "pending" &&
      (job.queue === RESUME_QUEUE || job.queue === REVERIFY_QUEUE) &&
      readString(job.payload, "itemId") === itemId &&
      (runnerCapacityWait(job.payload)?.runnerIds.length ?? 0) > 0,
  );
}

function mergeJob(itemId: string, jobs: readonly Job[]): Job | undefined {
  const mine = jobs.filter(
    (job) => isMergeJob(job.queue) && readString(job.payload, "itemId") === itemId,
  );
  const open = mine.filter((job) => job.status === "pending" || job.status === "running");
  const pool = open.length > 0 ? open : mine;
  return [...pool].sort((left, right) => right.id - left.id)[0];
}

function enqueuedAt(itemId: string, jobs: readonly Job[], generatedAt: string): string {
  const mine = jobs.filter(
    (job) => isMergeJob(job.queue) && readString(job.payload, "itemId") === itemId,
  );
  const oldest = mine.reduce<Job | undefined>((best, job) => {
    if (best === undefined || job.createdAt < best.createdAt) return job;
    return best;
  }, undefined);
  return oldest === undefined ? generatedAt : iso(oldest.createdAt, generatedAt);
}

function mergeSteps(job: Job | undefined): StatusMergeEntry["steps"] {
  if (job === undefined || job.status === "pending" || job.status === "cancelled") {
    return MERGE_STEPS.map((name) => ({ name, state: "wait" as const, detail: null }));
  }
  if (job.status === "dead") {
    return MERGE_STEPS.map((name, index) => ({
      name,
      state: "wait" as const,
      detail: index === 0 ? blank(job.lastError) : null,
    }));
  }
  if (job.status === "running") {
    return [
      { name: MERGE_STEPS[0], state: "run", detail: null },
      { name: MERGE_STEPS[1], state: "wait", detail: null },
      { name: MERGE_STEPS[2], state: "wait", detail: null },
    ];
  }
  return [
    { name: MERGE_STEPS[0], state: "done", detail: null },
    { name: MERGE_STEPS[1], state: "done", detail: null },
    { name: MERGE_STEPS[2], state: "run", detail: null },
  ];
}

function indexActivityRows(rows: readonly OutboxRow[]) {
  const position = new Map<OutboxRow, number>();
  const byKeyOwner = new Map<string, OutboxRow[]>();
  const bySession = new Map<string, OutboxRow[]>();
  const add = (index: Map<string, OutboxRow[]>, key: string, row: OutboxRow) => {
    const list = index.get(key);
    if (list) list.push(row);
    else index.set(key, [row]);
  };
  rows.forEach((row, at) => {
    if (row.op !== "activity" && row.op !== "elicitation") return;
    position.set(row, at);
    const parts = row.idempotencyKey.split(":");
    add(byKeyOwner, (parts[0] === "cap" || parts[0] === "fail" ? parts[1] : parts[0]) ?? "", row);
    if (row.orderingKey !== null) add(bySession, row.orderingKey, row);
  });
  return {
    for(record: WorkItemRecord, stored: readonly StoredRun[]): OutboxRow[] {
      const found = new Set<OutboxRow>([
        ...(byKeyOwner.get(record.id) ?? []),
        ...stored.flatMap((run) => byKeyOwner.get(run.id) ?? []),
        ...(record.sessionKey === null ? [] : (bySession.get(record.sessionKey) ?? [])),
      ]);
      return [...found].sort((left, right) => position.get(left)! - position.get(right)!);
    },
  };
}

function activityFor(
  db: Database,
  record: WorkItemRecord,
  stored: readonly StoredRun[],
  rows: readonly OutboxRow[],
  generatedAt: string,
): StatusActivity[] {
  const lines: Array<{ at: number; line: StatusActivity }> = [];
  for (const row of rows) {
    if (!stored.some((run) => concerns(row, record, run.id))) continue;
    const body = readString(row.payload, "body")?.trim() ?? "";
    if (!body) continue;
    const kind = activityKind(
      row.op === "elicitation" ? "elicitation" : readString(row.payload, "kind"),
    );
    lines.push({ at: row.createdAt, line: { at: iso(row.createdAt), kind, text: body } });
  }
  for (const turn of listLinearTurnsForItem(db, record.id))
    lines.push({
      at: turn.createdAtMs,
      line: {
        at: iso(turn.createdAtMs, generatedAt),
        kind: "prompt",
        text: `${turnAuthor(turn.payload)} replied.`,
      },
    });
  for (const run of stored)
    lines.push({
      at: run.createdAt,
      line: {
        at: iso(run.createdAt, generatedAt),
        kind: "system",
        text:
          run.kind === "recheck"
            ? "Closeout re-check started."
            : `${run.kind === "review" ? "Review" : "Implementation"} started with ${agentName(run.agent)}.`,
      },
    });
  return lines.sort((left, right) => left.at - right.at).map((entry) => entry.line);
}

function turnAuthor(payload: string): string {
  try {
    const name = (JSON.parse(payload) as { agentActivity?: { user?: { name?: unknown } } })
      .agentActivity?.user?.name;
    return typeof name === "string" && name.trim() ? name.trim() : "Someone";
  } catch (caughtError2) {
    journalCaught(caughtError2, "provider.turnAuthor.parse", null);
    return "Someone";
  }
}

function concerns(row: OutboxRow, record: WorkItemRecord, runId: string): boolean {
  if (row.op !== "activity" && row.op !== "elicitation") return false;
  const key = row.idempotencyKey;
  if (key.startsWith(`${runId}:`) || key.startsWith(`${record.id}:`)) return true;
  if (key.startsWith(`cap:${record.id}:`) || key.startsWith(`fail:${record.id}:`)) return true;
  const body = readString(row.payload, "body") ?? "";
  return (
    record.sessionKey !== null &&
    row.orderingKey === record.sessionKey &&
    body.includes(record.linearIdentifier)
  );
}

function pullRequest(
  record: WorkItemRecord,
  rows: readonly OutboxRow[],
  repo: string | undefined,
): StatusPullRequest | null {
  const prefix = `${record.id}:pr:`;
  const row = latest(rows, (candidate) => candidate.idempotencyKey.startsWith(prefix));
  if (row === undefined) return null;
  const number = Number(row.idempotencyKey.slice(prefix.length));
  if (!Number.isInteger(number) || number < 1) return null;
  const body = readString(row.payload, "body") ?? "";
  const matched = /https?:\/\/[^\s)]+/.exec(body)?.[0]?.replace(/[.,)]+$/, "");
  const fromBody = matched ? httpUrl(matched) : null;
  if (fromBody) return { number, url: fromBody };
  if (repo && /^[^/\s]+\/[^/\s]+$/.test(repo)) {
    return { number, url: `https://github.com/${repo}/pull/${number}` };
  }
  return null;
}

function projectOf(
  records: readonly WorkItemRecord[],
  project: LiveStatusOptions["project"],
): StatusProject {
  return {
    name: textOr(project?.name ?? "", "Paws"),
    team: textOr(project?.team ?? "", teamFrom(records)),
    repo: textOr(project?.repo ?? "", "local"),
    workspace: project?.workspace === undefined ? null : project.workspace,
  };
}

function teamFrom(records: readonly WorkItemRecord[]): string {
  const counts = new Map<string, number>();
  for (const record of records) {
    const [prefix, rest] = record.linearIdentifier.split("-");
    if (!prefix || rest === undefined || !prefix.trim()) continue;
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  let best = "";
  let count = 0;
  for (const [prefix, seen] of counts) {
    if (seen > count) {
      best = prefix;
      count = seen;
    }
  }
  return best || "Paws";
}

function itemState(state: WorkItemRecord["state"]): ItemState {
  switch (state) {
    case "planning":
      return "planning";
    case "queued":
      return "queued";
    case "running":
    case "recovering":
      return "running";
    case "awaiting_input":
      return "awaiting_input";
    case "verifying":
      return "verifying";
    case "merge_queue":
      return "merge_queue";
    case "merged":
      return "merged";
    case "completed":
      return "completed";
    case "paused":
    case "cancelled":
      return "stopped";
    case "failed":
    case "manual":
      return "needs_human";
  }
}

function runState(record: WorkItemRecord, status: string): RunState {
  if (record.state === "awaiting_input") return "awaiting_input";
  if (record.state === "paused") return "paused";
  if (status === "lost" || record.state === "cancelled" || record.state === "failed")
    return "stopped";
  if (record.state === "verifying" || record.checkpoint?.phase === "verifying") return "verifying";
  if (
    status === "ended" ||
    record.state === "completed" ||
    record.state === "merged" ||
    record.state === "merge_queue" ||
    record.state === "manual"
  ) {
    return "done";
  }
  return "running";
}

function linkedRunId(record: WorkItemRecord, runs: readonly StatusRun[]): string | null {
  return sessionRunId(record.currentRunId, runs);
}

function sessionRunId(runId: string | null, runs: readonly StatusRun[]): string | null {
  if (runId === null) return null;
  return runs.find((run) => run.id === runId || run.attempts?.includes(runId))?.id ?? null;
}

function publicId(record: WorkItemRecord): string {
  return textOr(record.linearIdentifier, record.id);
}

function agentName(agent: string): string {
  const known: Record<string, string> = {
    claude: "Claude",
    codex: "Codex",
    grok: "Grok",
    opencode: "OpenCode",
    cursor: "Cursor",
    gemini: "Gemini",
    paws: "Paws",
  };
  const trimmed = agent.trim();
  if (!trimmed) return "Paws";
  return known[trimmed.toLowerCase()] ?? trimmed;
}

function isMergeJob(queue: string): boolean {
  return queue === MERGE_QUEUE || queue.startsWith(`${MERGE_QUEUE}.`);
}

function verdictKey(itemId: string, key: string): { head: string; outcome: string } | null {
  const prefix = `${itemId}:verdict:`;
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);
  const split = rest.lastIndexOf(":");
  if (split <= 0) return null;
  const head = rest.slice(0, split);
  const outcome = rest.slice(split + 1);
  if (!head || !outcome) return null;
  return { head, outcome };
}

function questionId(key: string): string | null {
  const prefix = ["ask:", "question:"].find((candidate) => key.startsWith(candidate));
  if (prefix === undefined) return null;
  const id = key.slice(prefix.length).trim();
  return id || null;
}

function parseQuestion(body: string): { title: string; body: string; context: string } {
  const footer = "Reply with one of the options, or answer in your own words.";
  let text = body.trim();
  if (text.endsWith(footer)) text = text.slice(0, -footer.length).trim();
  const parts = text.split(/\n\n/);
  const question = parts[0]?.trim() ?? "";
  const context = parts.slice(1).join("\n\n").trim();
  const title = question.split("\n")[0]?.trim() ?? "";
  return { title, body: question || title, context };
}

function parseChecks(summary: string): StatusCheck[] {
  const checks: StatusCheck[] = [];
  for (const line of summary.split("\n")) {
    const match = /^- (.+?) \(([^)]+)\): ([A-Za-z_]+)(?: attempt \d+)?\s+[—-]\s+(.*)$/.exec(
      line.trim(),
    );
    const id = match?.[1]?.trim();
    const kind = match?.[2]?.trim();
    const state = match?.[3]?.trim();
    if (!match || !id || !kind || !state || checkState(state) === "skipped") continue;
    const detail = match[4]?.trim() ?? "";
    checks.push({
      id,
      kind: checkKind(kind),
      state: checkState(state),
      command: id,
      detail: detail || null,
    });
  }
  return checks;
}

function checkKind(kind: string): CheckKind {
  const value = kind.toLowerCase();
  if (value === "review") return "review";
  if (value === "setup") return "setup";
  if (value === "evidence") return "evidence";
  if (value === "rule") return "rule";
  return "command";
}

function checkState(state: string): CheckState {
  const value = state.toLowerCase();
  if (
    value === "passed" ||
    value === "failed" ||
    value === "running" ||
    value === "pending" ||
    value === "skipped" ||
    value === "blocked" ||
    value === "exhausted"
  ) {
    return value;
  }
  return "failed";
}

function decisionOf(outcome: string): VerdictDecision | null {
  switch (outcome.toLowerCase()) {
    case "accepted":
    case "rejected":
    case "exhausted":
    case "running":
    case "blocked":
      return outcome.toLowerCase() as VerdictDecision;
    case "invalid":
    case "fix_failed":
      return "blocked";
    default:
      return null;
  }
}

function decisionFromSummary(summary: string): VerdictDecision | null {
  const line = summary.split("\n").find((entry) => entry.startsWith("Closeout:"));
  if (line === undefined) return null;
  return decisionOf(line.slice("Closeout:".length).trim());
}

function attemptOf(summary: string, record: WorkItemRecord): number {
  const caller = intField(summary, "Caller attempt");
  if (caller !== null) return caller;
  const evaluations = intField(summary, "Evaluations");
  if (evaluations !== null) return evaluations;
  const fixes = intField(summary, "Fix attempts");
  if (fixes !== null) return fixes + 1;
  return Math.max(record.turnCount, 1);
}

function intField(summary: string, label: string): number | null {
  const value = lineField(summary, label);
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

function shaField(summary: string, label: string): string | null {
  return blank(lineField(summary, label) ?? undefined);
}

function lineField(summary: string, label: string): string | null {
  const prefix = `${label}:`;
  const line = summary.split("\n").find((entry) => entry.startsWith(prefix));
  if (line === undefined) return null;
  const value = line.slice(prefix.length).trim();
  return value || null;
}

function activityKind(kind: string | null): ActivityKind {
  if (
    kind === "thought" ||
    kind === "action" ||
    kind === "tool" ||
    kind === "elicitation" ||
    kind === "system" ||
    kind === "ok" ||
    kind === "err" ||
    kind === "prompt"
  ) {
    return kind;
  }
  if (kind === "error") return "err";
  if (kind === "response") return "ok";
  return "system";
}

function latest(
  rows: readonly OutboxRow[],
  match: (row: OutboxRow) => boolean,
): OutboxRow | undefined {
  let found: OutboxRow | undefined;
  for (const row of rows) {
    if (!match(row)) continue;
    if (found === undefined || row.id > found.id) found = row;
  }
  return found;
}

function stringList(payload: unknown, key: string): string[] {
  if (!isRecord(payload)) return [];
  const value = payload[key];
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string" && entry.trim()) return [entry];
    if (!isRecord(entry)) return [];
    const label = readString(entry, "label") ?? readString(entry, "value");
    return label?.trim() ? [label] : [];
  });
}

function readString(payload: unknown, key: string): string | null {
  if (!isRecord(payload)) return null;
  const value = payload[key];
  return typeof value === "string" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function iso(ms: number, fallback = new Date(0).toISOString()): string {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toISOString();
}

function blank(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "none") return null;
  return trimmed;
}

function textOr(value: string, fallback: string): string {
  const trimmed = value.trim();
  return trimmed || fallback;
}

function httpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch (caughtError3) {
    journalCaught(caughtError3, "provider.httpUrl.toString", null);
    return null;
  }
}
