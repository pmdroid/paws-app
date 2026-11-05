import { z } from "zod";
import type { Database } from "bun:sqlite";
import { auditWorkspaceAccess, workspaceMember, workspaceMemberUsable } from "../db";
import { journalCaught } from "../journal";
import type { WorkspacePrincipal } from "../workspace";
import {
  cancelInboxEvidenceComment,
  decideInboxItem,
  improvementDetail,
  IMPROVEMENT_REVIEW_LIMITS,
  listImprovementPage,
  memberRepositories,
  repairInboxDestination,
  retryInboxDelivery,
  type ImprovementReviewer,
  type IssueLookup,
} from "./review";
import {
  delegateImprovement,
  improvementAttention,
  improvementFollowThrough,
  IMPROVEMENT_OUTCOME_LIMITS,
  recordCriterion,
  recordVerification,
  recoverImprovement,
  type IssueReader,
  type StartIssueSession,
} from "./outcomes";

export const IMPROVEMENTS_PATH = "/api/improvements";
const BODY_LIMIT = 16 * 1024;
const ITEM = /^\/api\/improvements\/([0-9A-Za-z]{1,64})$/;
const DECISION = /^\/api\/improvements\/([0-9A-Za-z]{1,64})\/decision$/;
const RETRY = /^\/api\/improvements\/([0-9A-Za-z]{1,64})\/deliveries\/([0-9a-f-]{36})\/retry$/;
const CANCEL = /^\/api\/improvements\/([0-9A-Za-z]{1,64})\/deliveries\/([0-9a-f-]{36})\/cancel$/;
const ATTENTION = "/api/improvements/attention";
const FOLLOW_THROUGH = /^\/api\/improvements\/([0-9A-Za-z]{1,64})\/follow-through$/;
const FOLLOW_ACTIONS = {
  delegate: /^\/api\/improvements\/([0-9A-Za-z]{1,64})\/delegate$/,
  verification: /^\/api\/improvements\/([0-9A-Za-z]{1,64})\/verification$/,
  criterion: /^\/api\/improvements\/([0-9A-Za-z]{1,64})\/criterion$/,
  recovery: /^\/api\/improvements\/([0-9A-Za-z]{1,64})\/recovery$/,
};
const DESTINATION =
  /^\/api\/improvements\/([0-9A-Za-z]{1,64})\/deliveries\/([0-9a-f-]{36})\/destination$/;

export type RetroEvidenceReader = (
  principal: WorkspacePrincipal,
  sessionIds: readonly string[],
  retroId: string,
) => ReadonlySet<string> | null;

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const text = (max: number) => z.string().trim().min(1).max(max);
const decisionSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
  decision: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("accept"),
      proposalVersion: z.number().int().min(1),
      verificationCriterion: text(IMPROVEMENT_REVIEW_LIMITS.criterion).optional(),
      intent: z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("create"), teamId: text(200) }),
        z.strictObject({
          kind: z.literal("link"),
          issue: text(200),
          addEvidenceComment: z.boolean().optional(),
          allowClosed: z.boolean().optional(),
        }),
      ]),
    }),
    z.strictObject({ kind: z.literal("reject"), reason: text(IMPROVEMENT_REVIEW_LIMITS.reason) }),
    z.strictObject({ kind: z.literal("reopen") }),
  ]),
});

const versioned = { expectedVersion: z.number().int().min(1) };
const verificationSchema = z.strictObject({
  ...versioned,
  outcome: z.enum(["verified", "contradicted"]),
  check: text(IMPROVEMENT_OUTCOME_LIMITS.check),
  result: text(IMPROVEMENT_OUTCOME_LIMITS.result),
  revision: z.string().trim().min(7).max(40).optional(),
  deployment: text(IMPROVEMENT_OUTCOME_LIMITS.deployment).optional(),
  evidence: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("closeout_step"), progressId: text(100), stepId: text(200) }),
    z.strictObject({
      kind: z.literal("attestation"),
      url: z
        .url({ protocol: /^https$/ })
        .max(2000)
        .optional(),
    }),
  ]),
});
const criterionSchema = z.strictObject({
  ...versioned,
  criterion: text(IMPROVEMENT_REVIEW_LIMITS.criterion),
});
const recoverySchema = z.strictObject({
  ...versioned,
  choice: z.enum(["acknowledge", "redelegate", "return_to_review"]),
  reason: text(IMPROVEMENT_OUTCOME_LIMITS.reason),
});

const listSchema = z.strictObject({
  source: z.enum(["daily", "weekly"]).optional(),
  repository: z.string().min(1).max(200).optional(),
  state: z.enum(["needs_review", "pending", "linked", "rejected"]).optional(),
  cursor: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(IMPROVEMENT_REVIEW_LIMITS.maxPageSize).optional(),
});

const OUTCOME_STATUS = {
  decided: 200,
  unchanged: 200,
  conflict: 409,
  not_found: 404,
  invalid: 400,
  forbidden: 403,
  unavailable: 503,
  requeued: 202,
  in_progress: 200,
  succeeded: 200,
  cancelled: 200,
  delegated: 201,
  existing: 200,
  recorded: 200,
  failed: 502,
} as const;

export function createImprovementsHttp(options: {
  db: Database;
  lookup?: IssueLookup;
  retroEvidence?: RetroEvidenceReader;
  linear?: IssueReader;
  startSession?: StartIssueSession;
  dashboardUrl?: string;
  now?: () => number;
}) {
  const { db } = options;
  const now = options.now ?? Date.now;
  const audit = (principal: WorkspacePrincipal, action: string, subject: string) =>
    auditWorkspaceAccess(db, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      action,
      subject,
      now: now(),
    });

  async function readBody(request: Request): Promise<unknown> {
    if (Number(request.headers.get("content-length") ?? 0) > BODY_LIMIT)
      throw new RangeError("too large");
    const body = await request.text();
    if (body.length > BODY_LIMIT) throw new RangeError("too large");
    return JSON.parse(body);
  }

  return async (
    request: Request,
    principal: WorkspacePrincipal,
    sessionIds: readonly string[],
  ): Promise<Response | null> => {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path !== IMPROVEMENTS_PATH && !path.startsWith(`${IMPROVEMENTS_PATH}/`)) return null;
    const reviewerFor = (): ImprovementReviewer | null => {
      const member = workspaceMember(db, principal.workspaceId, principal.userId);
      if (!workspaceMemberUsable(member)) return null;
      const evidence = new Map<string, ReadonlySet<string> | null>();
      return {
        workspaceId: principal.workspaceId,
        repositories: memberRepositories(db, principal.workspaceId, principal.userId),
        sessionIds,
        userId: principal.userId,
        role: member.role,
        teamIds: member.teamIds,
        ...(options.retroEvidence
          ? {
              retroEvidence: (retroId: string) => {
                if (!evidence.has(retroId))
                  evidence.set(retroId, options.retroEvidence!(principal, sessionIds, retroId));
                return evidence.get(retroId)!;
              },
            }
          : {}),
      };
    };
    const reviewer = reviewerFor();
    if (!reviewer) {
      audit(principal, "access.denied", path);
      return json({ error: "Workspace access is unavailable." }, 403);
    }

    if (path === IMPROVEMENTS_PATH) {
      if (request.method !== "GET") return json({ error: "Use GET." }, 405);
      const query = listSchema.safeParse(Object.fromEntries(url.searchParams));
      if (!query.success) return json({ error: "Check the list filters." }, 400);
      return json(listImprovementPage(db, reviewer, query.data));
    }
    if (path === ATTENTION) {
      if (request.method !== "GET") return json({ error: "Use GET." }, 405);
      return json(improvementAttention(db, reviewer, now()));
    }
    const followed = FOLLOW_THROUGH.exec(path);
    if (followed) {
      if (request.method !== "GET") return json({ error: "Use GET." }, 405);
      const detail = improvementFollowThrough(db, reviewer, followed[1]!, now());
      return detail
        ? json(detail)
        : json({ error: "This improvement is not in your inbox.", reason: "not_found" }, 404);
    }
    const follow = Object.entries(FOLLOW_ACTIONS)
      .map(([action, pattern]) => ({ action, match: pattern.exec(path) }))
      .find((entry) => entry.match !== null);
    if (follow) {
      if (request.method !== "POST") return json({ error: "Use POST." }, 405);
      let body: unknown;
      try {
        body = await readBody(request);
      } catch (error) {
        if (error instanceof RangeError) return json({ error: "Send at most 16 KiB." }, 413);
        journalCaught(error, "improvements.http.readFollowThrough", null);
        return json({ error: "Expected a JSON body." }, 400);
      }
      const actor = reviewerFor();
      if (!actor) {
        audit(principal, "access.denied", path);
        return json({ error: "Workspace access is unavailable." }, 403);
      }
      const improvementId = follow.match![1]!;
      const action = follow.action;
      const respond = (outcome: Awaited<ReturnType<typeof delegateImprovement>>) => {
        if (outcome.status === "forbidden") audit(principal, "access.denied", path);
        else if (["delegated", "recorded"].includes(outcome.status))
          audit(principal, `improvement.${action}`, improvementId);
        return json(outcome, OUTCOME_STATUS[outcome.status]);
      };
      const delegate = (expectedVersion: number, again: boolean) =>
        delegateImprovement(db, {
          reviewer: actor,
          reauthorize: reviewerFor,
          improvementId,
          expectedVersion,
          ...(options.linear ? { linear: options.linear } : {}),
          ...(options.startSession ? { startSession: options.startSession } : {}),
          dashboardUrl: options.dashboardUrl ?? url.origin,
          ...(again ? { again } : {}),
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
          now,
        });
      if (action === "delegate") {
        const parsed = z.strictObject(versioned).safeParse(body);
        if (!parsed.success) return json({ error: "Send expectedVersion." }, 400);
        return respond(await delegate(parsed.data.expectedVersion, false));
      }
      if (action === "verification") {
        const parsed = verificationSchema.safeParse(body);
        if (!parsed.success)
          return json(
            {
              error:
                "Send expectedVersion, outcome, the check and its result, a revision or deployment, and the evidence.",
            },
            400,
          );
        const { expectedVersion, evidence, revision, deployment, ...stated } = parsed.data;
        return respond(
          recordVerification(db, {
            access: actor,
            improvementId,
            expectedVersion,
            request: {
              ...stated,
              evidence:
                evidence.kind === "attestation"
                  ? { kind: "attestation", ...(evidence.url ? { url: evidence.url } : {}) }
                  : evidence,
              ...(revision ? { revision } : {}),
              ...(deployment ? { deployment } : {}),
            },
            now: now(),
          }),
        );
      }
      if (action === "criterion") {
        const parsed = criterionSchema.safeParse(body);
        if (!parsed.success) return json({ error: "Send expectedVersion and the criterion." }, 400);
        return respond(
          recordCriterion(db, {
            access: actor,
            improvementId,
            expectedVersion: parsed.data.expectedVersion,
            criterion: parsed.data.criterion,
            now: now(),
          }),
        );
      }
      const parsed = recoverySchema.safeParse(body);
      if (!parsed.success)
        return json({ error: "Send expectedVersion, a recovery choice and a reason." }, 400);
      if (parsed.data.choice === "redelegate")
        return respond(await delegate(parsed.data.expectedVersion, true));
      return respond(
        recoverImprovement(db, {
          access: actor,
          improvementId,
          expectedVersion: parsed.data.expectedVersion,
          choice: parsed.data.choice,
          reason: parsed.data.reason,
          now: now(),
        }),
      );
    }
    const item = ITEM.exec(path);
    if (item) {
      if (request.method !== "GET") return json({ error: "Use GET." }, 405);
      const detail = improvementDetail(db, reviewer, item[1]!);
      return detail
        ? json(detail)
        : json({ error: "This improvement is not in your inbox.", reason: "not_found" }, 404);
    }
    const decision = DECISION.exec(path);
    const retry = RETRY.exec(path);
    const cancel = CANCEL.exec(path);
    const destination = DESTINATION.exec(path);
    if (!decision && !retry && !cancel && !destination)
      return json({ error: "Not found.", reason: "not_found" }, 404);
    if (request.method !== "POST") return json({ error: "Use POST." }, 405);
    if (retry) {
      const outcome = retryInboxDelivery(db, {
        access: reviewer,
        improvementId: retry[1]!,
        deliveryId: retry[2]!,
        now: now(),
      });
      if (outcome.status === "requeued") audit(principal, "improvement.delivery.retry", retry[2]!);
      return json(outcome, OUTCOME_STATUS[outcome.status]);
    }
    if (cancel) {
      const outcome = cancelInboxEvidenceComment(db, {
        access: reviewer,
        improvementId: cancel[1]!,
        deliveryId: cancel[2]!,
      });
      if (outcome.status === "cancelled")
        audit(principal, "improvement.delivery.cancel", cancel[2]!);
      return json(outcome, OUTCOME_STATUS[outcome.status]);
    }
    let body: unknown;
    try {
      body = await readBody(request);
    } catch (error) {
      if (error instanceof RangeError) return json({ error: "Send at most 16 KiB." }, 413);
      journalCaught(error, "improvements.http.readJson", null);
      return json({ error: "Expected a JSON body." }, 400);
    }
    if (destination) {
      const team = z.strictObject({ teamId: text(200) }).safeParse(body);
      if (!team.success) return json({ error: "Send the Linear teamId to file to." }, 400);
      const outcome = repairInboxDestination(db, {
        reviewer,
        improvementId: destination[1]!,
        deliveryId: destination[2]!,
        teamId: team.data.teamId,
        now: now(),
      });
      if (outcome.status === "requeued")
        audit(principal, "improvement.delivery.destination", destination[2]!);
      if (outcome.status === "forbidden") audit(principal, "access.denied", path);
      return json(outcome, OUTCOME_STATUS[outcome.status]);
    }
    const parsed = decisionSchema.safeParse(body);
    if (!parsed.success)
      return json(
        {
          error:
            "Send expectedVersion and one decision: accept with a create or link intent, reject with a reason, or reopen.",
        },
        400,
      );
    const outcome = await decideInboxItem(db, {
      reviewer,
      reauthorize: reviewerFor,
      improvementId: decision![1]!,
      expectedVersion: parsed.data.expectedVersion,
      request: parsed.data.decision,
      ...(options.lookup ? { lookup: options.lookup } : {}),
      signal: request.signal,
      now,
    });
    if (outcome.status === "decided")
      audit(principal, `improvement.${parsed.data.decision.kind}`, decision![1]!);
    if (outcome.status === "forbidden") audit(principal, "access.denied", path);
    return json(outcome, OUTCOME_STATUS[outcome.status]);
  };
}
