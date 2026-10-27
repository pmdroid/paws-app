/**
 * Pure Closeout draft 0.1 evaluator. Spec section 8.
 *
 * Given a resolved policy, evidence records, the candidate, and a trust set,
 * this returns a decision document. It does not read the disk, spawn a
 * process, or load YAML. Callers supply changed paths and any read errors.
 */

import {
  SPEC_VERSION,
  type CandidateIdentity,
  type CommandExec,
  type CommandRecord,
  type DecisionDocument,
  type DecisionItem,
  type DecisionName,
  type DecisionWarning,
  type EvidenceApproval,
  type EvidenceRecord,
  type Finding,
  type Gate,
  type ItemState,
  type PublishedEvidence,
  type ResolvedCommand,
  type ResolvedEvidence,
  type ResolvedItem,
  type ResolvedPolicy,
  type ResolvedReview,
  type ResolvedSetup,
  type RetryPolicy,
  type ReviewRecord,
  type Severity,
} from "../index";
import { evidenceAttemptKey } from "../retry";
import { isPreExisting, type ChangedLines } from "../review/changed";
import { anyPathMatches } from "./paths";
import { producerTrusted, type EvaluateTrust } from "./trust";

/**
 * Exit 2 is an invalid invocation. It is not a decision document.
 * {@link decisionExit} maps a document to 0, 1, or 3.
 */
export const INVALID_INVOCATION_EXIT = 2;

const MESSAGE_LIMIT = 4000;

const BLOCKING: readonly ItemState[] = [
  "exhausted",
  "unsupported",
  "missing",
  "stale",
  "invalid",
  "untrusted",
  "independence",
];

/**
 * What to judge. `task` overrides `candidate.task` when both are set.
 *
 * `changedPaths` is the diff between `base` and `head`. Leave it unset when
 * the diff could not be read: requirements that have `paths` are `invalid`,
 * not `skipped`, and the decision message starts with
 * `changed paths are unavailable`.
 *
 * `evidenceError` blocks the decision before any requirement is judged. Use
 * it when the evidence directory cannot be read or a file fails the schema.
 *
 * `policyLoadError` blocks the decision with `policy.absent` false and null
 * path and digest. The policy argument is not consulted.
 *
 * `published` is the task's videos and screenshots at `head` or an ancestor
 * of it. An `evidence` requirement counts them. Without it, that requirement
 * fails.
 *
 * `changedLineRanges` maps `base..head` to the head lines added or changed in
 * that range. A review finding at a readable `path:line` outside the lines of
 * its record's range is pre-existing: it neither fails the item nor counts
 * toward the retry budget. A record whose range is absent keeps every finding.
 *
 * `approvals` are the reviews of this task's files. An `approval: human`
 * requirement with enough files and no approval covering all of them is
 * `missing`, which blocks the decision without starting a fix round.
 */
export type EvaluateRequest = {
  base: string;
  head: string;
  gate: Gate;
  task?: string;
  candidate: CandidateIdentity;
  changedPaths?: readonly string[] | null;
  changedLines?: number;
  changedLineRanges?: ReadonlyMap<string, ChangedLines>;
  retryBaseline?: readonly string[];
  evidenceError?: string;
  policyLoadError?: string;
  published?: readonly PublishedEvidence[];
  approvals?: readonly EvidenceApproval[];
};

export function decisionExit(decision: DecisionName): 0 | 1 | 3 {
  if (decision === "accepted") return 0;
  if (decision === "rejected") return 1;
  return 3;
}

export function evaluate(
  policy: ResolvedPolicy,
  records: readonly EvidenceRecord[],
  request: EvaluateRequest,
  trust?: EvaluateTrust,
): DecisionDocument {
  const candidate = candidateDocument(request);
  if (request.policyLoadError !== undefined) {
    return {
      specVersion: SPEC_VERSION,
      decision: "blocked",
      gate: request.gate,
      base: request.base,
      head: request.head,
      message: clip(request.policyLoadError),
      candidate,
      policy: { path: null, digest: null, absent: false },
      items: [],
      warnings: [],
    };
  }

  const warnings = warningsFor(policy);
  const blocked = (
    message: string,
    decisionPolicy: DecisionDocument["policy"] = policyIdentity(policy),
  ): DecisionDocument => ({
    specVersion: SPEC_VERSION,
    decision: "blocked",
    gate: request.gate,
    base: request.base,
    head: request.head,
    message: clip(message),
    candidate,
    policy: decisionPolicy,
    items: [],
    warnings,
  });

  if (request.evidenceError !== undefined) return blocked(request.evidenceError);
  const taskError = retryTaskError(policy, taskOf(request));
  if (taskError !== undefined) return blocked(taskError);
  if (policy.source === "none") {
    return {
      specVersion: SPEC_VERSION,
      decision: "accepted",
      gate: request.gate,
      base: request.base,
      head: request.head,
      message: "no closeout policy",
      candidate,
      policy: policyIdentity(policy),
      items: [],
      warnings,
    };
  }

  const items: DecisionItem[] = [];
  let setupFailed = false;
  let pathsUnreadable = false;
  for (const step of policy.setup) {
    if (step.gate !== request.gate) continue;
    let result = judgeItem(step, policy, records, request, trust);
    if (result.message === "changed paths are unavailable") pathsUnreadable = true;
    if (setupFailed && result.state === "missing") {
      result = { id: result.id, kind: result.kind, state: "skipped", message: "setup failed" };
    }
    if (result.state === "failed" || result.state === "exhausted") setupFailed = true;
    items.push(result);
  }
  for (const item of policy.items) {
    if (item.gate !== request.gate) continue;
    let result = judgeItem(item, policy, records, request, trust);
    if (result.message === "changed paths are unavailable") pathsUnreadable = true;
    // §5.4: a missing review stays missing. Only a later command is skipped.
    if (
      setupFailed &&
      item.kind === "command" &&
      !isUnsupported(item) &&
      result.state === "missing"
    ) {
      result = { id: result.id, kind: result.kind, state: "skipped", message: "setup failed" };
    }
    items.push(result);
  }

  const decision = decide(items);
  const document: DecisionDocument = {
    specVersion: SPEC_VERSION,
    decision,
    gate: request.gate,
    base: request.base,
    head: request.head,
    candidate,
    policy: policyIdentity(policy),
    items,
    warnings,
  };
  if (pathsUnreadable) document.message = "changed paths are unavailable";
  return document;
}

function decide(items: readonly DecisionItem[]): DecisionName {
  if (items.some((item) => BLOCKING.includes(item.state))) return "blocked";
  if (items.some((item) => item.state === "failed")) return "rejected";
  return "accepted";
}

function judgeItem(
  item: ResolvedItem,
  policy: ResolvedPolicy,
  records: readonly EvidenceRecord[],
  request: EvaluateRequest,
  trust: EvaluateTrust | undefined,
): DecisionItem {
  const paths = item.paths;
  if (paths !== undefined && paths.length > 0) {
    if (request.changedPaths == null) {
      return row(item, "invalid", "changed paths are unavailable");
    }
    if (!anyPathMatches(paths, request.changedPaths)) {
      return row(item, "skipped", "no changed path matches");
    }
  }
  if (
    isReview(item) &&
    item.minChangedLines !== undefined &&
    request.changedLines !== undefined &&
    request.changedLines < item.minChangedLines
  ) {
    return row(
      item,
      "skipped",
      `${request.changedLines} changed lines, under minChangedLines ${item.minChangedLines}`,
    );
  }
  if (isUnsupported(item)) {
    return row(item, "unsupported", `kind ${item.kind} is not supported`);
  }
  if (item.kind === "evidence") {
    return judgeEvidence(item, request.published ?? [], request.approvals ?? [], taskOf(request));
  }
  const retry = policy.source === "none" ? undefined : policy.retry;
  const blocked = retryBlock(item, retry, policy.digest ?? "", records, request, trust);
  if (blocked) return blocked;

  const task = taskOf(request);
  const taskScope = retry?.scope === "task";
  const matching = records.filter(
    (record) =>
      record.itemId === item.id &&
      record.base === request.base &&
      record.head === request.head &&
      record.policyDigest === (policy.digest ?? "") &&
      (!taskScope || record.task === task),
  );
  if (matching.length === 0) {
    const any = records.some(
      (record) => record.itemId === item.id && (!taskScope || record.task === task),
    );
    return any
      ? row(item, "stale", "evidence is for a different candidate or policy")
      : row(item, "missing", "no evidence for this candidate and policy");
  }
  const attempts = new Set<number>();
  for (const record of matching) {
    if (attempts.has(record.attempt)) {
      return row(item, "invalid", "duplicate evidence attempt");
    }
    attempts.add(record.attempt);
  }
  let latest = matching[0];
  if (latest === undefined)
    return row(item, "missing", "no evidence for this candidate and policy");
  for (const record of matching) {
    if (record.attempt > latest.attempt) latest = record;
  }
  return judgeRecord(item, latest, request, trust);
}

type RetryTally = {
  retry: RetryPolicy;
  failed: number;
  /** Failed review attempts per finding location. */
  repeats: Map<string, number>;
  /** The finding locations of the latest failed review attempt. */
  latest: Set<string>;
};

/** Failed attempts for `item` under its retry policy, counted as {@link retryBlock} counts them. */
function retryTally(
  item: ResolvedItem,
  retry: RetryPolicy | undefined,
  digest: string,
  records: readonly EvidenceRecord[],
  request: EvaluateRequest,
  trust: EvaluateTrust | undefined,
): RetryTally | "duplicate" {
  retry ??= { maxFailedAttemptsPerItem: 3, scope: taskOf(request) ? "task" : "candidate" };
  if (item.kind === "setup") retry = { ...retry, maxFailedAttemptsPerItem: 2 };
  const task = taskOf(request);
  const seen = new Set<string>();
  const tally: RetryTally = { retry, failed: 0, repeats: new Map(), latest: new Set() };
  for (const record of records) {
    if (record.itemId !== item.id || record.policyDigest !== digest) continue;
    if (retry.scope === "task") {
      if (task.trim().length === 0 || record.task !== task) continue;
    } else if (record.base !== request.base || record.head !== request.head) {
      continue;
    }
    const attemptKey = `${record.base}\0${record.head}\0${record.attempt}`;
    if (seen.has(attemptKey)) return "duplicate";
    seen.add(attemptKey);
    if (
      !request.retryBaseline?.includes(evidenceAttemptKey(record)) &&
      recordFailed(item, record, request, trust)
    ) {
      tally.failed += 1;
      if (isReview(item) && record.recordType === "review") {
        const keys = new Set(
          blockingFindings(record, request)
            .filter((finding) => severityRank(finding.severity) <= severityRank(item.failOn))
            .map((finding) => findingKey(finding.location)),
        );
        for (const key of keys) tally.repeats.set(key, (tally.repeats.get(key) ?? 0) + 1);
        tally.latest = keys;
      }
    }
  }
  return tally;
}

export function retryBlock(
  item: ResolvedItem,
  retry: RetryPolicy | undefined,
  digest: string,
  records: readonly EvidenceRecord[],
  request: EvaluateRequest,
  trust: EvaluateTrust | undefined,
): DecisionItem | undefined {
  const tally = retryTally(item, retry, digest, records, request, trust);
  if (tally === "duplicate") return row(item, "invalid", "duplicate evidence attempt");
  const { failed, repeats } = tally;
  retry = tally.retry;
  if (isReview(item) && retry.maxFailedReviewAttempts !== undefined) {
    let message: string;
    if (failed >= retry.maxFailedReviewAttempts) {
      message = `${failed} of ${retry.maxFailedReviewAttempts} allowed failed review attempts used.`;
    } else {
      const repeated = [...repeats.keys()]
        .sort()
        .find((key) => repeats.get(key)! >= retry.maxFailedAttemptsPerItem);
      if (repeated === undefined) return undefined;
      message = `${repeated} failed in ${repeats.get(repeated)} of ${retry.maxFailedAttemptsPerItem} allowed review attempts.`;
    }
    return row(item, "exhausted", `${message} Stop retrying and ask for help.`);
  }
  if (failed < retry.maxFailedAttemptsPerItem) return undefined;
  return row(
    item,
    "exhausted",
    `${failed} of ${retry.maxFailedAttemptsPerItem} allowed failed attempts used. Stop retrying and ask for help.`,
  );
}

/**
 * Failed attempts `item` may still record before it is exhausted, if it keeps failing the way it
 * last failed. A review keeps failing on the locations of its latest failed attempt. `null` when
 * the evidence cannot be counted.
 */
export function attemptsLeft(
  item: ResolvedItem,
  retry: RetryPolicy | undefined,
  digest: string,
  records: readonly EvidenceRecord[],
  request: EvaluateRequest,
  trust: EvaluateTrust | undefined,
): number | null {
  const tally = retryTally(item, retry, digest, records, request, trust);
  if (tally === "duplicate") return null;
  const { failed, repeats, latest } = tally;
  const max = tally.retry.maxFailedAttemptsPerItem;
  if (!isReview(item) || tally.retry.maxFailedReviewAttempts === undefined)
    return Math.max(0, max - failed);
  let left = tally.retry.maxFailedReviewAttempts - failed;
  for (const key of latest) left = Math.min(left, max - (repeats.get(key) ?? 0));
  return Math.max(0, left);
}

function findingKey(location: string): string {
  let key = location.trim();
  for (let index = 0; index < 2; index += 1) {
    const colon = key.lastIndexOf(":");
    if (colon <= 0 || !/^[0-9]+$/.test(key.slice(colon + 1))) break;
    key = key.slice(0, colon);
  }
  return key;
}

function recordFailed(
  item: ResolvedItem,
  record: EvidenceRecord,
  request: EvaluateRequest,
  trust: EvaluateTrust | undefined,
): boolean {
  return judgeRecord(item, record, request, trust).state === "failed";
}

function judgeRecord(
  item: ResolvedItem,
  record: EvidenceRecord,
  request: EvaluateRequest,
  trust: EvaluateTrust | undefined,
): DecisionItem {
  if (isCommandLike(item)) {
    if (record.recordType !== "command") return kindMismatch(item, record.attempt);
    return judgeCommand(item, item.exec, record, item.kind === "setup", trust);
  }
  if (isReview(item)) {
    if (record.recordType !== "review") return kindMismatch(item, record.attempt);
    return judgeReview(item, record, request);
  }
  return row(item, "unsupported", `kind ${item.kind} is not supported`);
}

function judgeEvidence(
  item: ResolvedEvidence,
  published: readonly PublishedEvidence[],
  approvals: readonly EvidenceApproval[],
  task: string,
): DecisionItem {
  const found = countEvidence(item, published);
  if (found < item.minimum) {
    return row(
      item,
      "failed",
      `${found} of ${item.minimum} ${mediaNoun(item, item.minimum)} published. ${evidenceRequest(item)}`,
    );
  }
  const counted = `${found} ${mediaNoun(item, found)}`;
  if (item.approval !== "human") return row(item, "passed", `${counted} published`);
  const approval = approvalFor(item, published, approvals, task);
  if (approval === undefined) {
    return row(item, "missing", `${counted} published, waiting for a visual review in Paws`);
  }
  return row(
    item,
    "passed",
    `${counted} approved by ${approval.approvedBy} at ${approval.approvedAt}`,
  );
}

function countedEvidence(
  item: ResolvedEvidence,
  published: readonly PublishedEvidence[],
): PublishedEvidence[] {
  return published.filter((entry) => entry.checkId === item.id && item.media.includes(entry.media));
}

/** Files published for this requirement in an allowed media kind. */
export function countEvidence(
  item: ResolvedEvidence,
  published: readonly PublishedEvidence[],
): number {
  return countedEvidence(item, published).length;
}

/**
 * The latest approval of this task's check that names every counted file.
 * A file published after the review, or one without an id, has no approval.
 */
export function approvalFor(
  item: ResolvedEvidence,
  published: readonly PublishedEvidence[],
  approvals: readonly EvidenceApproval[],
  task: string,
): EvidenceApproval | undefined {
  const ids = countedEvidence(item, published).map((entry) => entry.id);
  if (ids.length === 0) return undefined;
  let latest: EvidenceApproval | undefined;
  for (const approval of approvals) {
    if (approval.task !== task || approval.checkId !== item.id) continue;
    if (!ids.every((id) => id !== undefined && approval.evidenceIds.includes(id))) continue;
    if (latest === undefined || approval.approvedAt > latest.approvedAt) latest = approval;
  }
  return latest;
}

/** Shown with an `approval: human` requirement. */
export const VISUAL_REVIEW_HINT = "Publish the screenshots, then a person reviews them in Paws.";

/** What the agent does to satisfy an evidence requirement. */
export function evidenceRequest(item: ResolvedEvidence): string {
  const parts = [
    item.hint,
    `Call publish_artifact with checkId "${item.id}" for each file.`,
    item.approval === "human" ? VISUAL_REVIEW_HINT : undefined,
  ];
  return parts.filter((part) => part !== undefined).join(" ");
}

function mediaNoun(item: ResolvedEvidence, count: number): string {
  const one =
    item.media.length === 1
      ? item.media[0] === "video"
        ? "video"
        : "screenshot"
      : "screenshot or video";
  if (count === 1) return one;
  return item.media.length === 1 ? `${one}s` : "screenshots or videos";
}

function judgeCommand(
  item: ResolvedItem,
  exec: readonly string[],
  record: CommandRecord,
  allowDirty: boolean,
  trust: EvaluateTrust | undefined,
): DecisionItem {
  const attempt = record.attempt;
  if (!producerTrusted(record.producer.name, record.producer.version, trust)) {
    return row(item, "untrusted", "command evidence producer is not trusted", attempt);
  }
  if (!argvEquals(record.exec.argv, exec)) {
    return row(item, "invalid", "command evidence does not match the policy argv", attempt);
  }
  return applyExec(item, record.exec, allowDirty, attempt);
}

function applyExec(
  item: ResolvedItem,
  exec: CommandExec,
  allowDirty: boolean,
  attempt: number,
): DecisionItem {
  if (exec.timedOut) return row(item, "failed", "command timed out", attempt);
  if (exec.exitCode === null) return row(item, "failed", "command could not start", attempt);
  if (exec.exitCode !== 0) return row(item, "failed", `command exited ${exec.exitCode}`, attempt);
  if (exec.headMoved) return row(item, "failed", "command moved HEAD", attempt);
  if (exec.dirty && !allowDirty) {
    return row(item, "failed", "command left the worktree dirty", attempt);
  }
  return row(item, "passed", "exited 0", attempt);
}

function judgeReview(
  item: ResolvedReview,
  record: ReviewRecord,
  request: EvaluateRequest,
): DecisionItem {
  const attempt = record.attempt;
  const blocking = blockingFindings(record, request);
  const preExisting = preExistingNote(record.findings.length - blocking.length);
  const finding = failingFinding(blocking, item.failOn);
  if (finding) {
    return row(
      item,
      "failed",
      `finding at ${finding.severity} meets failOn ${item.failOn}${preExisting}`,
      attempt,
    );
  }
  const independence = independenceFailure(item, record, request.candidate);
  if (independence !== undefined) return row(item, "independence", independence, attempt);
  return row(item, "passed", `review findings satisfy the policy${preExisting}`, attempt);
}

/** Findings that can fail the item, judged against the record's own `base..head`. */
function blockingFindings(record: ReviewRecord, request: EvaluateRequest): readonly Finding[] {
  const changed = request.changedLineRanges?.get(`${record.base}..${record.head}`);
  if (changed === undefined) return record.findings;
  return record.findings.filter((finding) => !isPreExisting(finding, changed));
}

function preExistingNote(count: number): string {
  if (count === 0) return "";
  return count === 1
    ? "; 1 finding is in pre-existing code and does not block"
    : `; ${count} findings are in pre-existing code and do not block`;
}

function failingFinding(findings: readonly Finding[], failOn: Severity): Finding | undefined {
  let worst: Finding | undefined;
  const limit = severityRank(failOn);
  for (const finding of findings) {
    const rank = severityRank(finding.severity);
    if (rank > limit) continue;
    if (worst === undefined || rank < severityRank(worst.severity)) worst = finding;
  }
  return worst;
}

function independenceFailure(
  item: ResolvedReview,
  record: ReviewRecord,
  candidate: CandidateIdentity,
): string | undefined {
  if (item.independence.differentSession && !distinct(candidate.session, record.producer.session)) {
    return "reviewer does not satisfy differentSession";
  }
  if (item.independence.differentModel && !distinct(candidate.model, record.producer.model)) {
    return "reviewer does not satisfy differentModel";
  }
  return undefined;
}

/** Both values must be non-empty after trimming, and they must differ. */
function distinct(left: string, right: string): boolean {
  return left.trim().length > 0 && right.trim().length > 0 && left !== right;
}

function severityRank(severity: Severity): number {
  switch (severity) {
    case "P0":
      return 0;
    case "P1":
      return 1;
    case "P2":
      return 2;
    case "P3":
      return 3;
  }
}

function kindMismatch(item: ResolvedItem, attempt: number): DecisionItem {
  return row(item, "invalid", "evidence kind does not match the requirement", attempt);
}

function retryTaskError(policy: ResolvedPolicy, task: string): string | undefined {
  const retry = policy.source === "none" ? undefined : policy.retry;
  if (retry?.scope === "task" && task.trim().length === 0) {
    return "task retry scope requires --task with a stable task ID";
  }
  if (task.length > 0 && (task.trim().length === 0 || byteLength(task) > 256)) {
    return "task ID must contain 1 to 256 bytes and cannot be blank";
  }
  return undefined;
}

function taskOf(request: EvaluateRequest): string {
  if (request.task !== undefined) return request.task;
  return request.candidate.task ?? "";
}

function candidateDocument(request: EvaluateRequest): CandidateIdentity {
  const task = taskOf(request);
  const candidate: CandidateIdentity = {
    session: request.candidate.session,
    model: request.candidate.model,
    provider: request.candidate.provider,
  };
  if (task.length > 0 && codePoints(task) <= 256) candidate.task = task;
  return candidate;
}

function policyIdentity(policy: ResolvedPolicy): DecisionDocument["policy"] {
  return {
    path: policy.entryPath,
    digest: policy.digest,
    absent: policy.source === "none",
  };
}

function warningsFor(policy: ResolvedPolicy): DecisionWarning[] {
  if (policy.source === "local")
    return [
      { code: "local-policy", message: `Using configured local policy ${policy.entryPath}.` },
    ];
  if (policy.source !== "global") return [];
  return [
    {
      code: "global-policy",
      message: `Using ${policy.entryPath} because origin/main has no closeout policy.`,
    },
  ];
}

function row(
  item: ResolvedItem,
  state: ItemState,
  message: string,
  attempt?: number,
): DecisionItem {
  const result: DecisionItem = { id: item.id, kind: item.kind, state, message };
  if (attempt !== undefined) result.attempt = attempt;
  return result;
}

function isUnsupported(item: ResolvedItem): item is ResolvedItem & { supported: false } {
  return "supported" in item;
}

function isCommandLike(item: ResolvedItem): item is ResolvedCommand | ResolvedSetup {
  return !isUnsupported(item) && (item.kind === "command" || item.kind === "setup");
}

function isReview(item: ResolvedItem): item is ResolvedReview {
  return !isUnsupported(item) && item.kind === "review";
}

function argvEquals(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] !== expected[index]) return false;
  }
  return true;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function codePoints(value: string): number {
  return [...value].length;
}

function clip(message: string): string {
  return message.length <= MESSAGE_LIMIT ? message : message.slice(0, MESSAGE_LIMIT);
}
