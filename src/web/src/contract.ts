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
] as const;
export const CHECK_KINDS = ["setup", "command", "review"] as const;
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
}

export interface StatusActivity {
  at: string;
  kind: ActivityKind;
  text: string;
}

export interface StatusRun {
  id: string;
  itemId: string;
  state: RunState;
  agent: string;
  reviewer: string;
  startedAt: string;
  attempt: number;
  summary: string;
  activity: StatusActivity[];
  links: StatusLink[];
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
}

export interface StatusVerdict {
  itemId: string;
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
}

export interface StatusMergeStep {
  name: string;
  state: StepState;
  detail: string | null;
}

export interface StatusMergeEntry {
  position: number;
  itemId: string;
  enqueuedAt: string;
  steps: StatusMergeStep[];
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
  events: StatusEvent[];
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
  const items = ids(
    snapshot.items.map((item) => item.id),
    "item",
    problems,
  );
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
  const positions = new Set<number>();
  for (const entry of snapshot.mergeQueue) {
    if (!items.has(entry.itemId)) problems.push(`queue item ${entry.itemId} is missing`);
    if (positions.has(entry.position)) problems.push(`duplicate queue position ${entry.position}`);
    positions.add(entry.position);
  }
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
  return {
    version: STATUS_API_VERSION,
    source: oneOf(string(body, "source", "status"), SOURCES, "status.source"),
    generatedAt: dateString(body, "generatedAt", "status"),
    project: readProject(body.project),
    items: array(body, "items", "status").map((entry, index) => readItem(entry, index)),
    runs: array(body, "runs", "status").map((entry, index) => readRun(entry, index)),
    questions: array(body, "questions", "status").map((entry, index) => readQuestion(entry, index)),
    verdicts: array(body, "verdicts", "status").map((entry, index) => readVerdict(entry, index)),
    mergeQueue: array(body, "mergeQueue", "status").map((entry, index) => readMerge(entry, index)),
    events: array(body, "events", "status").map((entry, index) => readEvent(entry, index)),
  };
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
  };
}

function readRun(input: unknown, index: number): StatusRun {
  const path = `runs[${index}]`;
  const body = object(input, path);
  return {
    id: text(body, "id", path),
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
  };
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
  };
}

function readMerge(input: unknown, index: number): StatusMergeEntry {
  const path = `mergeQueue[${index}]`;
  const body = object(input, path);
  const position = body.position;
  if (typeof position !== "number" || !Number.isInteger(position) || position < 1) {
    throw new StatusContractError(`${path}.position must be an integer >= 1`);
  }
  return {
    position,
    itemId: text(body, "itemId", path),
    enqueuedAt: dateString(body, "enqueuedAt", path),
    steps: array(body, "steps", path).map((entry, step) =>
      readStep(entry, `${path}.steps[${step}]`),
    ),
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

function oneOf<T extends string>(value: string, allowed: readonly T[], path: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new StatusContractError(`${path} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}
