import { contextSourceRestriction, type ContextNamespace, type Db } from "../db";
import { z } from "zod";
import { tokenCounter, type ContextModelBudget } from "./budget";
import { visibleContextTopics } from "./dream";
import { canSee, requesterAccess, type ContextAccess } from "./policy";
import { PROJECT_MEMORY_UNAVAILABLE } from "./remember";
import { rankContextRecords, retrieveContextDetail, type ContextDetail } from "./select";

export const RECALL_LIMITS = { tokens: 2_000, entries: 6 } as const;

export const RECALL_NO_ENTRY = "No entry with that id is available.";

export const RECALL_NO_MATCH = "No saved entries match that query.";

const RequestSchema = z
  .strictObject({
    query: z.string().min(1).max(200).optional(),
    id: z.string().min(1).max(200).optional(),
  })
  .refine((request) => (request.query === undefined) !== (request.id === undefined), {
    message: "pass exactly one of query or id",
  });

export type RecallRequest = {
  readonly organizationId: string;
  readonly projectId: string | null;
  readonly requesterId: string | null;
  readonly repository?: string;
  readonly ref?: string;
  readonly request: unknown;
  readonly model?: ContextModelBudget;
  readonly now: number;
};

export type RecallEntry = {
  id: string;
  classification: ContextDetail["record"]["classification"];
  source: ContextDetail["record"]["source"];
  body: string;
  truncated: boolean;
};

function entry(detail: ContextDetail): RecallEntry {
  return {
    id: detail.record.id,
    classification: detail.record.classification,
    source: detail.record.source,
    body: detail.body,
    truncated: detail.truncated,
  };
}

export async function recallProjectContext(
  db: Db,
  access: ContextAccess,
  request: RecallRequest,
): Promise<string> {
  const parsed = RequestSchema.safeParse(request.request);
  if (!parsed.success)
    throw new Error(
      `Not recalled: ${parsed.error.issues
        .map((issue) => (issue.path.length ? `${issue.path.join(".")}: ` : "") + issue.message)
        .join("; ")}`,
    );
  if (!request.projectId || !request.requesterId) return PROJECT_MEMORY_UNAVAILABLE;
  const namespace: ContextNamespace = {
    workspaceId: request.organizationId,
    scopeKind: "linear_project",
    scopeId: request.projectId,
  };
  const requester = { workspaceId: request.organizationId, userId: request.requesterId };
  const destination = { audience: "project_members" };
  const project = await contextSourceRestriction(db, namespace, {
    kind: "linear_project_description",
    id: request.projectId,
  });
  const current = project?.status === "active" ? await requesterAccess(access, requester) : null;
  if (!project || !current || !canSee(current, project.restriction))
    return PROJECT_MEMORY_UNAVAILABLE;
  const scope = {
    ...(request.repository ? { repository: request.repository } : {}),
    ...(request.ref ? { ref: request.ref } : {}),
  };
  const model = request.model ?? { contextTokens: 200_000 };
  const detail = (recordId: string, maxTokens: number) =>
    retrieveContextDetail(db, access, {
      namespace,
      requester,
      destination,
      recordId,
      maxTokens,
      model,
      now: request.now,
      ...scope,
    });
  if (parsed.data.id !== undefined) {
    const found = await detail(parsed.data.id, RECALL_LIMITS.tokens);
    if (found) return JSON.stringify(entry(found));
    const topic = (
      await visibleContextTopics(db, current, {
        namespace,
        audience: "project_members",
        ...scope,
        now: request.now,
      })
    ).find((candidate) => candidate.id === parsed.data.id);
    return topic
      ? JSON.stringify({ id: topic.id, topic: topic.title, body: topic.body })
      : RECALL_NO_ENTRY;
  }
  const ranking = await rankContextRecords(db, access, {
    namespace,
    requester,
    destination,
    instructions: "",
    request: parsed.data.query!,
    toolsTokens: 0,
    model,
    settings: { recentTokens: 0 },
    now: request.now,
    ...scope,
  });
  if (ranking.status !== "ok") return PROJECT_MEMORY_UNAVAILABLE;
  const count = tokenCounter(model);
  const entries: RecallEntry[] = [];
  let used = 0;
  for (const row of ranking.ranked) {
    if (entries.length >= RECALL_LIMITS.entries) break;
    const found = await detail(row.id, RECALL_LIMITS.tokens - used);
    if (!found) continue;
    const cost = count(found.body);
    if (used + cost > RECALL_LIMITS.tokens) break;
    used += cost;
    entries.push(entry(found));
  }
  return entries.length ? JSON.stringify(entries) : RECALL_NO_MATCH;
}
