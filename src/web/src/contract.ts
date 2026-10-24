/**
 * Read-only status snapshot served by the local Paws engine.
 *
 * `GET /api/status` returns JSON of this shape. `source` is `"demo"` for the
 * sample stub and `"live"` when the body was read from the engine's own state.
 * The array `questions` lists open questions only.
 */

export const STATUS_API_VERSION = 1 as const;

export const STATUS_API_PATH = "/api/status";
export const STATUS_PAGE_PATH = "/status";

export const ITEM_STATES = [
  "queued",
  "planning",
  "running",
  "awaiting_input",
  "verifying",
  "signoff",
  "merge_queue",
  "merged",
  "completed",
  "exhausted",
  "stopped",
  "needs_human",
] as const;

export const RUN_STATES = [
  "running",
  "awaiting_input",
  "verifying",
  "paused",
  "done",
  "stopped",
] as const;

export const QUESTION_KINDS = ["decision", "exhausted"] as const;
export const URGENCIES = ["blocking", "normal"] as const;
export const VERDICT_DECISIONS = [
  "accepted",
  "rejected",
  "exhausted",
  "running",
  "blocked",
] as const;
export const CHECK_STATES = [
  "passed",
  "failed",
  "running",
  "pending",
  "skipped",
  "blocked",
  "exhausted",
  "stopped",
] as const;
export const CHECK_KINDS = ["setup", "command", "review", "evidence"] as const;
export const STEP_STATES = ["done", "run", "wait"] as const;
export const ACTIVITY_KINDS = [
  "thought",
  "action",
  "tool",
  "elicitation",
  "system",
  "ok",
  "err",
  "prompt",
] as const;
export const EVENT_LEVELS = ["info", "ok", "warn", "err"] as const;
export const SOURCES = ["demo", "live"] as const;

export type ItemState = (typeof ITEM_STATES)[number];
export type RunState = (typeof RUN_STATES)[number];
export type QuestionKind = (typeof QUESTION_KINDS)[number];
export type Urgency = (typeof URGENCIES)[number];
export type VerdictDecision = (typeof VERDICT_DECISIONS)[number];
export type CheckState = (typeof CHECK_STATES)[number];
export type CheckKind = (typeof CHECK_KINDS)[number];
export type StepState = (typeof STEP_STATES)[number];
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
export type EventLevel = (typeof EVENT_LEVELS)[number];
export type StatusSource = (typeof SOURCES)[number];

export interface StatusLink {
  label: string;
  href: string;
}

export interface StatusPullRequest {
  number: number;
  url: string;
}

export interface StatusItem {
  id: string;
  title: string;
  state: ItemState;
  agent: string;
  assignee: string;
  owner: string | null;
  project: { id: string; name: string } | null;
  blockers: string[];
  attempts: number;
  branch: string | null;
  runId: string | null;
  pr: StatusPullRequest | null;
  links: StatusLink[];
  /** A queued item's place among the items waiting for a runner slot. */
  queue?: StatusQueuePosition;
  held?: StatusHeld;
  /** A task's place in its repository's merge queue. 1 merges next. */
  mergeQueue?: StatusMergeQueue;
  /** The item's pull request waits in its repository's GitHub merge queue. */
  githubQueue?: StatusGitHubQueue;
  linearRequests?: number;
  visualReviews?: StatusVisualReview[];
  /** The Linear session this work belongs to. Sub-issues delegated together share one. */
  session?: StatusItemSession;
  /** Set on an earlier attempt that a newer Linear session on the same issue replaced. */
  endedAt?: string;
}

export interface StatusItemSession {
  id: string;
  /** The session in Linear. */
  url: string;
  /** The other issues worked in the same Linear session. */
  shared: string[];
}

export const VISUAL_REVIEW_STATES = ["waiting", "accepted", "changes_requested", "stale"] as const;
export type VisualReviewState = (typeof VISUAL_REVIEW_STATES)[number];

export interface StatusVisualReview {
  questionId: string;
  checkId: string;
  round: number;
  state: VisualReviewState;
  evidenceIds: string[];
  commit: string | null;
  askedAt: string;
  answeredBy: string | null;
  answeredAt: string | null;
  feedback: string | null;
  marks?: { id: string; evidenceId: string }[];
  /** Files that carried an earlier approval over instead of being asked about. */
  carried?: StatusVisualReviewCarry[];
}

/** A screenshot that looks the same as one a person accepted, so it wasn't asked again. */
export interface StatusVisualReviewCarry {
  evidenceId: string;
  /** The file the person accepted. */
  fromEvidenceId: string;
  /** The `questionId` of the accepted review. */
  approvalId: string;
  approvedBy: string;
  approvedAt: string;
  /** `identical` bytes, or `similar` pixels within tolerance. */
  match: "identical" | "similar";
}

export interface StatusMergeQueue {
  /** `owner/repo`. */
  repository: string;
  /** 1 is the pull request that moves. */
  position: number;
  total: number;
  /** The issue in front, or null for the first. */
  ahead: string | null;
}

export interface StatusGitHubQueue {
  /** GitHub's position, 1 is next. Null when GitHub did not report one. */
  position: number | null;
  /** GitHub's `MergeQueueEntryState`, for example `AWAITING_CHECKS`. */
  state: string;
  /** For example "Second in the acme/platform GitHub merge queue, waiting for checks." */
  line: string;
}

export interface StatusQueuePosition {
  /** 1 is next in line. */
  position: number;
  busySlots: number;
  totalSlots: number;
  /** Set while the task waits on its owner's cap of running tasks. */
  ownerCap?: number;
}

export const HELD_REASONS = [
  "blocked",
  "project",
  "reconciling",
  "snapshot",
  "cap",
  "slot",
  "workspace",
] as const;
export type HeldReason = (typeof HELD_REASONS)[number];

export interface StatusHeld {
  reason: HeldReason;
  blockers: string[];
}

export interface StatusActivity {
  at: string;
  kind: ActivityKind;
  text: string;
}

export interface StatusRun {
  runner?: string | null;
  id: string;
  attempts?: string[];
  itemId: string;
  state: RunState;
  agent: string;
  reviewer: string;
  startedAt: string;
  attempt: number;
  summary: string;
  activity: StatusActivity[];
  links: StatusLink[];
  /** Present while the run waits for its agent's usage limit to reset. */
  usagePause?: StatusUsagePause;
  setup?: StatusRunSetup;
}

export interface StatusRunSetup {
  skills: { name: string; version: string; installing: boolean }[];
  hooks: { name: string; event: string }[];
}

export interface StatusUsagePause {
  agent: string;
  resumeAt: string;
}

export interface StatusQuestion {
  id: string;
  itemId: string;
  runId: string | null;
  title: string;
  body: string;
  context: string;
  kind: QuestionKind;
  urgency: Urgency;
  options: string[];
  recommendedOption: number | null;
  askedAt: string;
  claimedBy: string | null;
  links: StatusLink[];
}

export interface StatusCheck {
  id: string;
  kind: CheckKind;
  state: CheckState;
  command: string;
  detail: string | null;
  attempt?: number | null;
  timeoutSeconds?: number | null;
  elapsedMs?: number | null;
  exitCode?: number | null;
  timedOut?: boolean;
  timeoutReason?: string | null;
  stdout?: string | null;
  stderr?: string | null;
  truncated?: boolean;
  findings?: string | null;
  logPath?: string | null;
  evidencePath?: string | null;
  active?: boolean;
  tokens?: number | null;
}

export interface StatusVerdict {
  itemId: string;
  /** The `StatusRun.id` of the attempt this verdict belongs to, when the issue had several. */
  runId?: string;
  decision: VerdictDecision;
  attempt: number;
  maxAttempts: number;
  summary: string;
  failingCheck: string | null;
  baseSha: string | null;
  headSha: string | null;
  sealed: boolean;
  checks: StatusCheck[];
  links: StatusLink[];
  policyDigest?: string | null;
  policyPath?: string | null;
  attempts?: StatusCloseoutAttempt[];
}

/** One Closeout run of a candidate (head and policy), oldest first in `StatusVerdict.attempts`. */
export interface StatusCloseoutAttempt {
  number: number;
  /** Retry-budget round, 1-based. A rebased head re-checked before the merge starts the next one. */
  round?: number;
  decision: VerdictDecision;
  startedAt: string;
  baseSha: string | null;
  headSha: string | null;
  policyDigest: string | null;
  checks: StatusCheck[];
}

export interface StatusAgentCloseout {
  itemId: string;
  runId: string;
  maxAttempts: number | null;
  blocked: string | null;
  updatedAt: string;
  attempts: StatusCloseoutAttempt[];
  steps: StatusAgentCloseoutStep[];
  endedAt?: string;
  continuesIn?: string;
}

export const AGENT_CLOSEOUT_TOOLS = ["get_closeout", "run_closeout"] as const;
export const AGENT_CLOSEOUT_STEP_STATES = [
  "reported",
  "running",
  "passed",
  "failed",
  "exhausted",
  "cancelled",
] as const;
export type AgentCloseoutTool = (typeof AGENT_CLOSEOUT_TOOLS)[number];
export type AgentCloseoutStepState = (typeof AGENT_CLOSEOUT_STEP_STATES)[number];

export interface StatusAgentCloseoutStep {
  at: string;
  tool: AgentCloseoutTool;
  checkId: string | null;
  state: AgentCloseoutStepState;
  attempt: number | null;
  headSha: string | null;
}

export const CI_CHECK_STATES = ["passed", "failed", "running", "skipped"] as const;
export const CI_LOG_SOURCES = ["actions", "summary"] as const;
/** What Paws did after a failed CI read: sent it back to the agent, asked in Linear, or stopped. */
export const CI_ROUND_NEXT = ["agent", "asked", "failed"] as const;
export type CiCheckState = (typeof CI_CHECK_STATES)[number];
export type CiLogSource = (typeof CI_LOG_SOURCES)[number];
export type CiRoundNext = (typeof CI_ROUND_NEXT)[number];

/** One check on the pull request's head commit. */
export interface StatusCiCheck {
  name: string;
  state: CiCheckState;
  url: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /** The end of a failing check's log: the GitHub Actions job log, otherwise its summary text. */
  logTail: string | null;
  logSource: CiLogSource | null;
}

/** One failed CI read of a head, oldest first in `StatusSnapshot.ciRounds`. */
export interface StatusCiRound {
  itemId: string;
  /** The stored run (an attempt in `StatusRun.attempts`) that was current when CI failed. */
  runId: string | null;
  /** 1-based, per item. */
  round: number;
  head: string;
  next: CiRoundNext;
  /** The fix number when `next` is `agent`, for example 1 in "fix 1 of 3". */
  fix: number | null;
  fixLimit: number;
  recordedAt: string;
  checks: StatusCiCheck[];
}

export interface StatusMergeStep {
  name: string;
  state: StepState;
  detail: string | null;
}

/** What a task in the merge queue waits for. */
export const MERGE_WAIT_REASONS = ["ahead", "ci", "review", "branch_update", "closeout"] as const;
export type MergeWaitReason = (typeof MERGE_WAIT_REASONS)[number];
/** Settings → Merging. `queue` merges one at a time per repository. */
export const MERGE_ORDERS = ["queue", "ci-green", "github-queue"] as const;
export type MergeOrderSetting = (typeof MERGE_ORDERS)[number];
export const MAIN_MOVED_CHOICES = ["overlap", "ci", "closeout"] as const;
export type MainMovedSetting = (typeof MAIN_MOVED_CHOICES)[number];

/** The merge settings a task resolved, and the issue rule's label when a rule chose them. */
export interface StatusMergeSettings {
  order: MergeOrderSetting;
  mainMoved: MainMovedSetting;
  rule: string | null;
}

export interface StatusMergeEntry {
  /** Place in its repository's queue, 1 moves. Null when the task holds no place. */
  position: number | null;
  itemId: string;
  /** `owner/repo`. */
  repository: string;
  enqueuedAt: string;
  /** When Closeout accepted the current change. */
  acceptedAt: string;
  waitingFor: MergeWaitReason;
  detail: string | null;
  settings: StatusMergeSettings;
  steps: StatusMergeStep[];
}

/** A pull request that merged, or a task that left the queue for the agent, in the last 24 hours. */
export interface StatusMergeOutcome {
  itemId: string;
  repository: string;
  outcome: "merged" | "back_with_agent";
  /** For `back_with_agent`: CI failed or the branch update conflicted. */
  reason: "ci_failed" | "conflict" | null;
  at: string;
  settings: StatusMergeSettings;
}

export interface StatusEvent {
  at: string;
  level: EventLevel;
  text: string;
}

export interface StatusProject {
  name: string;
  team: string;
  repo: string;
  workspace: string | null;
}

export interface StatusSnapshot {
  version: typeof STATUS_API_VERSION;
  source: StatusSource;
  generatedAt: string;
  project: StatusProject;
  items: StatusItem[];
  runs: StatusRun[];
  questions: StatusQuestion[];
  verdicts: StatusVerdict[];
  mergeQueue: StatusMergeEntry[];
  /** Merged in the last 24 hours, and tasks back with the agent after CI or a conflict. */
  mergeHistory?: StatusMergeOutcome[];
  events: StatusEvent[];
  /** Closeout videos and screenshots of the visible items, oldest first. */
  evidence?: StatusEvidence[];
  agentCloseout?: StatusAgentCloseout[];
  /** Failed CI reads of the visible items' pull requests, with every check on each head. */
  ciRounds?: StatusCiRound[];
  intake?: StatusIntakeEntry[];
  linearBudget?: StatusLinearBudget;
  linearWebhook?: StatusLinearWebhook;
}

export interface StatusIntakeEntry {
  issue: string;
  title: string | null;
  receivedAt: string;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
}

export interface StatusLinearWebhook {
  warning: string;
  fix: string;
  lastVerifiedAt: string;
}

export interface StatusLinearBudget {
  requestsRemaining: number | null;
  requestsLimit: number | null;
  resetAt: string | null;
  holdUntil: string | null;
}

export const EVIDENCE_KINDS = ["video", "image"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** One stored Closeout video or screenshot. The file is `GET /api/evidence/<id>`. */
export interface StatusEvidence {
  id: string;
  itemId: string;
  runId: string;
  checkId: string;
  attempt: number;
  kind: EvidenceKind;
  mediaType: string;
  displayName: string;
  sizeBytes: number;
  headCommit: string;
  publishedAt: string;
  publisher: string;
}

export type ParseResult = { ok: true; snapshot: StatusSnapshot } | { ok: false; error: string };

export class StatusContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StatusContractError";
  }
}

export function parseStatusSnapshot(input: unknown): ParseResult {
  try {
    return { ok: true, snapshot: readSnapshot(input) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid status snapshot";
    return { ok: false, error: message };
  }
}

export function statusIntegrity(snapshot: StatusSnapshot): string[] {
  const problems: string[] = [];
  // An earlier attempt (a replaced Linear session) shares its issue's id with the current one.
  const items = ids(
    snapshot.items.filter((item) => item.endedAt === undefined).map((item) => item.id),
    "item",
    problems,
  );
  for (const item of snapshot.items) if (item.endedAt !== undefined) items.add(item.id);
  const runs = ids(
    snapshot.runs.map((run) => run.id),
    "run",
    problems,
  );
  ids(
    snapshot.questions.map((question) => question.id),
    "question",
    problems,
  );

  for (const item of snapshot.items) {
    for (const blocker of item.blockers) {
      if (!items.has(blocker)) problems.push(`${item.id} blocker ${blocker} is missing`);
    }
    if (item.runId !== null && !runs.has(item.runId)) {
      problems.push(`${item.id} run ${item.runId} is missing`);
    }
  }
  for (const run of snapshot.runs) {
    if (!items.has(run.itemId)) problems.push(`${run.id} item ${run.itemId} is missing`);
  }
  for (const question of snapshot.questions) {
    if (!items.has(question.itemId)) {
      problems.push(`${question.id} item ${question.itemId} is missing`);
    }
    if (question.runId !== null && !runs.has(question.runId)) {
      problems.push(`${question.id} run ${question.runId} is missing`);
    }
  }
  const seenVerdicts = new Set<string>();
  for (const verdict of snapshot.verdicts) {
    if (!items.has(verdict.itemId)) problems.push(`verdict item ${verdict.itemId} is missing`);
    if (seenVerdicts.has(verdict.itemId)) problems.push(`duplicate verdict for ${verdict.itemId}`);
    seenVerdicts.add(verdict.itemId);
  }
  const positions = new Set<string>();
  for (const entry of snapshot.mergeQueue) {
    if (!items.has(entry.itemId)) problems.push(`queue item ${entry.itemId} is missing`);
    if (entry.position === null) continue;
    const place = `${entry.repository}#${entry.position}`;
    if (positions.has(place))
      problems.push(`duplicate queue position ${entry.position} in ${entry.repository}`);
    positions.add(place);
  }
  for (const entry of snapshot.mergeHistory ?? [])
    if (!items.has(entry.itemId)) problems.push(`merge history item ${entry.itemId} is missing`);
  return problems;
}

function ids(values: string[], label: string, problems: string[]): Set<string> {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) problems.push(`duplicate ${label} ${value}`);
    seen.add(value);
  }
  return seen;
}

function readSnapshot(input: unknown): StatusSnapshot {
  const body = object(input, "status");
  const version = body.version;
  if (version !== STATUS_API_VERSION) {
    throw new StatusContractError(`status.version must be ${STATUS_API_VERSION}`);
  }
  const project = readProject(body.project);
  return {
    version: STATUS_API_VERSION,
    source: oneOf(string(body, "source", "status"), SOURCES, "status.source"),
    generatedAt: dateString(body, "generatedAt", "status"),
    project,
    items: array(body, "items", "status").map((entry, index) => readItem(entry, index)),
    runs: array(body, "runs", "status").map((entry, index) => readRun(entry, index)),
    questions: array(body, "questions", "status").map((entry, index) => readQuestion(entry, index)),
    verdicts: array(body, "verdicts", "status").map((entry, index) => readVerdict(entry, index)),
    mergeQueue: array(body, "mergeQueue", "status").map((entry, index) =>
      readMerge(entry, index, project.repo),
    ),
    ...(body.mergeHistory === undefined
      ? {}
      : {
          mergeHistory: array(body, "mergeHistory", "status").map((entry, index) =>
            readMergeOutcome(entry, `mergeHistory[${index}]`, project.repo),
          ),
        }),
    events: array(body, "events", "status").map((entry, index) => readEvent(entry, index)),
    ...(body.evidence === undefined
      ? {}
      : {
          evidence: array(body, "evidence", "status").map((entry, index) =>
            readEvidence(entry, `evidence[${index}]`),
          ),
        }),
    ...(body.agentCloseout === undefined
      ? {}
      : {
          agentCloseout: array(body, "agentCloseout", "status").map((entry, index) =>
            readAgentCloseout(entry, `agentCloseout[${index}]`),
          ),
        }),
    ...(body.ciRounds === undefined
      ? {}
      : {
          ciRounds: array(body, "ciRounds", "status").map((entry, index) =>
            readCiRound(entry, `ciRounds[${index}]`),
          ),
        }),
    ...(body.intake === undefined
      ? {}
      : {
          intake: array(body, "intake", "status").map((entry, index) =>
            readIntake(entry, `intake[${index}]`),
          ),
        }),
    ...(body.linearBudget === undefined || body.linearBudget === null
      ? {}
      : { linearBudget: readLinearBudget(body.linearBudget, "linearBudget") }),
    ...(body.linearWebhook === undefined || body.linearWebhook === null
      ? {}
      : { linearWebhook: readLinearWebhook(body.linearWebhook, "linearWebhook") }),
  };
}

function readLinearWebhook(input: unknown, path: string): StatusLinearWebhook {
  const body = object(input, path);
  return {
    warning: text(body, "warning", path),
    fix: text(body, "fix", path),
    lastVerifiedAt: dateString(body, "lastVerifiedAt", path),
  };
}

function readIntake(input: unknown, path: string): StatusIntakeEntry {
  const body = object(input, path);
  return {
    issue: text(body, "issue", path),
    title: nullableText(body, "title", path),
    receivedAt: dateString(body, "receivedAt", path),
    attempts: count(body, "attempts", path),
    nextAttemptAt: nullableDate(body, "nextAttemptAt", path),
    lastError: nullableText(body, "lastError", path),
  };
}

function readLinearBudget(input: unknown, path: string): StatusLinearBudget {
  const body = object(input, path);
  return {
    requestsRemaining: optionalCount(body, "requestsRemaining", path),
    requestsLimit: optionalCount(body, "requestsLimit", path),
    resetAt: nullableDate(body, "resetAt", path),
    holdUntil: nullableDate(body, "holdUntil", path),
  };
}

function readCiRound(input: unknown, path: string): StatusCiRound {
  const body = object(input, path);
  return {
    itemId: text(body, "itemId", path),
    runId: optionalText(body, "runId"),
    round: positiveInteger(body, "round", path),
    head: text(body, "head", path),
    next: oneOf(string(body, "next", path), CI_ROUND_NEXT, `${path}.next`),
    fix: body.fix === null || body.fix === undefined ? null : positiveInteger(body, "fix", path),
    fixLimit: count(body, "fixLimit", path),
    recordedAt: dateString(body, "recordedAt", path),
    checks: array(body, "checks", path).map((entry, index) => {
      const at = `${path}.checks[${index}]`;
      const check = object(entry, at);
      const source = optionalText(check, "logSource");
      return {
        name: text(check, "name", at),
        state: oneOf(string(check, "state", at), CI_CHECK_STATES, `${at}.state`),
        url: optionalText(check, "url"),
        startedAt: optionalText(check, "startedAt"),
        completedAt: optionalText(check, "completedAt"),
        logTail: optionalText(check, "logTail"),
        logSource: source === null ? null : oneOf(source, CI_LOG_SOURCES, `${at}.logSource`),
      };
    }),
  };
}

function readAgentCloseout(input: unknown, path: string): StatusAgentCloseout {
  const body = object(input, path);
  return {
    itemId: text(body, "itemId", path),
    runId: text(body, "runId", path),
    maxAttempts: optionalCount(body, "maxAttempts", path),
    blocked: optionalText(body, "blocked"),
    updatedAt: dateString(body, "updatedAt", path),
    attempts: array(body, "attempts", path).map((entry, attempt) =>
      readAttempt(entry, `${path}.attempts[${attempt}]`),
    ),
    steps: array(body, "steps", path).map((entry, step) => {
      const at = `${path}.steps[${step}]`;
      const row = object(entry, at);
      return {
        at: dateString(row, "at", at),
        tool: oneOf(string(row, "tool", at), AGENT_CLOSEOUT_TOOLS, `${at}.tool`),
        checkId: optionalText(row, "checkId"),
        state: oneOf(string(row, "state", at), AGENT_CLOSEOUT_STEP_STATES, `${at}.state`),
        attempt: optionalCount(row, "attempt", at),
        headSha: optionalText(row, "headSha"),
      };
    }),
    ...(body.endedAt === undefined ? {} : { endedAt: dateString(body, "endedAt", path) }),
    ...(body.continuesIn === undefined ? {} : { continuesIn: text(body, "continuesIn", path) }),
  };
}

function readEvidence(input: unknown, path: string): StatusEvidence {
  const body = object(input, path);
  return {
    id: text(body, "id", path),
    itemId: text(body, "itemId", path),
    runId: text(body, "runId", path),
    checkId: text(body, "checkId", path),
    attempt: positiveInteger(body, "attempt", path),
    kind: oneOf(string(body, "kind", path), EVIDENCE_KINDS, `${path}.kind`),
    mediaType: text(body, "mediaType", path),
    displayName: text(body, "displayName", path),
    sizeBytes: positiveInteger(body, "sizeBytes", path),
    headCommit: text(body, "headCommit", path),
    publishedAt: dateString(body, "publishedAt", path),
    publisher: text(body, "publisher", path),
  };
}

function positiveInteger(body: Record<string, unknown>, key: string, path: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new StatusContractError(`${path}.${key} must be an integer >= 1`);
  }
  return value;
}

function readProject(input: unknown): StatusProject {
  const body = object(input, "project");
  const workspace = body.workspace;
  if (workspace !== null && typeof workspace !== "string") {
    throw new StatusContractError("project.workspace must be a string or null");
  }
  return {
    name: text(body, "name", "project"),
    team: text(body, "team", "project"),
    repo: text(body, "repo", "project"),
    workspace,
  };
}

function readItem(input: unknown, index: number): StatusItem {
  const path = `items[${index}]`;
  const body = object(input, path);
  const branch = body.branch;
  const runId = body.runId;
  if (branch !== null && typeof branch !== "string") {
    throw new StatusContractError(`${path}.branch must be a string or null`);
  }
  if (runId !== null && typeof runId !== "string") {
    throw new StatusContractError(`${path}.runId must be a string or null`);
  }
  return {
    id: text(body, "id", path),
    title: text(body, "title", path),
    state: oneOf(string(body, "state", path), ITEM_STATES, `${path}.state`),
    agent: text(body, "agent", path),
    assignee: text(body, "assignee", path),
    owner: nullableText(body, "owner", path),
    project: readItemProject(body.project, `${path}.project`),
    blockers: stringArray(body, "blockers", path),
    attempts: count(body, "attempts", path),
    branch,
    runId,
    pr: readPr(body.pr, `${path}.pr`),
    links: readLinks(body.links, `${path}.links`),
    ...(body.queue === undefined ? {} : { queue: readQueue(body.queue, `${path}.queue`) }),
    ...(body.held === undefined ? {} : { held: readHeld(body.held, `${path}.held`) }),
    ...(body.mergeQueue === undefined
      ? {}
      : { mergeQueue: readMergeQueue(body.mergeQueue, `${path}.mergeQueue`) }),
    ...(body.githubQueue === undefined
      ? {}
      : { githubQueue: readGitHubQueue(body.githubQueue, `${path}.githubQueue`) }),
    ...(body.linearRequests === undefined
      ? {}
      : { linearRequests: count(body, "linearRequests", path) }),
    ...(body.visualReviews === undefined
      ? {}
      : {
          visualReviews: array(body, "visualReviews", path).map((entry, at) =>
            readVisualReview(entry, `${path}.visualReviews[${at}]`),
          ),
        }),
    ...(body.session === undefined
      ? {}
      : { session: readItemSession(body.session, `${path}.session`) }),
    ...(body.endedAt === undefined ? {} : { endedAt: dateString(body, "endedAt", path) }),
  };
}

function readItemSession(input: unknown, path: string): StatusItemSession {
  const body = object(input, path);
  return {
    id: text(body, "id", path),
    url: text(body, "url", path),
    shared: stringArray(body, "shared", path),
  };
}

function readVisualReview(input: unknown, path: string): StatusVisualReview {
  const body = object(input, path);
  return {
    questionId: text(body, "questionId", path),
    checkId: text(body, "checkId", path),
    round: positiveInteger(body, "round", path),
    state: oneOf(string(body, "state", path), VISUAL_REVIEW_STATES, `${path}.state`),
    evidenceIds: stringArray(body, "evidenceIds", path),
    commit: nullableText(body, "commit", path),
    askedAt: dateString(body, "askedAt", path),
    answeredBy: nullableText(body, "answeredBy", path),
    answeredAt: nullableDate(body, "answeredAt", path),
    feedback: nullableText(body, "feedback", path),
    ...(body.marks === undefined
      ? {}
      : {
          marks: array(body, "marks", path).map((entry, at) => {
            const mark = object(entry, `${path}.marks[${at}]`);
            return {
              id: text(mark, "id", `${path}.marks[${at}]`),
              evidenceId: text(mark, "evidenceId", `${path}.marks[${at}]`),
            };
          }),
        }),
    ...(body.carried === undefined
      ? {}
      : {
          carried: array(body, "carried", path).map((entry, at) => {
            const where = `${path}.carried[${at}]`;
            const carry = object(entry, where);
            return {
              evidenceId: text(carry, "evidenceId", where),
              fromEvidenceId: text(carry, "fromEvidenceId", where),
              approvalId: text(carry, "approvalId", where),
              approvedBy: text(carry, "approvedBy", where),
              approvedAt: dateString(carry, "approvedAt", where),
              match: oneOf(string(carry, "match", where), CARRY_MATCHES, `${where}.match`),
            };
          }),
        }),
  };
}

const CARRY_MATCHES = ["identical", "similar"] as const;

function readMergeQueue(input: unknown, path: string): StatusMergeQueue {
  const body = object(input, path);
  return {
    repository: text(body, "repository", path),
    position: positiveInteger(body, "position", path),
    total: positiveInteger(body, "total", path),
    ahead: nullableText(body, "ahead", path),
  };
}

function readGitHubQueue(input: unknown, path: string): StatusGitHubQueue {
  const body = object(input, path);
  return {
    position: body.position === null ? null : positiveInteger(body, "position", path),
    state: text(body, "state", path),
    line: text(body, "line", path),
  };
}

function readQueue(input: unknown, path: string): StatusQueuePosition {
  const body = object(input, path);
  return {
    position: positiveInteger(body, "position", path),
    busySlots: count(body, "busySlots", path),
    totalSlots: positiveInteger(body, "totalSlots", path),
    ...(body.ownerCap === undefined ? {} : { ownerCap: positiveInteger(body, "ownerCap", path) }),
  };
}

function readHeld(input: unknown, path: string): StatusHeld {
  const body = object(input, path);
  return {
    reason: oneOf(string(body, "reason", path), HELD_REASONS, `${path}.reason`),
    blockers: stringArray(body, "blockers", path),
  };
}

function readRun(input: unknown, index: number): StatusRun {
  const path = `runs[${index}]`;
  const body = object(input, path);
  return {
    id: text(body, "id", path),
    ...(body.attempts === undefined ? {} : { attempts: stringArray(body, "attempts", path) }),
    runner: optionalText(body, "runner"),
    itemId: text(body, "itemId", path),
    state: oneOf(string(body, "state", path), RUN_STATES, `${path}.state`),
    agent: text(body, "agent", path),
    reviewer: text(body, "reviewer", path),
    startedAt: dateString(body, "startedAt", path),
    attempt: count(body, "attempt", path),
    summary: string(body, "summary", path),
    activity: array(body, "activity", path).map((entry, step) =>
      readActivity(entry, `${path}.activity[${step}]`),
    ),
    links: readLinks(body.links, `${path}.links`),
    ...(body.usagePause === undefined || body.usagePause === null
      ? {}
      : { usagePause: readUsagePause(body.usagePause, `${path}.usagePause`) }),
    ...(body.setup === undefined || body.setup === null
      ? {}
      : { setup: readRunSetup(body.setup, `${path}.setup`) }),
  };
}

function readRunSetup(input: unknown, path: string): StatusRunSetup {
  const body = object(input, path);
  return {
    skills: array(body, "skills", path).map((entry, index) => {
      const skill = object(entry, `${path}.skills[${index}]`);
      return {
        name: text(skill, "name", `${path}.skills[${index}]`),
        version: text(skill, "version", `${path}.skills[${index}]`),
        installing: optionalBoolean(skill, "installing"),
      };
    }),
    hooks: array(body, "hooks", path).map((entry, index) => {
      const hook = object(entry, `${path}.hooks[${index}]`);
      return {
        name: text(hook, "name", `${path}.hooks[${index}]`),
        event: text(hook, "event", `${path}.hooks[${index}]`),
      };
    }),
  };
}

function readUsagePause(input: unknown, path: string): StatusUsagePause {
  const body = object(input, path);
  return { agent: text(body, "agent", path), resumeAt: dateString(body, "resumeAt", path) };
}

function readQuestion(input: unknown, index: number): StatusQuestion {
  const path = `questions[${index}]`;
  const body = object(input, path);
  const runId = body.runId;
  const claimedBy = body.claimedBy;
  if (runId !== null && typeof runId !== "string") {
    throw new StatusContractError(`${path}.runId must be a string or null`);
  }
  if (claimedBy !== null && typeof claimedBy !== "string") {
    throw new StatusContractError(`${path}.claimedBy must be a string or null`);
  }
  const options = stringArray(body, "options", path);
  const recommended = body.recommendedOption;
  if (recommended !== null && (typeof recommended !== "number" || !Number.isInteger(recommended))) {
    throw new StatusContractError(`${path}.recommendedOption must be an integer or null`);
  }
  if (recommended !== null && (recommended < 0 || recommended >= options.length)) {
    throw new StatusContractError(`${path}.recommendedOption is outside options`);
  }
  return {
    id: text(body, "id", path),
    itemId: text(body, "itemId", path),
    runId,
    title: text(body, "title", path),
    body: string(body, "body", path),
    context: string(body, "context", path),
    kind: oneOf(string(body, "kind", path), QUESTION_KINDS, `${path}.kind`),
    urgency: oneOf(string(body, "urgency", path), URGENCIES, `${path}.urgency`),
    options,
    recommendedOption: recommended,
    askedAt: dateString(body, "askedAt", path),
    claimedBy,
    links: readLinks(body.links, `${path}.links`),
  };
}

function readVerdict(input: unknown, index: number): StatusVerdict {
  const path = `verdicts[${index}]`;
  const body = object(input, path);
  const failing = body.failingCheck;
  const baseSha = body.baseSha;
  const headSha = body.headSha;
  if (failing !== null && typeof failing !== "string") {
    throw new StatusContractError(`${path}.failingCheck must be a string or null`);
  }
  if (baseSha !== null && typeof baseSha !== "string") {
    throw new StatusContractError(`${path}.baseSha must be a string or null`);
  }
  if (headSha !== null && typeof headSha !== "string") {
    throw new StatusContractError(`${path}.headSha must be a string or null`);
  }
  const maxAttempts = body.maxAttempts;
  if (typeof maxAttempts !== "number" || !Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new StatusContractError(`${path}.maxAttempts must be an integer >= 1`);
  }
  return {
    itemId: text(body, "itemId", path),
    ...(body.runId === undefined ? {} : { runId: text(body, "runId", path) }),
    decision: oneOf(string(body, "decision", path), VERDICT_DECISIONS, `${path}.decision`),
    attempt: count(body, "attempt", path),
    maxAttempts,
    summary: string(body, "summary", path),
    failingCheck: failing,
    baseSha,
    headSha,
    sealed: boolean(body, "sealed", path),
    checks: array(body, "checks", path).map((entry, check) =>
      readCheck(entry, `${path}.checks[${check}]`),
    ),
    links: readLinks(body.links, `${path}.links`),
    policyDigest: optionalText(body, "policyDigest"),
    policyPath: optionalText(body, "policyPath"),
    ...(body.attempts === undefined
      ? {}
      : {
          attempts: array(body, "attempts", path).map((entry, attempt) =>
            readAttempt(entry, `${path}.attempts[${attempt}]`),
          ),
        }),
  };
}

function readAttempt(input: unknown, path: string): StatusCloseoutAttempt {
  const body = object(input, path);
  const number = body.number;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1) {
    throw new StatusContractError(`${path}.number must be an integer >= 1`);
  }
  return {
    number,
    ...(body.round === undefined ? {} : { round: positiveInteger(body, "round", path) }),
    decision: oneOf(string(body, "decision", path), VERDICT_DECISIONS, `${path}.decision`),
    startedAt: dateString(body, "startedAt", path),
    baseSha: optionalText(body, "baseSha"),
    headSha: optionalText(body, "headSha"),
    policyDigest: optionalText(body, "policyDigest"),
    checks: array(body, "checks", path).map((entry, check) =>
      readCheck(entry, `${path}.checks[${check}]`),
    ),
  };
}

function readCheck(input: unknown, path: string): StatusCheck {
  const body = object(input, path);
  const detail = body.detail;
  if (detail !== null && typeof detail !== "string") {
    throw new StatusContractError(`${path}.detail must be a string or null`);
  }
  return {
    id: text(body, "id", path),
    kind: oneOf(string(body, "kind", path), CHECK_KINDS, `${path}.kind`),
    state: oneOf(string(body, "state", path), CHECK_STATES, `${path}.state`),
    command: string(body, "command", path),
    detail,
    attempt: optionalCount(body, "attempt", path),
    timeoutSeconds: optionalCount(body, "timeoutSeconds", path),
    elapsedMs: optionalCount(body, "elapsedMs", path),
    exitCode: optionalCount(body, "exitCode", path),
    timedOut: optionalBoolean(body, "timedOut"),
    timeoutReason: optionalText(body, "timeoutReason"),
    stdout: optionalText(body, "stdout"),
    stderr: optionalText(body, "stderr"),
    truncated: optionalBoolean(body, "truncated"),
    findings: optionalText(body, "findings"),
    logPath: optionalText(body, "logPath"),
    evidencePath: optionalText(body, "evidencePath"),
    active: optionalBoolean(body, "active"),
    tokens: optionalCount(body, "tokens", path),
  };
}

/** An engine older than the Merge queue page sends no repository, reason or settings. */
function readMerge(input: unknown, index: number, repo: string): StatusMergeEntry {
  const path = `mergeQueue[${index}]`;
  const body = object(input, path);
  const position = body.position;
  if (
    position !== null &&
    (typeof position !== "number" || !Number.isInteger(position) || position < 1)
  ) {
    throw new StatusContractError(`${path}.position must be an integer >= 1 or null`);
  }
  const enqueuedAt = dateString(body, "enqueuedAt", path);
  return {
    position,
    itemId: text(body, "itemId", path),
    repository: body.repository === undefined ? repo : text(body, "repository", path),
    enqueuedAt,
    acceptedAt: body.acceptedAt === undefined ? enqueuedAt : dateString(body, "acceptedAt", path),
    waitingFor:
      body.waitingFor === undefined
        ? position !== null && position > 1
          ? "ahead"
          : "ci"
        : oneOf(string(body, "waitingFor", path), MERGE_WAIT_REASONS, `${path}.waitingFor`),
    detail: body.detail === undefined ? null : nullableText(body, "detail", path),
    settings: readMergeSettings(body.settings, `${path}.settings`),
    steps: array(body, "steps", path).map((entry, step) =>
      readStep(entry, `${path}.steps[${step}]`),
    ),
  };
}

function readMergeSettings(input: unknown, path: string): StatusMergeSettings {
  if (input === undefined) return { order: "queue", mainMoved: "ci", rule: null };
  const body = object(input, path);
  return {
    order: oneOf(string(body, "order", path), MERGE_ORDERS, `${path}.order`),
    mainMoved: oneOf(string(body, "mainMoved", path), MAIN_MOVED_CHOICES, `${path}.mainMoved`),
    rule: body.rule === undefined ? null : nullableText(body, "rule", path),
  };
}

function readMergeOutcome(input: unknown, path: string, repo: string): StatusMergeOutcome {
  const body = object(input, path);
  const reason = body.reason;
  if (reason !== undefined && reason !== null && reason !== "ci_failed" && reason !== "conflict")
    throw new StatusContractError(`${path}.reason must be ci_failed, conflict or null`);
  return {
    itemId: text(body, "itemId", path),
    repository: body.repository === undefined ? repo : text(body, "repository", path),
    outcome: oneOf(
      string(body, "outcome", path),
      ["merged", "back_with_agent"] as const,
      `${path}.outcome`,
    ),
    reason: reason ?? null,
    at: dateString(body, "at", path),
    settings: readMergeSettings(body.settings, `${path}.settings`),
  };
}

function readStep(input: unknown, path: string): StatusMergeStep {
  const body = object(input, path);
  const detail = body.detail;
  if (detail !== null && typeof detail !== "string") {
    throw new StatusContractError(`${path}.detail must be a string or null`);
  }
  return {
    name: text(body, "name", path),
    state: oneOf(string(body, "state", path), STEP_STATES, `${path}.state`),
    detail,
  };
}

function readEvent(input: unknown, index: number): StatusEvent {
  const path = `events[${index}]`;
  const body = object(input, path);
  return {
    at: dateString(body, "at", path),
    level: oneOf(string(body, "level", path), EVENT_LEVELS, `${path}.level`),
    text: text(body, "text", path),
  };
}

function readItemProject(input: unknown, path: string): { id: string; name: string } | null {
  if (input === null) return null;
  const body = object(input, path);
  return { id: text(body, "id", path), name: text(body, "name", path) };
}

function readActivity(input: unknown, path: string): StatusActivity {
  const body = object(input, path);
  return {
    at: dateString(body, "at", path),
    kind: oneOf(string(body, "kind", path), ACTIVITY_KINDS, `${path}.kind`),
    text: text(body, "text", path),
  };
}

function readPr(input: unknown, path: string): StatusPullRequest | null {
  if (input === null) return null;
  const body = object(input, path);
  const number = body.number;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1) {
    throw new StatusContractError(`${path}.number must be an integer >= 1`);
  }
  return { number, url: text(body, "url", path) };
}

function readLinks(input: unknown, path: string): StatusLink[] {
  if (!Array.isArray(input)) throw new StatusContractError(`${path} must be an array`);
  return input.map((entry, index) => {
    const body = object(entry, `${path}[${index}]`);
    return {
      label: text(body, "label", `${path}[${index}]`),
      href: text(body, "href", `${path}[${index}]`),
    };
  });
}

function object(input: unknown, path: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new StatusContractError(`${path} must be an object`);
  }
  return input as Record<string, unknown>;
}

function array(body: Record<string, unknown>, key: string, path: string): unknown[] {
  const value = body[key];
  if (!Array.isArray(value)) throw new StatusContractError(`${path}.${key} must be an array`);
  return value;
}

function string(body: Record<string, unknown>, key: string, path: string): string {
  const value = body[key];
  if (typeof value !== "string") throw new StatusContractError(`${path}.${key} must be a string`);
  return value;
}

function text(body: Record<string, unknown>, key: string, path: string): string {
  const value = string(body, key, path).trim();
  if (!value) throw new StatusContractError(`${path}.${key} must not be empty`);
  return value;
}

function nullableText(body: Record<string, unknown>, key: string, path: string): string | null {
  const value = body[key];
  if (value === null) return null;
  if (typeof value !== "string" || !value.trim()) {
    throw new StatusContractError(`${path}.${key} must be a string or null`);
  }
  return value.trim();
}

function stringArray(body: Record<string, unknown>, key: string, path: string): string[] {
  return array(body, key, path).map((entry, index) => {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new StatusContractError(`${path}.${key}[${index}] must be a non-empty string`);
    }
    return entry;
  });
}

function boolean(body: Record<string, unknown>, key: string, path: string): boolean {
  const value = body[key];
  if (typeof value !== "boolean") throw new StatusContractError(`${path}.${key} must be a boolean`);
  return value;
}

function optionalText(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return null;
  return value;
}

function optionalBoolean(body: Record<string, unknown>, key: string): boolean {
  return body[key] === true;
}

function optionalCount(body: Record<string, unknown>, key: string, path: string): number | null {
  const value = body[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new StatusContractError(`${path}.${key} must be an integer >= 0`);
  }
  return value;
}

function count(body: Record<string, unknown>, key: string, path: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new StatusContractError(`${path}.${key} must be an integer >= 0`);
  }
  return value;
}

function dateString(body: Record<string, unknown>, key: string, path: string): string {
  const value = text(body, key, path);
  if (Number.isNaN(Date.parse(value))) {
    throw new StatusContractError(`${path}.${key} must be a timestamp`);
  }
  return value;
}

function nullableDate(body: Record<string, unknown>, key: string, path: string): string | null {
  return body[key] === null ? null : dateString(body, key, path);
}

function oneOf<T extends string>(value: string, allowed: readonly T[], path: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new StatusContractError(`${path} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}
