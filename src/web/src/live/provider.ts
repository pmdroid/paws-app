/**
 * Live status snapshot.
 *
 * Reads through `src/db`'s public index only. There is no SQL here.
 *
 * `src/db/index.ts` does not export every row the dashboard shows. Where a
 * reader is missing, this file uses the closest exported row and leaves the
 * gap empty rather than querying a table directly:
 *
 * - No `listEpics` / `getEpic`. Epic title, Linear identifier, description,
 *   DRI, and epic state are not on an exported row. Epics are one group per
 *   `WorkItemRecord.epicId`; the id is the title; the state is derived from
 *   the child items.
 * - `listRuns` supplies every stored run for the visible items. The run row
 *   has no reviewer, summary, or activity log; those still come from outbox
 *   activity. `currentRunId` is the item's linked run.
 * - `listOpenQuestions` supplies open question rows. An outbox elicitation
 *   is still used when the question table has no row for that item.
 *   Recommended option and claim are not stored.
 * - `listWorkItemBlocks` supplies blockers. A blocker is shown when that
 *   Linear issue is another item in the same epic.
 * - No Closeout table. Verdicts are parsed from outbox activity
 *   (`${itemId}:verdict:${head}:${outcome}` and `${itemId}:exhausted`) and
 *   from `github.merge` job payloads. Checks are parsed from the evidence
 *   summary text. `closeout-verdict.json` on disk is not read.
 * - No pull-request table. Number and URL come from outbox activity
 *   `${itemId}:pr:${number}`.
 * - No enqueue timestamp on the work item. Merge `enqueuedAt` is the merge
 *   job's `createdAt`, or the snapshot time when no job exists. Step state
 *   follows that job's status.
 * - No project, assignee, or DRI columns. Name defaults to "Paws", team to
 *   the Linear identifier prefix, repo to "local", assignee to "Unassigned",
 *   DRI to "Paws". `LiveStatusOptions.project` overrides the project.
 */

import type { Database } from "bun:sqlite";
import type {
  Job,
  OpenQuestionRecord,
  OutboxRow,
  WorkItemBlockRecord,
  WorkItemRecord,
} from "../../../db";
import {
  listCloseoutProgress,
  listJobs,
  listOpenQuestions,
  listOutbox,
  listRuns,
  listWorkItemBlocks,
  listWorkItemsByStates,
  type CloseoutProgressRecord,
  type CloseoutStepRecord,
} from "../../../db";
import { redactCloseoutText } from "../server/artifact";
import {
  STATUS_API_VERSION,
  type ActivityKind,
  type CheckKind,
  type CheckState,
  type EventLevel,
  type ItemState,
  type NoteKind,
  type RunState,
  type StatusActivity,
  type StatusCheck,
  type StatusEpic,
  type StatusEvent,
  type StatusItem,
  type StatusMergeEntry,
  type StatusNote,
  type StatusProject,
  type StatusPullRequest,
  type StatusQuestion,
  type StatusRun,
  type StatusSnapshot,
  type StatusVerdict,
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
  "exhausted",
  "failed",
  "awaiting_signoff",
  "merge_queue",
  "manual",
  "merged",
  "completed",
  "cancelled",
] as const;

const MERGE_QUEUE = "github.merge";
const REVIEWER = "Codex";
const MAX_CLOSEOUT_ATTEMPTS = 3;

const MERGE_STEPS = ["Rebase onto main", "Re-run Closeout", "Squash merge"] as const;

export type LiveStatusOptions = {
  now?: () => Date;
  project?: {
    name?: string;
    team?: string;
    repo?: string;
    workspace?: string | null;
  };
  env?: NodeJS.ProcessEnv;
};

export function createLiveStatusProvider(
  db: Database,
  options: LiveStatusOptions = {},
): { snapshot(): StatusSnapshot } {
  return {
    snapshot() {
      return readLiveSnapshot(db, options);
    },
  };
}

export function emptyLiveSnapshot(
  now = new Date(),
  project?: LiveStatusOptions["project"],
): StatusSnapshot {
  return {
    version: STATUS_API_VERSION,
    source: "live",
    generatedAt: now.toISOString(),
    project: projectOf([], project),
    epics: [],
    items: [],
    runs: [],
    questions: [],
    verdicts: [],
    mergeQueue: [],
    events: [],
  };
}

function readLiveSnapshot(db: Database, options: LiveStatusOptions): StatusSnapshot {
  const now = options.now?.() ?? new Date();
  const generatedAt = now.toISOString();
  const records = listWorkItemsByStates(db, WORK_ITEM_STATES).sort(byPosition);
  if (records.length === 0) return emptyLiveSnapshot(now, options.project);
  const rows = listOutbox(db);
  const jobs = listJobs(db);
  const blocks = listWorkItemBlocks(db);
  const openQuestions = listOpenQuestions(db);
  const runs = runsFor(records, rows, generatedAt, db);
  const items = records.map((record) =>
    toItem(record, rows, runs, options.project?.repo, blocks, records),
  );
  const progress = listCloseoutProgress(db);
  const env = options.env ?? process.env;
  return {
    version: STATUS_API_VERSION,
    source: "live",
    generatedAt,
    project: projectOf(records, options.project),
    epics: epicsFor(records, rows),
    items,
    runs,
    questions: questionsFor(records, rows, runs, openQuestions),
    verdicts: records.flatMap((record) =>
      verdictFor(record, rows, jobs, progress, now.getTime(), env),
    ),
    mergeQueue: mergeQueueFor(records, jobs, generatedAt),
    events: eventsFor(rows),
  };
}

function epicsFor(records: readonly WorkItemRecord[], rows: readonly OutboxRow[]): StatusEpic[] {
  const groups = new Map<string, WorkItemRecord[]>();
  for (const record of records) {
    const group = groups.get(record.epicId) ?? [];
    group.push(record);
    groups.set(record.epicId, group);
  }
  return [...groups.entries()].map(([id, group]) => ({
    id,
    title: id,
    description: "",
    state: epicState(group),
    delegated: true,
    dri: "Paws",
    session: notesFor(group, rows),
    links: [],
  }));
}

function epicState(group: readonly WorkItemRecord[]): StatusEpic["state"] {
  if (group.every((item) => ["completed", "merged", "cancelled"].includes(item.state)))
    return "done";
  if (group.some((item) => item.state === "awaiting_input")) return "awaiting_input";
  if (group.every((item) => item.state === "queued" || item.state === "planning"))
    return "planning";
  return "running";
}

function toItem(
  record: WorkItemRecord,
  rows: readonly OutboxRow[],
  runs: readonly StatusRun[],
  repo: string | undefined,
  blocks: readonly WorkItemBlockRecord[],
  records: readonly WorkItemRecord[],
): StatusItem {
  const id = publicId(record);
  const runId = linkedRunId(record, runs);
  const pr = pullRequest(record, rows, repo);
  return {
    id,
    epicId: record.epicId,
    title: textOr(record.title, id),
    state: itemState(record.state),
    agent: runs.find((run) => run.id === runId)?.agent ?? "Paws",
    assignee: "Unassigned",
    blockers: blockersFor(record, blocks, records),
    attempts: record.turnCount,
    branch: record.branchName.trim() ? record.branchName : null,
    runId,
    pr,
    links: pr === null ? [] : [{ label: `PR #${pr.number}`, href: pr.url }],
  };
}

function runsFor(
  records: readonly WorkItemRecord[],
  rows: readonly OutboxRow[],
  generatedAt: string,
  db: Database,
): StatusRun[] {
  const byItem = new Map(records.map((record) => [record.id, record]));
  const runs: StatusRun[] = [];
  for (const stored of listRuns(db)) {
    const record = byItem.get(stored.itemId);
    if (record === undefined) continue;
    const activity = activityFor(record, stored.id, rows);
    const recent = activity.at(-1);
    const current = record.currentRunId === stored.id;
    runs.push({
      id: stored.id,
      itemId: publicId(record),
      state: current ? runState(record, stored.status) : "done",
      agent: agentName(stored.agent),
      reviewer: REVIEWER,
      startedAt: iso(stored.createdAt, generatedAt),
      attempt: Math.max(record.turnCount, record.checkpoint?.turn ?? 0),
      summary: recent?.text ?? textOr(record.title, publicId(record)),
      activity,
      links: [],
    });
  }
  return runs;
}

function blockersFor(
  record: WorkItemRecord,
  blocks: readonly WorkItemBlockRecord[],
  records: readonly WorkItemRecord[],
): string[] {
  const ids: string[] = [];
  for (const block of blocks) {
    if (block.epicId !== record.epicId || block.blockedLinearIssueId !== record.linearIssueId) {
      continue;
    }
    const blocker = records.find(
      (item) => item.epicId === record.epicId && item.linearIssueId === block.blockerLinearIssueId,
    );
    if (blocker === undefined) continue;
    const id = publicId(blocker);
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function questionsFor(
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
    const storedRun = question.runId !== null && runs.some((run) => run.id === question.runId);
    questions.push({
      id: question.id,
      itemId: publicId(record),
      runId: storedRun ? question.runId : linkedRunId(record, runs),
      title: parsed.title || question.body,
      body: parsed.body || question.body,
      context: parsed.context,
      kind: "decision",
      urgency: "blocking",
      options: question.options,
      recommendedOption: null,
      askedAt: iso(question.createdAt),
      claimedBy: null,
      links: [],
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
      links: [],
    });
  }
  return questions;
}

function verdictFor(
  record: WorkItemRecord,
  rows: readonly OutboxRow[],
  jobs: readonly Job[],
  progress: readonly CloseoutProgressRecord[],
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
  return [live ? withProgress(base, live, nowMs, env) : base];
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
  const checks = live.steps.map((step) => toLiveCheck(step, nowMs, env));
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
  };
}

function liveSummary(decision: VerdictDecision | null): string {
  if (decision === "accepted") return "Closeout accepted.";
  if (decision === "rejected") return "Closeout rejected.";
  if (decision === "exhausted") return "Closeout exhausted its retry budget.";
  if (decision === "blocked") return "Closeout stopped and needs a person.";
  return "Closeout is running.";
}

function toLiveCheck(step: CloseoutStepRecord, nowMs: number, env: NodeJS.ProcessEnv): StatusCheck {
  const end = step.finishedAt ?? nowMs;
  return {
    id: step.id,
    kind: step.kind,
    state: step.state,
    command: step.command,
    detail: step.detail,
    attempt: step.attempt,
    timeoutSeconds: step.timeoutSeconds,
    elapsedMs: step.startedAt === null ? null : Math.max(0, end - step.startedAt),
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
    case "exhausted":
      return "exhausted";
    case "merge_queue":
    case "merged":
    case "awaiting_signoff":
      return "accepted";
    default:
      return null;
  }
}

function mergeQueueFor(
  records: readonly WorkItemRecord[],
  jobs: readonly Job[],
  generatedAt: string,
): StatusMergeEntry[] {
  return records
    .filter((record) => record.state === "merge_queue")
    .sort(byPosition)
    .map((record, index) => {
      const job = mergeJob(record.id, jobs);
      return {
        position: index + 1,
        itemId: publicId(record),
        enqueuedAt: enqueuedAt(record.id, jobs, generatedAt),
        steps: mergeSteps(job),
      };
    });
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

function notesFor(group: readonly WorkItemRecord[], rows: readonly OutboxRow[]): StatusNote[] {
  const sessions = new Set(group.flatMap((item) => (item.sessionKey ? [item.sessionKey] : [])));
  const notes: StatusNote[] = [];
  for (const row of rows) {
    if (row.orderingKey === null || !sessions.has(row.orderingKey)) continue;
    const note = toNote(row);
    if (note) notes.push(note);
  }
  return notes;
}

function toNote(row: OutboxRow): StatusNote | null {
  const body = readString(row.payload, "body")?.trim() ?? "";
  if (!body) return null;
  const kind = noteKind(row.op === "elicitation" ? "elicitation" : readString(row.payload, "kind"));
  if (kind === null) return null;
  return { at: iso(row.createdAt), kind, actor: "Paws", text: body };
}

function activityFor(
  record: WorkItemRecord,
  runId: string,
  rows: readonly OutboxRow[],
): StatusActivity[] {
  const activity: StatusActivity[] = [];
  for (const row of rows) {
    if (!concerns(row, record, runId)) continue;
    const body = readString(row.payload, "body")?.trim() ?? "";
    if (!body) continue;
    const kind = activityKind(
      row.op === "elicitation" ? "elicitation" : readString(row.payload, "kind"),
    );
    activity.push({ at: iso(row.createdAt), kind, text: body });
  }
  return activity;
}

function eventsFor(rows: readonly OutboxRow[]): StatusEvent[] {
  const events: StatusEvent[] = [];
  for (const row of rows) {
    if (row.op !== "activity" && row.op !== "elicitation") continue;
    const body = readString(row.payload, "body")?.trim() ?? "";
    if (!body) continue;
    const kind = row.op === "elicitation" ? "elicitation" : (readString(row.payload, "kind") ?? "");
    events.push({ at: iso(row.createdAt), level: eventLevel(kind), text: body });
  }
  return events;
}

function concerns(row: OutboxRow, record: WorkItemRecord, runId: string): boolean {
  if (row.op !== "activity" && row.op !== "elicitation") return false;
  const key = row.idempotencyKey;
  if (key.startsWith(`${runId}:`) || key.startsWith(`${record.id}:`)) return true;
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
    case "awaiting_signoff":
      return "signoff";
    case "merge_queue":
      return "merge_queue";
    case "merged":
      return "merged";
    case "completed":
      return "completed";
    case "exhausted":
      return "exhausted";
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
  if (record.state === "verifying" || record.checkpoint?.phase === "verifying") return "verifying";
  if (record.state === "paused") return "paused";
  if (status === "lost" || record.state === "cancelled" || record.state === "failed")
    return "stopped";
  if (
    status === "ended" ||
    record.state === "completed" ||
    record.state === "merged" ||
    record.state === "exhausted" ||
    record.state === "merge_queue" ||
    record.state === "awaiting_signoff" ||
    record.state === "manual"
  ) {
    return "done";
  }
  return "running";
}

function linkedRunId(record: WorkItemRecord, runs: readonly StatusRun[]): string | null {
  if (record.currentRunId === null) return null;
  return runs.some((run) => run.id === record.currentRunId) ? record.currentRunId : null;
}

function publicId(record: WorkItemRecord): string {
  return textOr(record.linearIdentifier, record.id);
}

function agentName(agent: string): string {
  const known: Record<string, string> = {
    claude: "Claude",
    codex: "Codex",
    cursor: "Cursor",
    gemini: "Gemini",
    paws: "Paws",
  };
  const trimmed = agent.trim();
  if (!trimmed) return "Paws";
  return known[trimmed.toLowerCase()] ?? trimmed;
}

function byPosition(left: WorkItemRecord, right: WorkItemRecord): number {
  return left.position - right.position || publicId(left).localeCompare(publicId(right));
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
  if (!key.startsWith("ask:")) return null;
  const id = key.slice("ask:".length).trim();
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
    if (!match || !id || !kind || !state) continue;
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

function noteKind(kind: string | null): NoteKind | null {
  if (
    kind === "thought" ||
    kind === "action" ||
    kind === "elicitation" ||
    kind === "error" ||
    kind === "response"
  ) {
    return kind;
  }
  return null;
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

function eventLevel(kind: string): EventLevel {
  if (kind === "error") return "err";
  if (kind === "response") return "ok";
  if (kind === "elicitation") return "warn";
  return "info";
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
  } catch {
    return null;
  }
}
