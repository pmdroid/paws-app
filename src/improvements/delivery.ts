import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  claimableImprovementDeliveriesSteps,
  claimImprovementDeliverySteps,
  getImprovementSteps,
  improvementDeliveryWorkspacesSteps,
  listImprovementDeliveriesSteps,
  listRetroEvidenceSteps,
  listRetroItemsSteps,
  listWorkspaceRepositoriesSteps,
  markReviewFindingFiledSteps,
  reserveImprovementDeliveryRemoteSteps,
  settleImprovementDeliverySteps,
  sqliteDb,
  workspaceMemberSteps,
  type Db,
  type Improvement,
  type ImprovementDelivery,
  type ImprovementDeliveryBlock,
  type Q,
  type Steps,
} from "../db";
import { journalCaught } from "../journal";
import { improvementFindingsSteps } from "./daily";

export type DeliveryFailure = {
  ok: false;
  failure: "rate_limited" | "unauthorized" | "unavailable" | "unknown";
  retryAfterMs?: number;
  message: string;
};
type Result<T> = { ok: true; value: T } | DeliveryFailure;
export type DeliveryIssue = {
  id: string;
  identifier: string;
  url: string | null;
  teamId: string;
  state: "open" | "closed";
  description?: string | null;
};

export type ImprovementDeliveryLinear = {
  findIssue(id: string): Promise<Result<DeliveryIssue | null>>;
  createIssue(input: {
    id: string;
    teamId: string;
    title: string;
    description: string;
    label: string;
  }): Promise<Result<DeliveryIssue>>;
  findComment(id: string): Promise<Result<{ id: string; issueId: string } | null>>;
  createComment(input: {
    id: string;
    issueId: string;
    body: string;
  }): Promise<Result<{ id: string; issueId: string }>>;
};

export const IMPROVEMENT_DELIVERY_LIMITS = {
  leaseMs: 120_000,
  maxAttempts: 8,
  backoffMs: 30_000,
  maxBackoffMs: 60 * 60_000,
  intervalMs: 15_000,
} as const;

export const IMPROVEMENT_ISSUE_LABELS = {
  daily_finding: "review finding",
  retro_item: "paws retro",
} as const;

function uuid(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex");
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export const improvementIssueUuid = (workspaceId: string, improvementId: string) =>
  uuid(`paws:improvement:${workspaceId}:${improvementId}:create_issue`);
export const improvementCommentUuid = (workspaceId: string, improvementId: string) =>
  uuid(`paws:improvement:${workspaceId}:${improvementId}:evidence_comment`);

// Written into every issue Paws creates. An issue found under the deterministic id is
// recorded only when it carries this marker for the same workspace, improvement and repository.
export const improvementIssueMarker = (improvement: Improvement) =>
  `paws-improvement:${improvement.workspaceId}:${improvement.id}:${improvement.repository.toLowerCase()}`;

type FrozenContent = {
  proposalVersion: number;
  repository: string;
  sourceKind: "daily_finding" | "retro_item";
  sourceKeys: string[];
  title: string;
  problem: string;
  proposedChange: string;
  actionStep: string;
  verificationCriterion: string | null;
  evidence: string[];
  issue?: { id?: string; teamId?: string; state?: "open" | "closed" };
};

const STEP = {
  automatic: "Automatic",
  rule: "Rule",
  convention: "Convention",
  decision: "Decision",
  issue: "Issue",
} as Record<string, string>;

function codeSpan(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  const fence = "`".repeat(
    (line.match(/`+/g) ?? []).reduce((n, run) => Math.max(n, run.length), 0) + 1,
  );
  const pad = line.startsWith("`") || line.endsWith("`") ? " " : "";
  return `${fence}${pad}${line}${pad}${fence}`;
}

function* evidenceLines(q: Q, improvement: Improvement, content: FrozenContent): Steps<string[]> {
  if (content.sourceKind === "daily_finding") {
    const frozen = new Set(content.evidence);
    const findings = (yield* improvementFindingsSteps(q, improvement.id)).filter((f) =>
      frozen.has(`review_finding:${f.key}`),
    );
    return [
      `${content.evidence.length} review finding${content.evidence.length === 1 ? "" : "s"}:`,
      ...findings
        .slice(0, 20)
        .map((f) => `- ${codeSpan(`${f.path}${f.lines ? `:${f.lines}` : ""}`)} (${f.severity})`),
    ];
  }
  const counts = new Map<string, number>();
  const byRetro = new Map<string, Map<string, string>>();
  for (const ref of content.evidence) {
    const [, retroId = "", evidenceId = ""] = ref.split(":");
    if (!byRetro.has(retroId))
      byRetro.set(
        retroId,
        new Map(
          (yield* listRetroEvidenceSteps(q, retroId)).map((e) => [e.evidenceId, e.sourceRef]),
        ),
      );
    const source = byRetro.get(retroId)!.get(evidenceId) ?? evidenceId;
    counts.set(source, (counts.get(source) ?? 0) + 1);
  }
  return [
    `${content.evidence.length} evidence excerpt${content.evidence.length === 1 ? "" : "s"} from ${counts.size} source${counts.size === 1 ? "" : "s"}:`,
    ...[...counts].slice(0, 20).map(([source, count]) => `- ${codeSpan(source)}: ${count}`),
  ];
}

function* area(q: Q, improvement: Improvement, content: FrozenContent): Steps<string | null> {
  if (content.sourceKind !== "retro_item") return null;
  for (const key of content.sourceKeys) {
    const item = (yield* listRetroItemsSteps(q, key.split("/")[0] ?? "")).find(
      (entry) => entry.improvementId === improvement.id,
    );
    if (item) return item.area;
  }
  return null;
}

function* improvementIssueBody(
  q: Q,
  improvement: Improvement,
  content: FrozenContent,
  sourceUrl: string,
): Steps<string> {
  const where = yield* area(q, improvement, content);
  const accepted = improvement.reviewedBy
    ? ((yield* workspaceMemberSteps(q, improvement.workspaceId, improvement.reviewedBy))?.name ??
      null)
    : null;
  const evidence = yield* evidenceLines(q, improvement, content);
  return [
    `**Repository:** ${codeSpan(content.repository)}${where ? ` · **Area:** ${codeSpan(where)}` : ""}`,
    `**Source:** ${content.sourceKind === "retro_item" ? "Weekly retro" : "Daily review findings"} · **Action step:** ${STEP[content.actionStep] ?? content.actionStep}`,
    "## Problem",
    content.problem,
    "## Remaining work",
    content.proposedChange || content.title,
    "## Verification criterion",
    content.verificationCriterion ?? "Not recorded.",
    "## Evidence",
    evidence.join("\n"),
    `[Open the improvement in Paws](${sourceUrl}) · proposal version ${content.proposalVersion}`,
    `Filed by Paws from an improvement${accepted ? ` accepted by ${accepted}` : " accepted in Paws"}. Paws has not delegated this issue.`,
    `Paws reference: ${codeSpan(improvementIssueMarker(improvement))}`,
  ].join("\n\n");
}

function* improvementEvidenceComment(
  q: Q,
  improvement: Improvement,
  content: FrozenContent,
  sourceUrl: string,
): Steps<string> {
  const evidence = yield* evidenceLines(q, improvement, content);
  return [
    `New evidence for this issue from a Paws ${content.sourceKind === "retro_item" ? "weekly retro" : "daily review"} (${codeSpan(content.repository)}).`,
    `**${content.title}**`,
    content.problem,
    `**Verification criterion:** ${content.verificationCriterion ?? "Not recorded."}`,
    evidence.join("\n"),
    `[Open the improvement in Paws](${sourceUrl}). Linking does not mean this issue covers the new scope.`,
  ].join("\n\n");
}

type Context = {
  store: Db;
  owner: string;
  now: () => number;
  sourceUrl: (improvementId: string) => string;
  limits: typeof IMPROVEMENT_DELIVERY_LIMITS;
};

async function mapped(store: Db, improvement: Improvement, teamId: string | null) {
  if (teamId === null) return false;
  const repositories = await store.run((q) =>
    listWorkspaceRepositoriesSteps(q, improvement.workspaceId),
  );
  return repositories.some(
    (entry) =>
      entry.teamId === teamId &&
      entry.repository.toLowerCase() === improvement.repository.toLowerCase(),
  );
}

function* markSourcesFiledSteps(q: Q, improvement: Improvement, identifier: string, now: number) {
  for (const finding of yield* improvementFindingsSteps(q, improvement.id))
    if (finding.status === "open")
      yield* markReviewFindingFiledSteps(q, {
        key: finding.key,
        issue: identifier,
        by: improvement.reviewedBy,
        now,
      });
}

async function deliverOne(
  ctx: Context,
  linear: ImprovementDeliveryLinear | null,
  delivery: ImprovementDelivery,
): Promise<void> {
  const { store } = ctx;
  if (delivery.operation === "evidence_comment") {
    const link = (
      await store.run((q) => listImprovementDeliveriesSteps(q, delivery.improvementId))
    ).find((d) => d.operation === "link_issue");
    if (link?.state !== "succeeded") return;
  }
  const claimedAt = ctx.now();
  const claimed = await store.transaction((q) =>
    claimImprovementDeliverySteps(q, {
      deliveryId: delivery.id,
      owner: ctx.owner,
      now: claimedAt,
      leaseMs: ctx.limits.leaseMs,
    }),
  );
  if (!claimed) return;
  const attempt = claimed.attempts;
  const improvement = (await store.run((q) => getImprovementSteps(q, claimed.improvementId)))!;
  const content = (claimed.content ?? {}) as FrozenContent;
  const base = { deliveryId: claimed.id, attempt, owner: ctx.owner };
  let uncertain = claimed.remoteId !== null;

  const succeed = async (remote: { id: string; identifier?: string; url?: string | null }) => {
    const now = ctx.now();
    await store.transaction(function* (q) {
      const settled = yield* q.transaction((tx) =>
        settleImprovementDeliverySteps(tx, {
          ...base,
          outcome: "succeeded",
          remote: {
            id: remote.id,
            ...(remote.identifier ? { identifier: remote.identifier } : {}),
            ...(remote.url ? { url: remote.url } : {}),
          },
          now,
        }),
      );
      if (settled && remote.identifier && claimed.operation !== "evidence_comment")
        yield* markSourcesFiledSteps(q, improvement, remote.identifier, now);
    });
  };
  const settle = (settlement: Parameters<typeof settleImprovementDeliverySteps>[1]) =>
    store.transaction((q) => settleImprovementDeliverySteps(q, settlement));
  const block = async (blocked: ImprovementDeliveryBlock, error: string) => {
    await settle({
      ...base,
      outcome: uncertain ? "unknown" : "failed",
      blocked,
      error,
      now: ctx.now(),
    });
  };
  const fail = async (result: DeliveryFailure) => {
    const outcome = uncertain || result.failure === "unknown" ? "unknown" : "failed";
    const now = ctx.now();
    const tries = attempt - claimed.retryBase;
    const exhausted = tries >= ctx.limits.maxAttempts;
    const wait = Math.max(
      result.retryAfterMs ?? 0,
      Math.min(ctx.limits.backoffMs * 2 ** Math.max(0, tries - 1), ctx.limits.maxBackoffMs),
    );
    const blocked: ImprovementDeliveryBlock | undefined =
      result.failure === "unauthorized" ? "unauthorized" : exhausted ? "attempts" : undefined;
    await settle({
      ...base,
      outcome,
      error: result.message.slice(0, 500),
      retryAt: now + wait,
      ...(blocked ? { blocked } : {}),
      now,
    });
  };

  if (improvement.reviewState !== "accepted")
    return block("conflict", "The improvement is no longer accepted.");
  if (!linear)
    return block("workspace", "Linear is not connected for this improvement's workspace.");

  if (claimed.operation === "create_issue") {
    const id = improvementIssueUuid(improvement.workspaceId, improvement.id);
    if (claimed.remoteId !== null && claimed.remoteId !== id)
      return block("conflict", "The reserved Linear id does not match this improvement.");
    const authorized = await mapped(store, improvement, claimed.targetTeamId);
    if (!uncertain && !authorized)
      return block(
        "destination",
        "The chosen Linear team is no longer mapped to this repository. Choose another team or restore the mapping.",
      );
    const found = await linear.findIssue(id);
    if (!found.ok) return fail(found);
    if (found.value) {
      if (found.value.teamId !== claimed.targetTeamId)
        return block(
          "conflict",
          "Linear holds this improvement's issue id in a different team. Paws did not link it.",
        );
      if (!found.value.description?.includes(improvementIssueMarker(improvement)))
        return block(
          "conflict",
          "Linear holds this improvement's issue id on an issue Paws cannot match to this improvement. Paws did not link it.",
        );
      return succeed(found.value);
    }
    if (!authorized)
      return block(
        "destination",
        "The chosen Linear team is no longer mapped to this repository. Paws keeps checking the same issue id.",
      );
    if (
      !(await store.run((q) => reserveImprovementDeliveryRemoteSteps(q, { ...base, remoteId: id })))
    )
      return;
    uncertain = true;
    const sourceUrl = ctx.sourceUrl(improvement.id);
    const description = await store.run((q) =>
      improvementIssueBody(q, improvement, content, sourceUrl),
    );
    const created = await linear.createIssue({
      id,
      teamId: claimed.targetTeamId!,
      title: content.title,
      description,
      label: IMPROVEMENT_ISSUE_LABELS[content.sourceKind] ?? IMPROVEMENT_ISSUE_LABELS.retro_item,
    });
    if (!created.ok) {
      if (created.failure !== "unknown" && claimed.remoteId === null) uncertain = false;
      return fail(created);
    }
    return succeed(created.value);
  }

  const target = claimed.targetIssueId!;
  // The reviewer was authorized for this team when they accepted; delivery never follows
  // the issue anywhere else, and a target that closed since then needs a new review choice.
  const frozenTeam = claimed.targetTeamId ?? content.issue?.teamId ?? null;
  const remedy =
    claimed.operation === "link_issue"
      ? "Reopen the improvement to choose again."
      : "Cancel the evidence comment; the link stays.";
  const linkRefusal = async (
    issue: DeliveryIssue | null,
  ): Promise<(() => Promise<void>) | null> => {
    if (!issue)
      return () =>
        block("unavailable", `The linked issue no longer exists or Paws cannot read it. ${remedy}`);
    if (frozenTeam === null)
      return () =>
        block("destination", `This link was accepted before Paws recorded its team. ${remedy}`);
    if (issue.teamId !== frozenTeam)
      return () =>
        block(
          "destination",
          `The linked issue moved to another team after it was accepted. ${remedy}`,
        );
    if (!(await mapped(store, improvement, issue.teamId)))
      return () =>
        block(
          "destination",
          `The linked issue's team is no longer mapped to this repository. ${remedy}`,
        );
    if (issue.state === "closed" && content.issue?.state !== "closed")
      return () =>
        block("conflict", `The linked issue was closed after it was accepted. ${remedy}`);
    return null;
  };
  if (claimed.operation === "link_issue") {
    const found = await linear.findIssue(target);
    if (!found.ok) return fail(found);
    const refused = await linkRefusal(found.value);
    if (refused) return refused();
    return succeed(found.value!);
  }

  const commentId = improvementCommentUuid(improvement.workspaceId, improvement.id);
  const existing = await linear.findComment(commentId);
  if (!existing.ok) return fail(existing);
  if (existing.value) {
    if (existing.value.issueId !== target)
      return block("conflict", "Linear holds this evidence comment id on another issue.");
    return succeed({ id: commentId });
  }
  const issue = await linear.findIssue(target);
  if (!issue.ok) return fail(issue);
  const refused = await linkRefusal(issue.value);
  if (refused) return refused();
  if (
    !(await store.run((q) =>
      reserveImprovementDeliveryRemoteSteps(q, { ...base, remoteId: commentId }),
    ))
  )
    return;
  const wasUncertain = uncertain;
  uncertain = true;
  const sourceUrl = ctx.sourceUrl(improvement.id);
  const body = await store.run((q) =>
    improvementEvidenceComment(q, improvement, content, sourceUrl),
  );
  const posted = await linear.createComment({ id: commentId, issueId: target, body });
  if (!posted.ok) {
    if (posted.failure !== "unknown" && !wasUncertain) uncertain = false;
    return fail(posted);
  }
  await succeed({ id: commentId });
}

export type ImprovementDeliveryOptions = {
  db: Database;
  owner: string;
  linearFor: (workspaceId: string) => Promise<ImprovementDeliveryLinear | null>;
  sourceUrl: (improvementId: string) => string;
  now?: () => number;
  limits?: Partial<typeof IMPROVEMENT_DELIVERY_LIMITS>;
};

export async function deliverImprovements(options: ImprovementDeliveryOptions): Promise<void> {
  const ctx: Context = {
    store: sqliteDb(options.db),
    owner: options.owner,
    now: options.now ?? Date.now,
    sourceUrl: options.sourceUrl,
    limits: { ...IMPROVEMENT_DELIVERY_LIMITS, ...options.limits },
  };
  const { store } = ctx;
  const startedAt = ctx.now();
  for (const workspaceId of await store.run((q) =>
    improvementDeliveryWorkspacesSteps(q, startedAt),
  )) {
    const linear = await options.linearFor(workspaceId);
    const now = ctx.now();
    const pending = await store.run((q) =>
      claimableImprovementDeliveriesSteps(q, workspaceId, now),
    );
    for (const operation of ["create_issue", "link_issue", "evidence_comment"] as const)
      for (const delivery of pending.filter((d) => d.operation === operation))
        await deliverOne(ctx, linear, delivery).catch((error: unknown) => {
          journalCaught(error, "improvements.deliverImprovements", null);
        });
  }
}

export function startImprovementDeliveries(
  options: ImprovementDeliveryOptions & { signal: AbortSignal },
): void {
  let running = false;
  const tick = () => {
    if (running || options.signal.aborted) return;
    running = true;
    void deliverImprovements(options)
      .catch((error: unknown) =>
        journalCaught(error, "improvements.startImprovementDeliveries", null),
      )
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(
    tick,
    options.limits?.intervalMs ?? IMPROVEMENT_DELIVERY_LIMITS.intervalMs,
  );
  timer.unref?.();
  options.signal.addEventListener("abort", () => clearInterval(timer));
  tick();
}
