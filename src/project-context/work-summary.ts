import {
  contextSourceRestriction,
  currentSourceContextRecords,
  type ContextNamespace,
  type Db,
} from "../db";
import type { ContextAccess } from "./policy";
import { contextKey } from "./sanitize";
import { recordWorkItemContext } from "./session";

const WORK_SUMMARY_KEY = contextKey("observation", "work_summary");

export type WorkSummary = {
  readonly organizationId: string;
  readonly projectId: string;
  readonly requesterId: string;
  readonly workItemId: string;
  readonly url?: string | null;
  readonly title: string;
  readonly description: string;
  readonly now: number;
};

function workSummaryBody(title: string, description: string): string {
  const [paragraph] = description.trim().split(/\n\s*\n/);
  const first = paragraph!.trim().slice(0, 600);
  return first ? `${title.trim()}: ${first}` : title.trim();
}

export async function recordWorkSummary(
  db: Db,
  access: ContextAccess,
  input: WorkSummary,
): Promise<void> {
  const namespace: ContextNamespace = {
    workspaceId: input.organizationId,
    scopeKind: "linear_project",
    scopeId: input.projectId,
  };
  const requester = { workspaceId: input.organizationId, userId: input.requesterId };
  const project = await contextSourceRestriction(db, namespace, {
    kind: "linear_project_description",
    id: input.projectId,
  });
  if (project?.status !== "active") throw new Error("the project has no active context source");
  const rows = await currentSourceContextRecords(
    db,
    namespace,
    { kind: "paws_work_item", id: input.workItemId },
    input.now,
  );
  const outcome = await recordWorkItemContext(db, access, {
    namespace,
    requester,
    workItemId: input.workItemId,
    url: input.url ?? null,
    revision: `summary-${input.now}`,
    revisionAt: input.now,
    restriction: project.restriction,
    kept: rows.filter((row) => row.recordKey !== WORK_SUMMARY_KEY),
    entries: [
      {
        classification: "reported_fact",
        body: workSummaryBody(input.title, input.description),
        key: WORK_SUMMARY_KEY,
        importance: 0,
      },
    ],
    now: input.now,
  });
  if (outcome.status !== "stored")
    throw new Error(`project context did not store the work summary: ${outcome.status}`);
}
