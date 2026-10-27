export { holdsExecution, isBlockerSatisfied } from "../../core";

import { journalCaught } from "./journal";
/**
 * Read-only status snapshot served by the local Paws engine.
 *
 * `GET /api/status` returns JSON of this shape. `source` is `"live"` because the body comes from the serving process.
 * The array `questions` lists open questions only. The list carries open items and items that
 * finished in the last 24 hours, with one Closeout summary per item; `GET /api/status/items/<id>`
 * carries everything about one item.
 */

export const STATUS_API_VERSION = 2 as const;

export const STATUS_API_PATH = "/api/status";
/** `GET /api/status/items/<id>` returns a `StatusItemDetail` for the issue with that id. */
export const STATUS_ITEM_API_PATH = "/api/status/items";
export const STATUS_PAGE_PATH = "/status";

export const ITEM_STATES = [
  "queued",
  "planning",
  "running",
  "awaiting_input",
  "verifying",
  "merge_queue",
  "merged",
  "completed",
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
export const ITEM_EVENT_KINDS = ["transition", "restart", "ask"] as const;
export const SOURCES = ["live"] as const;

export type ItemState = (typeof ITEM_STATES)[number];
export type RunState = (typeof RUN_STATES)[number];
export type QuestionKind = (typeof QUESTION_KINDS)[number];
export type Urgency = (typeof URGENCIES)[number];
export type VerdictDecision = (typeof VERDICT_DECISIONS)[number];
export type CheckState = (typeof CHECK_STATES)[number];
export type CheckKind = (typeof CHECK_KINDS)[number];
export type StepState = (typeof STEP_STATES)[number];
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
export type ItemEventKind = (typeof ITEM_EVENT_KINDS)[number];
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
  /** Unresolved blockers, evaluated by core before rendering. */
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
  /** Every state change of the item, oldest first, from `work_item_event`. */
  timeline?: StatusItemEvent[];
}

/**
 * One committed state change. `from` and `to` are the engine's work-item states, finer than
 * `ItemState`. A `restart` sent the item back to the agent and an `ask` asked a person; both
 * carry their `reason`.
 */
export interface StatusItemEvent {
  at: string;
  kind: ItemEventKind;
  from: string;
  to: string;
  event: string;
  reason: string | null;
  actor: string | null;
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
  /** Present when the question is answered on the item page, not in Linear. */
  linkAsk?: StatusLinkAsk;
}

export const LINK_ASK_KINDS = ["bypass", "screenshots", "risk", "question", "rounds"] as const;
export type LinkAskKind = (typeof LINK_ASK_KINDS)[number];

/** A decision a signed-in person makes on the item page. Linear carries its `link`. */
export interface StatusLinkAsk {
  kind: LinkAskKind;
  /** The head commit the decision is bound to. A new head closes the ask. */
  head: string;
  title: string;
  detail: string;
  link: string;
  /** For a `bypass` ask: the failed checks a person may bypass on this head. */
  bypass?: StatusBypassAsk;
  /** On the `rounds` kind: the failed review rounds and the findings still open. */
  rounds?: StatusReviewRounds;
}

/** What the "Closeout needs your help" card shows and binds a bypass to. */
export interface StatusBypassAsk {
  policyDigest: string;
  /** Checks that passed on the head, by id. */
  passed: string[];
  checks: StatusBypassCheck[];
}

/** One failed check a bypass may waive, as Closeout judged it on the head. */
export interface StatusBypassCheck {
  id: string;
  kind: string;
  state: string;
  attempt: number | null;
  /** The finding, or the last lines of the check's output. */
  finding: string;
}

/** The review rounds that ran out, shown with the choice on the item page. */
export interface StatusReviewRounds {
  rounds: { head: string; findings: number }[];
  open: { severity: string; location: string; bugClass: string }[];
  /** The class of bug reported most often across the rounds. */
  bugClass: string | null;
  /** How many more rounds Keep going grants, when the policy says. */
  limit: number | null;
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

/** The list's Closeout of an item: the latest verdict, with each check's kind and state only. */
export interface StatusVerdictSummary {
  itemId: string;
  /** The `StatusRun.id` of the attempt this verdict belongs to, when the issue had several. */
  runId?: string;
  decision: VerdictDecision;
  headSha: string | null;
  checks: StatusCheckSummary[];
}

export interface StatusCheckSummary {
  id: string;
  kind: CheckKind;
  state: CheckState;
}

/** The list's agent-side Closeout of a run: its latest state, without attempts or steps. */
export interface StatusAgentCloseoutSummary {
  itemId: string;
  runId: string;
  /** The latest attempt's decision, null before the agent's first attempt. */
  decision: VerdictDecision | null;
  headSha: string | null;
  blocked: string | null;
  updatedAt: string;
  endedAt?: string;
  continuesIn?: string;
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

export interface StatusProject {
  name: string;
  team: string;
  repo: string;
  workspace: string | null;
}

/** The fields the status list and the item detail share. */
export interface StatusSnapshotBase {
  version: typeof STATUS_API_VERSION;
  source: StatusSource;
  generatedAt: string;
  project: StatusProject;
  items: StatusItem[];
  runs: StatusRun[];
  questions: StatusQuestion[];
  mergeQueue: StatusMergeEntry[];
  /** Merged in the last 24 hours, and tasks back with the agent after CI or a conflict. */
  mergeHistory?: StatusMergeOutcome[];
  /** Closeout videos and screenshots of the visible items, oldest first. */
  evidence?: StatusEvidence[];
  /** Failed CI reads of the visible items' pull requests, with every check on each head. */
  ciRounds?: StatusCiRound[];
  intake?: StatusIntakeEntry[];
  /** Dead outbox rows and dead jobs of the visible items, oldest first. Each can be retried. */
  dead?: StatusDeadDelivery[];
  linearBudget?: StatusLinearBudget;
  linearWebhook?: StatusLinearWebhook;
}

/**
 * The status list from `GET /api/status`: open items, and items that finished in the last
 * 24 hours (at most 50). Each item has one Closeout summary and each run its agent Closeout
 * state; the attempts, checks and findings are in the item detail.
 */
export interface StatusSnapshot extends StatusSnapshotBase {
  verdicts: StatusVerdictSummary[];
  agentCloseout?: StatusAgentCloseoutSummary[];
}

/**
 * One issue for its page, from `GET /api/status/items/<id>`: every visible session of the issue
 * (`items`, an earlier one with `endedAt`), its runs, questions, Closeout verdicts with every
 * attempt, agent Closeout, evidence, CI rounds and merge state, whether or not the issue is in
 * the list. Check `stdout` and `stderr` are left out; `statusCheckLogPath` loads one check's
 * log. `blocks` lists the issues this one blocks.
 */
export interface StatusItemDetail extends StatusSnapshotBase {
  id: string;
  blocks: string[];
  verdicts: StatusVerdict[];
  agentCloseout?: StatusAgentCloseout[];
}

export type ItemDetailParseResult =
  | { ok: true; detail: StatusItemDetail }
  | { ok: false; error: string };

export function statusItemPath(id: string): string {
  return `${STATUS_ITEM_API_PATH}/${encodeURIComponent(id)}`;
}

/** Bytes of each stream the check log endpoint returns unless the full log is asked for. */
export const CHECK_LOG_TAIL_BYTES = 64 * 1024;

/**
 * One check's output, from `GET /api/status/items/<id>/attempts/<n>/checks/<check id>/log`.
 * Each stream is its last `CHECK_LOG_TAIL_BYTES` unless the path carries `full=1`.
 */
export interface StatusCheckLog {
  stdout: string;
  stderr: string;
  /** True when either stream was cut here. `fullPath` returns all of both. */
  truncated: boolean;
  fullPath: string | null;
}

export type CheckLogParseResult = { ok: true; log: StatusCheckLog } | { ok: false; error: string };

/**
 * The log path of check `checkId` in Closeout attempt `attempt` of the issue `itemId`. `run`
 * names the run whose agent Closeout holds the check; without it the check is Paws' Closeout.
 */
export function statusCheckLogPath(
  itemId: string,
  attempt: number,
  checkId: string,
  options: { run?: string | null; full?: boolean } = {},
): string {
  const query = new URLSearchParams();
  if (options.run) query.set("run", options.run);
  if (options.full) query.set("full", "1");
  const search = query.toString() ? `?${query.toString()}` : "";
  return `${statusItemPath(itemId)}/attempts/${attempt}/checks/${encodeURIComponent(checkId)}/log${search}`;
}

export function parseStatusCheckLog(input: unknown): CheckLogParseResult {
  try {
    const body = object(input, "log");
    return {
      ok: true,
      log: {
        stdout: string(body, "stdout", "log"),
        stderr: string(body, "stderr", "log"),
        truncated: boolean(body, "truncated", "log"),
        fullPath: body.fullPath === null ? null : text(body, "fullPath", "log"),
      },
    };
  } catch (error) {
    journalCaught(error, "contract.parseStatusCheckLog.object", null);
    const message = error instanceof Error ? error.message : "Invalid check log";
    return { ok: false, error: message };
  }
}

export function parseStatusItemDetail(input: unknown): ItemDetailParseResult {
  try {
    const body = object(input, "detail");
    return {
      ok: true,
      detail: {
        ...readBase(body),
        id: text(body, "id", "detail"),
        blocks: stringArray(body, "blocks", "detail"),
        verdicts: array(body, "verdicts", "status").map((entry, index) =>
          readVerdict(entry, index),
        ),
        ...(body.agentCloseout === undefined
          ? {}
          : {
              agentCloseout: array(body, "agentCloseout", "status").map((entry, index) =>
                readAgentCloseout(entry, `agentCloseout[${index}]`),
              ),
            }),
      },
    };
  } catch (error) {
    journalCaught(error, "contract.parseStatusItemDetail.readBase", null);
    const message = error instanceof Error ? error.message : "Invalid item detail";
    return { ok: false, error: message };
  }
}

/** The list's summary of a full verdict: decision, head, and each check's id, kind and state. */
export function verdictSummary(verdict: StatusVerdict): StatusVerdictSummary {
  return {
    itemId: verdict.itemId,
    ...(verdict.runId === undefined ? {} : { runId: verdict.runId }),
    decision: verdict.decision,
    headSha: verdict.headSha,
    checks: verdict.checks.map((check) => ({ id: check.id, kind: check.kind, state: check.state })),
  };
}

/** The list's summary of a run's agent Closeout: its latest attempt's decision and head. */
export function agentCloseoutSummary(agent: StatusAgentCloseout): StatusAgentCloseoutSummary {
  const latest = agent.attempts.at(-1);
  return {
    itemId: agent.itemId,
    runId: agent.runId,
    decision: latest?.decision ?? null,
    headSha: latest?.headSha ?? null,
    blocked: agent.blocked,
    updatedAt: agent.updatedAt,
    ...(agent.endedAt === undefined ? {} : { endedAt: agent.endedAt }),
    ...(agent.continuesIn === undefined ? {} : { continuesIn: agent.continuesIn }),
  };
}

export interface StatusIntakeEntry {
  issue: string;
  title: string | null;
  receivedAt: string;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
}

export const DEAD_DELIVERY_KINDS = ["outbox", "job"] as const;
export type DeadDeliveryKind = (typeof DEAD_DELIVERY_KINDS)[number];

/** An outbox row or job that used its attempts. `target` is what the retry action sends. */
export interface StatusDeadDelivery {
  itemId: string;
  kind: DeadDeliveryKind;
  /** `outbox:<id>` or `job:<id>`. */
  target: string;
  /** `linear.elicitation` for an outbox row, the queue for a job. */
  name: string;
  attempts: number;
  lastError: string | null;
  at: string;
  /** False for a job from an earlier state of the item; retrying it would revive obsolete work. */
  retryable?: boolean;
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
    journalCaught(error, "contract.parseStatusSnapshot.readSnapshot", null);
    const message = error instanceof Error ? error.message : "Invalid status snapshot";
    return { ok: false, error: message };
  }
}

export function statusIntegrity(
  snapshot: StatusSnapshotBase & { verdicts: readonly { itemId: string }[] },
): string[] {
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
  return {
    ...readBase(body),
    verdicts: array(body, "verdicts", "status").map((entry, index) =>
      readVerdictSummary(entry, `verdicts[${index}]`),
    ),
    ...(body.agentCloseout === undefined
      ? {}
      : {
          agentCloseout: array(body, "agentCloseout", "status").map((entry, index) =>
            readAgentCloseoutSummary(entry, `agentCloseout[${index}]`),
          ),
        }),
  };
}

function readBase(body: Record<string, unknown>): StatusSnapshotBase {
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
    ...(body.evidence === undefined
      ? {}
      : {
          evidence: array(body, "evidence", "status").map((entry, index) =>
            readEvidence(entry, `evidence[${index}]`),
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
    ...(body.dead === undefined
      ? {}
      : {
          dead: array(body, "dead", "status").map((entry, index) =>
            readDeadDelivery(entry, `dead[${index}]`),
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

function readDeadDelivery(input: unknown, path: string): StatusDeadDelivery {
  const body = object(input, path);
  const kind = oneOf(string(body, "kind", path), DEAD_DELIVERY_KINDS, `${path}.kind`);
  const target = text(body, "target", path);
  if (!new RegExp(`^${kind}:[1-9][0-9]*$`).test(target))
    throw new StatusContractError(`${path}.target must be ${kind}:<id>`);
  return {
    itemId: text(body, "itemId", path),
    kind,
    target,
    name: text(body, "name", path),
    attempts: count(body, "attempts", path),
    lastError: nullableText(body, "lastError", path),
    at: dateString(body, "at", path),
    ...(body.retryable === undefined ? {} : { retryable: boolean(body, "retryable", path) }),
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

function readAgentCloseoutSummary(input: unknown, path: string): StatusAgentCloseoutSummary {
  const body = object(input, path);
  const decision = optionalText(body, "decision");
  return {
    itemId: text(body, "itemId", path),
    runId: text(body, "runId", path),
    decision: decision === null ? null : oneOf(decision, VERDICT_DECISIONS, `${path}.decision`),
    headSha: optionalText(body, "headSha"),
    blocked: optionalText(body, "blocked"),
    updatedAt: dateString(body, "updatedAt", path),
    ...(body.endedAt === undefined ? {} : { endedAt: dateString(body, "endedAt", path) }),
    ...(body.continuesIn === undefined ? {} : { continuesIn: text(body, "continuesIn", path) }),
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
    ...(body.timeline === undefined
      ? {}
      : {
          timeline: array(body, "timeline", path).map((entry, at) =>
            readItemEvent(entry, `${path}.timeline[${at}]`),
          ),
        }),
  };
}

function readItemEvent(input: unknown, path: string): StatusItemEvent {
  const body = object(input, path);
  return {
    at: dateString(body, "at", path),
    kind: oneOf(string(body, "kind", path), ITEM_EVENT_KINDS, `${path}.kind`),
    from: text(body, "from", path),
    to: text(body, "to", path),
    event: text(body, "event", path),
    reason: nullableText(body, "reason", path),
    actor: nullableText(body, "actor", path),
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
    ...(body.linkAsk === undefined
      ? {}
      : { linkAsk: readLinkAsk(body.linkAsk, `${path}.linkAsk`) }),
  };
}

function readLinkAsk(input: unknown, path: string): StatusLinkAsk {
  const body = object(input, path);
  return {
    kind: oneOf(string(body, "kind", path), LINK_ASK_KINDS, `${path}.kind`),
    head: text(body, "head", path),
    title: text(body, "title", path),
    detail: string(body, "detail", path),
    link: text(body, "link", path),
    ...(body.bypass === undefined ? {} : { bypass: readBypassAsk(body.bypass, `${path}.bypass`) }),
    ...(body.rounds === undefined
      ? {}
      : { rounds: readReviewRounds(body.rounds, `${path}.rounds`) }),
  };
}

function readBypassAsk(input: unknown, path: string): StatusBypassAsk {
  const body = object(input, path);
  return {
    policyDigest: string(body, "policyDigest", path),
    passed: stringArray(body, "passed", path),
    checks: array(body, "checks", path).map((entry, index) => {
      const at = `${path}.checks[${index}]`;
      const check = object(entry, at);
      return {
        id: text(check, "id", at),
        kind: string(check, "kind", at),
        state: text(check, "state", at),
        attempt: optionalCount(check, "attempt", at),
        finding: string(check, "finding", at),
      };
    }),
  };
}

function readReviewRounds(input: unknown, path: string): StatusReviewRounds {
  const body = object(input, path);
  return {
    rounds: array(body, "rounds", path).map((entry, index) => {
      const round = object(entry, `${path}.rounds[${index}]`);
      return {
        head: text(round, "head", `${path}.rounds[${index}]`),
        findings: count(round, "findings", `${path}.rounds[${index}]`),
      };
    }),
    open: array(body, "open", path).map((entry, index) => {
      const finding = object(entry, `${path}.open[${index}]`);
      const at = `${path}.open[${index}]`;
      return {
        severity: text(finding, "severity", at),
        location: text(finding, "location", at),
        bugClass: text(finding, "bugClass", at),
      };
    }),
    bugClass: body.bugClass === null ? null : text(body, "bugClass", path),
    limit: optionalCount(body, "limit", path),
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

function readVerdictSummary(input: unknown, path: string): StatusVerdictSummary {
  const body = object(input, path);
  return {
    itemId: text(body, "itemId", path),
    ...(body.runId === undefined ? {} : { runId: text(body, "runId", path) }),
    decision: oneOf(string(body, "decision", path), VERDICT_DECISIONS, `${path}.decision`),
    headSha: optionalText(body, "headSha"),
    checks: array(body, "checks", path).map((entry, index) => {
      const at = `${path}.checks[${index}]`;
      const check = object(entry, at);
      return {
        id: text(check, "id", at),
        kind: oneOf(string(check, "kind", at), CHECK_KINDS, `${at}.kind`),
        state: oneOf(string(check, "state", at), CHECK_STATES, `${at}.state`),
      };
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
