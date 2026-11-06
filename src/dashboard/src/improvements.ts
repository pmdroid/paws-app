import type {
  ImprovementCriterion,
  ImprovementDecision,
  ImprovementDelivery,
  ImprovementImplementationState,
  ImprovementOutcomeRecord,
  ImprovementProposal,
  ImprovementReviewState,
  ImprovementSourceKind,
  ImprovementVerificationState,
} from "../../db";

export const IMPROVEMENTS_API_PATH = "/api/improvements";
export const IMPROVEMENT_ATTENTION_PATH = "/api/improvements/attention";
export const RETRO_HISTORY_API_PATH = "/api/retros/history";
export const RETRO_RUNS_API_PATH = "/api/retros/runs";
export const RETRO_SCHEDULE_API_PATH = "/api/retros/schedule";

export const IMPROVEMENT_LIFECYCLES = ["needs_review", "pending", "linked", "rejected"] as const;
export type ImprovementLifecycle = (typeof IMPROVEMENT_LIFECYCLES)[number];

export type ImprovementFilter = {
  source: "" | "daily" | "weekly";
  repository: string;
  state: "" | ImprovementLifecycle;
};

export const DEFAULT_IMPROVEMENT_FILTER: ImprovementFilter = {
  source: "",
  repository: "",
  state: "",
};

type KnownIssue = {
  id: string | null;
  identifier: string | null;
  url: string | null;
  origin: "decision" | "legacy";
};

type LegacyAction = {
  kind: "filed" | "added" | "dismissed" | "claimed";
  issue: string | null;
  reason: string | null;
  by: string | null;
  at: number | null;
};

type DeliveryView = {
  id: string;
  operation: ImprovementDelivery["operation"];
  status: "pending" | "retryable" | "unknown" | "succeeded";
  attempts: number;
  targetIssueId: string | null;
  targetTeamId: string | null;
  issue: { id: string | null; identifier: string | null; url: string | null } | null;
  error: string | null;
  blocked: ImprovementDelivery["blocked"];
  nextAttemptAt: number | null;
  recovery: "retry" | "choose_destination" | "reopen" | "cancel_comment" | null;
  updatedAt: number;
};

type ShownProposal = Omit<ImprovementProposal, "improvementId" | "contentSha256">;

export type ImprovementItem = {
  id: string;
  version: number;
  sourceKind: ImprovementSourceKind;
  repository: string;
  lifecycle: ImprovementLifecycle;
  reviewState: ImprovementReviewState;
  proposal: ShownProposal;
  criterion: string | null;
  decision: {
    proposalVersion: number | null;
    intent: "create" | "link" | null;
    intentIssueId: string | null;
    evidenceComment: boolean;
    reason: string | null;
    by: string | null;
    at: number | null;
  };
  issue: KnownIssue | null;
  legacy: LegacyAction[];
  deliveries: DeliveryView[];
  implementation: ImprovementImplementationState;
  verification: ImprovementVerificationState;
};

export type ImprovementList = {
  items: ImprovementItem[];
  matching: number;
  counts: {
    total: number;
    needsReview: number;
    daily: number;
    weekly: number;
    linked: number;
    missingCriterion: number;
  };
  repositories: string[];
  nextCursor: string | null;
};

type ImprovementEvidence =
  | {
      kind: "review_finding";
      ref: string;
      repository: string;
      location: string;
      status: string;
      lastSeenAt: number;
    }
  | {
      kind: "retro_evidence";
      ref: string;
      retroId: string;
      repository: string;
      sourceKind: string;
      occurredAt: number;
      excerpt: string;
    };

export type ImprovementDetail = {
  item: ImprovementItem;
  proposals: ShownProposal[];
  decisions: Omit<ImprovementDecision, "improvementId">[];
  criteria: ImprovementCriterion[];
  evidence: ImprovementEvidence[];
  destinations: string[];
  candidates: { issue: KnownIssue; improvements: string[] }[];
};

export type AttentionState =
  | "needs_review"
  | "rejected"
  | "accepted_unfiled"
  | "filing_failed"
  | "ready_to_delegate"
  | "working"
  | "blocked"
  | "awaiting_verification"
  | "verified"
  | "verification_stale"
  | "canceled"
  | "unavailable"
  | "stale_sync"
  | "closed";

type FollowThrough = {
  id: string;
  version: number;
  repository: string;
  attention: AttentionState;
  review: { state: ImprovementReviewState; at: number | null };
  delivery: "none" | "pending" | "failed" | "unknown" | "succeeded";
  issue: {
    id: string;
    identifier: string | null;
    url: string | null;
    confirmedAt: number;
    sync: {
      status: string;
      stateType: string | null;
      teamId: string | null;
      delegated: boolean | null;
      observedAt: number;
      confirmedAt: number | null;
    } | null;
    fresh: boolean;
  } | null;
  work: {
    itemId: string;
    state: string;
    identifier: string;
    pull: { number: number; url: string | null; openedAt: number } | null;
    merge: { number: number; url: string | null; sha: string | null; confirmedAt: number } | null;
  } | null;
  delegation: {
    issueId: string;
    state: string;
    sessionId: string | null;
    error: string | null;
    attempts: number;
    requestedAt: number;
    updatedAt: number;
  } | null;
  delegate: { offered: boolean; reason: string | null };
  implementation: {
    state: ImprovementImplementationState;
    source: "paws" | "linear" | "none";
    at: number | null;
  };
  verification: {
    state: ImprovementVerificationState;
    at: number | null;
    criterion: string | null;
    stale: "recurred" | "reopened" | null;
  };
  recovery: ("acknowledge" | "redelegate" | "return_to_review")[];
};

export type ImprovementFollowThroughDetail = {
  followThrough: FollowThrough;
  outcomes: Omit<ImprovementOutcomeRecord, "improvementId">[];
  actions: { id: number; action: string; actor: string; at: number }[];
};

export type ImprovementAttention = {
  counts: {
    newReview: number;
    filingErrors: number;
    needsAttention: number;
    verificationDue: number;
    total: number;
  };
  items: { id: string; attention: AttentionState }[];
  activity: {
    key: string;
    kind: "review" | "filing" | "work" | "verification";
    count: number;
    improvementIds: string[];
    latestAt: number;
  }[];
};

export type ImprovementOutcome = {
  status: string;
  reason?: string;
  message?: string;
  item?: ImprovementItem | FollowThrough;
};

type RetroGenerationState = "queued" | "waiting_for_runner" | "generating" | "failed" | "ready";

type RetroGenerationView = {
  state: RetroGenerationState;
  diagnostic: string | null;
  detail: string | null;
  attempt: number;
  attemptsUsed: number;
  maxAttempts: number;
  retry: { at: number } | null;
  waitMs: number;
  activeMs: number;
  error: string | null;
};

type RetroCounts = {
  sessions: number;
  events: number;
  context: number;
  byKind: Record<string, number>;
  byWorkItem: { identifier: string; events: number }[];
};

type RetroReport = {
  version: number;
  retroId: string;
  digestSha256: string;
  generation: "model" | "empty_input";
  windows: { repository: string; start: number; end: number }[];
  numbers: { key: string; label: string; value: number }[];
  items: {
    itemId: string;
    repository: string;
    area: string;
    title: string;
    explanation: string;
    hypothesis: string;
    expectedBenefit: string;
    evidenceIds: string[];
    action: { step: string; change: string };
    verification: string;
    existingIssues: string[];
    counts: RetroCounts;
    priorWork: {
      improvementId: string;
      issueIdentifier: string | null;
      implementationState: string;
      verificationState: string;
      relation: string;
    }[];
  }[];
  workedWell: {
    repository: string;
    observation: string;
    evidenceIds: string[];
    counts: RetroCounts;
  }[];
  notes: string[];
};

type RetroScheduleStatus = {
  saved: boolean;
  settingsRevision: number;
  schedule: Record<string, unknown>;
  state: "waiting" | "generating" | "failed" | "empty" | "ready";
  reason: string | null;
  nextRun: { at: number; due: boolean } | null;
  retry: { at: number } | null;
  blocked: { reason: string; since: number | null } | null;
  lastSuccess: {
    retroId: string;
    cutoff: number;
    windowStart: number;
    publishedAt: number | null;
    empty: boolean;
  } | null;
  current: {
    retroId: string;
    origin: "scheduled" | "manual";
    state: string;
    windowStart: number;
    windowEnd: number;
    error: string | null;
    generation: RetroGenerationView | null;
  } | null;
};

export type RetroHistoryEntry = {
  id: string;
  windowStart: number;
  windowEnd: number;
  origin: "scheduled" | "manual";
  createdAt: number;
  publishedAt: number | null;
  fullAccess: boolean;
  repositories: string[];
  generation: Partial<RetroGenerationView> & { state: RetroGenerationView["state"] | null };
  items: {
    visible: number;
    toReview: number;
    links: {
      itemId: string;
      improvementId: string;
      reviewState: string | null;
      issue: { identifier: string | null; url: string | null } | null;
    }[];
  };
  /** The rest is null without access to every repository and session the retro includes. */
  settingsRevision: number | null;
  /** The agent, model and effort frozen on the retro; a null effort is the agent's default. */
  profile: { agent: string | null; model: string | null; effort: string | null } | null;
  digest: { sessions: number; counted: number; context: number } | null;
  patterns: number | null;
  evidence: "complete" | "incomplete" | "expired" | null;
  artifacts: Record<RetroArtifact, "stored" | "unavailable" | "none"> | null;
};

export type RetroArtifact = "digest" | "report" | "prompt";

/** An item's follow-through now. It is separate from what the frozen report claimed. */
export type RetroCurrentOutcome = {
  improvementId: string;
  attention: string;
  issue: {
    identifier: string | null;
    url: string | null;
    confirmedAt: number;
    syncedAt: number | null;
    fresh: boolean;
  } | null;
  implementation: { state: string; at: number | null };
  verification: { state: string; at: number | null };
};

export type RetroHistory = {
  retros: RetroHistoryEntry[];
  total: number;
  nextCursor: string | null;
};

type ReportItem = RetroReport["items"][number] & {
  improvement: { improvementId: string; version: number | null; reviewState: string | null } | null;
};

export type RetroReportView = Omit<RetroReport, "items" | "numbers" | "digestSha256"> & {
  items: ReportItem[];
  numbers?: RetroReport["numbers"];
  filtered: boolean;
};

export type RetroReportResponse = {
  retro: RetroHistoryEntry;
  report: RetroReportView | null;
  coverageGaps: { kind: string; repository: string | null; detail: string | null }[] | null;
  /** Keyed by report item id; null when the item's improvement is not in the reader's inbox. */
  current: Record<string, RetroCurrentOutcome | null>;
};

export type RetroItemEvidence = {
  retroId: string;
  itemId: string;
  improvementId: string;
  evidence: {
    evidenceId: string;
    repository: string;
    sourceKind: string;
    sourceRef: string;
    occurredAt: number;
    excerpt: string;
    identifier: string | null;
  }[];
};

export type RetroSchedule = RetroScheduleStatus & { canEdit: boolean; canRun: boolean };

export function improvementQuery(filter: ImprovementFilter, cursor?: string | null): string {
  const params = new URLSearchParams();
  if (filter.source) params.set("source", filter.source);
  if (filter.repository) params.set("repository", filter.repository);
  if (filter.state) params.set("state", filter.state);
  if (cursor) params.set("cursor", cursor);
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function parseImprovementQuery(search: string | URLSearchParams): ImprovementFilter {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const source = params.get("source");
  const state = params.get("state");
  const repository = params.get("repository")?.trim() ?? "";
  return {
    source: source === "daily" || source === "weekly" ? source : "",
    repository: repository.length <= 200 ? repository : "",
    state: IMPROVEMENT_LIFECYCLES.includes(state as ImprovementLifecycle)
      ? (state as ImprovementLifecycle)
      : "",
  };
}

export const improvementPath = (id: string, action = "") =>
  `${IMPROVEMENTS_API_PATH}/${encodeURIComponent(id)}${action ? `/${action}` : ""}`;

export const retroReportPath = (retroId: string, file?: RetroArtifact) =>
  `/api/retros/reports/${encodeURIComponent(retroId)}${file ? `/${file}` : ""}`;

export const retroEvidencePath = (retroId: string, itemId: string) =>
  `${retroReportPath(retroId)}/items/${encodeURIComponent(itemId)}/evidence`;

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function shaped<T>(
  body: unknown,
  name: string,
  check: (value: Record<string, unknown>) => boolean,
): Parsed<T> {
  return record(body) && check(body)
    ? { ok: true, value: body as T }
    : { ok: false, error: `The ${name} response did not have the expected shape.` };
}

const isItem = (value: unknown): boolean =>
  record(value) &&
  typeof value.id === "string" &&
  typeof value.version === "number" &&
  typeof value.repository === "string" &&
  IMPROVEMENT_LIFECYCLES.includes(value.lifecycle as ImprovementLifecycle) &&
  record(value.proposal) &&
  Array.isArray(value.deliveries);

export const parseImprovementList = (body: unknown) =>
  shaped<ImprovementList>(
    body,
    "improvement list",
    (b) =>
      Array.isArray(b.items) &&
      b.items.every(isItem) &&
      record(b.counts) &&
      Array.isArray(b.repositories) &&
      typeof b.matching === "number",
  );

export const parseImprovementDetail = (body: unknown) =>
  shaped<ImprovementDetail>(
    body,
    "improvement",
    (b) =>
      isItem(b.item) &&
      Array.isArray(b.evidence) &&
      Array.isArray(b.destinations) &&
      Array.isArray(b.candidates) &&
      Array.isArray(b.decisions),
  );

export const parseFollowThrough = (body: unknown) =>
  shaped<ImprovementFollowThroughDetail>(
    body,
    "follow-through",
    (b) =>
      record(b.followThrough) &&
      typeof b.followThrough.attention === "string" &&
      typeof b.followThrough.version === "number" &&
      Array.isArray(b.outcomes) &&
      Array.isArray(b.actions),
  );

export const parseAttention = (body: unknown) =>
  shaped<ImprovementAttention>(
    body,
    "attention",
    (b) =>
      record(b.counts) &&
      typeof b.counts.total === "number" &&
      Array.isArray(b.items) &&
      Array.isArray(b.activity),
  );

export const parseRetroHistory = (body: unknown) =>
  shaped<RetroHistory>(
    body,
    "retro history",
    (b) => Array.isArray(b.retros) && typeof b.total === "number",
  );

export const parseRetroReport = (body: unknown) =>
  shaped<RetroReportResponse>(
    body,
    "retro report",
    (b) =>
      record(b.retro) &&
      typeof b.retro.id === "string" &&
      record(b.current) &&
      (b.report === null || (record(b.report) && Array.isArray(b.report.items))),
  );

export const parseRetroItemEvidence = (body: unknown) =>
  shaped<RetroItemEvidence>(
    body,
    "retro item evidence",
    (b) => typeof b.itemId === "string" && Array.isArray(b.evidence),
  );

export const parseRetroSchedule = (body: unknown) =>
  shaped<RetroSchedule>(
    body,
    "retro schedule",
    (b) => typeof b.canRun === "boolean" && typeof b.state === "string",
  );

export function parseOutcome(body: unknown): ImprovementOutcome | null {
  if (!record(body)) return null;
  if (typeof body.status === "string") return body as ImprovementOutcome;
  if (typeof body.error === "string")
    return {
      status: "error",
      message: body.error,
      ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
    };
  return null;
}
