import { z } from "zod";
import type { Database } from "bun:sqlite";
import { auditWorkspaceAccess, listWorkspaceRepositoryNames, workspaceMember } from "../db";
import { journalCaught } from "../journal";
import type { WorkspacePrincipal } from "../workspace";
import {
  decideInboxItem,
  improvementDetail,
  IMPROVEMENT_REVIEW_LIMITS,
  listImprovementPage,
  retryInboxDelivery,
  type ImprovementReviewer,
  type IssueLookup,
} from "./review";

export const IMPROVEMENTS_PATH = "/api/improvements";
const BODY_LIMIT = 16 * 1024;
const ITEM = /^\/api\/improvements\/([0-9A-Za-z]{1,64})$/;
const DECISION = /^\/api\/improvements\/([0-9A-Za-z]{1,64})\/decision$/;
const RETRY = /^\/api\/improvements\/([0-9A-Za-z]{1,64})\/deliveries\/([0-9a-f-]{36})\/retry$/;

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
} as const;

export function createImprovementsHttp(options: {
  db: Database;
  lookup?: IssueLookup;
  retroEvidence?: RetroEvidenceReader;
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
    const member = workspaceMember(db, principal.workspaceId, principal.userId);
    if (!member?.active) {
      audit(principal, "access.denied", path);
      return json({ error: "Workspace access is unavailable." }, 403);
    }
    const evidence = new Map<string, ReadonlySet<string> | null>();
    const reviewer: ImprovementReviewer = {
      workspaceId: principal.workspaceId,
      repositories: listWorkspaceRepositoryNames(db, principal.workspaceId),
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

    if (path === IMPROVEMENTS_PATH) {
      if (request.method !== "GET") return json({ error: "Use GET." }, 405);
      const query = listSchema.safeParse(Object.fromEntries(url.searchParams));
      if (!query.success) return json({ error: "Check the list filters." }, 400);
      return json(listImprovementPage(db, reviewer, query.data));
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
    if (!decision && !retry) return json({ error: "Not found.", reason: "not_found" }, 404);
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
    let body: unknown;
    try {
      body = await readBody(request);
    } catch (error) {
      if (error instanceof RangeError) return json({ error: "Send at most 16 KiB." }, 413);
      journalCaught(error, "improvements.http.readJson", null);
      return json({ error: "Expected a JSON body." }, 400);
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
