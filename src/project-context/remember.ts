import {
  contextSourceRestriction,
  currentSourceContextRecords,
  type ContextNamespace,
  type ContextRecordRow,
  type Db,
} from "../db";
import { z } from "zod";
import { canSee, requesterAccess, type ContextAccess } from "./policy";
import { contextKey, sanitizedContextText } from "./sanitize";
import { recordWorkItemContext } from "./session";
import { CONTEXT_CLAIM_LIMITS } from "./store";

export const PROJECT_MEMORY_UNAVAILABLE = "Project memory is not available for this task.";

export const REMEMBER_ENTRIES_PER_ITEM = 10;

const OperationsSchema = z
  .array(
    z
      .strictObject({
        action: z.enum(["add", "patch", "remove"]),
        kind: z.enum(["fact", "open_question"]),
        content: z.string().min(1).max(400).optional(),
        old_text: z.string().min(1).max(4000).optional(),
      })
      .refine((operation) => operation.action === "remove" || operation.content !== undefined, {
        message: "content is required for add and patch",
        path: ["content"],
      })
      .refine((operation) => operation.action === "add" || operation.old_text !== undefined, {
        message: "old_text is required for patch and remove",
        path: ["old_text"],
      }),
  )
  .min(1)
  .max(5);

type Operation = z.infer<typeof OperationsSchema>[number];

type MemoryKind = Operation["kind"];

const CLASSIFICATION = {
  fact: "reported_fact",
  open_question: "unresolved_question",
} as const;

const KIND: Partial<Record<ContextRecordRow["classification"], MemoryKind>> = {
  reported_fact: "fact",
  unresolved_question: "open_question",
};

type Memory = { kind: MemoryKind; content: string; key: string; row?: ContextRecordRow };

function memoryKey(kind: MemoryKind, content: string): string {
  return contextKey("observation", `${CLASSIFICATION[kind]}\0${content}`);
}

export type RememberRequest = {
  readonly workItemId: string;
  readonly organizationId: string;
  readonly projectId: string | null;
  readonly requesterId: string | null;
  readonly url?: string | null;
  readonly operations: unknown;
  readonly now: number;
};

function listing(memories: readonly Memory[]): string {
  if (memories.length === 0) return "(none)";
  return memories.map((memory) => `- [${memory.kind}] ${memory.content}`).join("\n");
}

function apply(before: readonly Memory[], operations: readonly Operation[]): Memory[] {
  const memories = [...before];
  for (const operation of operations) {
    const content =
      operation.content === undefined
        ? undefined
        : sanitizedContextText(operation.content, CONTEXT_CLAIM_LIMITS.bytes.observation);
    if (content === "") throw new Error("Not saved: content is empty after cleaning.");
    if (operation.action !== "add") {
      const matches = memories.filter((memory) => memory.content === operation.old_text);
      if (matches.length !== 1)
        throw new Error(
          `Not saved: old_text must match exactly one entry this task saved, and it matches ${matches.length}. Current entries:\n${listing(before)}`,
        );
      memories.splice(memories.indexOf(matches[0]!), 1);
      if (operation.action === "remove") continue;
    }
    const key = memoryKey(operation.kind, content!);
    if (memories.some((memory) => memory.key === key)) continue;
    if (memories.length >= REMEMBER_ENTRIES_PER_ITEM)
      throw new Error(
        `Not saved: this task already holds ${REMEMBER_ENTRIES_PER_ITEM} entries, the most allowed. Remove or patch one in the same call. Current entries:\n${listing(before)}`,
      );
    memories.push({ kind: operation.kind, content: content!, key });
  }
  return memories;
}

const remembering = new Map<string, Promise<unknown>>();

export const AGENT_REVISION = "remember-";

export async function rememberWorkItemContext(
  db: Db,
  access: ContextAccess,
  request: RememberRequest,
): Promise<string> {
  const key = request.workItemId;
  const previous = remembering.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(() => rememberOnce(db, access, request));
  remembering.set(key, current);
  try {
    return await current;
  } finally {
    if (remembering.get(key) === current) remembering.delete(key);
  }
}

async function rememberOnce(
  db: Db,
  access: ContextAccess,
  request: RememberRequest,
): Promise<string> {
  const parsed = OperationsSchema.safeParse(request.operations);
  if (!parsed.success)
    throw new Error(
      `Not saved: ${parsed.error.issues
        .map((issue) => `${["operations", ...issue.path].join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  if (!request.projectId || !request.requesterId) throw new Error(PROJECT_MEMORY_UNAVAILABLE);
  const namespace: ContextNamespace = {
    workspaceId: request.organizationId,
    scopeKind: "linear_project",
    scopeId: request.projectId,
  };
  const requester = { workspaceId: request.organizationId, userId: request.requesterId };
  const project = await contextSourceRestriction(db, namespace, {
    kind: "linear_project_description",
    id: request.projectId,
  });
  const current = project?.status === "active" ? await requesterAccess(access, requester) : null;
  if (!project || !current || !canSee(current, project.restriction))
    throw new Error(PROJECT_MEMORY_UNAVAILABLE);
  const rows = await currentSourceContextRecords(
    db,
    namespace,
    { kind: "paws_work_item", id: request.workItemId },
    request.now,
  );
  const before: Memory[] = [];
  const others: ContextRecordRow[] = [];
  for (const row of rows) {
    const kind = KIND[row.classification];
    if (kind) before.push({ kind, content: row.body, key: row.recordKey, row });
    else others.push(row);
  }
  const after = apply(before, parsed.data);
  const outcome = await recordWorkItemContext(db, access, {
    namespace,
    requester,
    workItemId: request.workItemId,
    url: request.url ?? null,
    revision: `${AGENT_REVISION}${request.now}`,
    revisionAt: request.now,
    restriction: project.restriction,
    kept: [...others, ...after.flatMap((memory) => (memory.row ? [memory.row] : []))],
    entries: after
      .filter((memory) => !memory.row)
      .map((memory) => ({ classification: CLASSIFICATION[memory.kind], body: memory.content })),
    now: request.now,
  });
  if (outcome.status !== "stored") throw new Error(PROJECT_MEMORY_UNAVAILABLE);
  return `Saved. This task's project memory holds ${after.length} of ${REMEMBER_ENTRIES_PER_ITEM} entries:\n${listing(after)}`;
}
