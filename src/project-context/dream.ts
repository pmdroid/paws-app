import {
  contextPartition,
  contextSourceRestriction,
  contextSummaryLineage,
  listContextCandidates,
  listContextDreamTargets,
  listContextSummaries,
  markContextDreamed,
  replaceContextTopics,
  type ContextDreamTarget,
  type ContextNamespace,
  type ContextRecordRow,
  type ContextTopic,
  type Db,
} from "../db";
import { z } from "zod";
import { SummarizerTimeout, summarizeBounded, type ContextSummarizer } from "./compact";
import {
  audienceLineage,
  canSee,
  requesterAccess,
  type ContextAccess,
  type ContextAudience,
  type ContextRequesterAccess,
} from "./policy";
import { sanitizedContextText } from "./sanitize";
import { inRequestScope, sourceLabel } from "./select";
import { disclosable } from "./store";

export const CONTEXT_DREAM_JOB = "project-context.dream";

export const CONTEXT_DREAM_LIMITS = {
  checkEveryMs: 3_600_000,
  everyMs: 86_400_000,
  newRecords: 5,
  records: 120,
  recordBytes: 2_000,
  topics: 8,
  titleChars: 80,
  bodyChars: 1_500,
  scopes: 50,
  timeoutMs: 600_000,
} as const;

export const CONTEXT_DREAM_PROMPT =
  "Merge these project memory entries into a few topics. Keep decisions, constraints and open questions exactly; drop duplicates and anything superseded; don't invent facts.";

export type ContextDreamHelper = (input: {
  workspaceId: string;
  sessionId: string;
  prompt: string;
  signal: AbortSignal;
}) => Promise<{ text: string }>;

export function contextDreamSummarizer(
  helper: ContextDreamHelper,
  target: { workspaceId: string; sessionId: string },
): ContextSummarizer {
  return {
    async summarize(input, options) {
      const prompt = [
        CONTEXT_DREAM_PROMPT,
        `Reply with only JSON: {"topics":[{"title":"at most ${CONTEXT_DREAM_LIMITS.titleChars} characters","body":"at most ${CONTEXT_DREAM_LIMITS.bodyChars} characters","recordIds":["ids of the entries this topic covers"]}]}, with at most ${CONTEXT_DREAM_LIMITS.topics} topics.`,
        "Entries:",
        JSON.stringify(input.records),
      ].join("\n\n");
      return (await helper({ ...target, prompt, signal: options.signal })).text;
    },
  };
}

const TopicsSchema = z.object({
  topics: z.array(
    z.object({
      title: z.string().trim().min(1),
      body: z.string().trim().min(1),
      recordIds: z.array(z.string()).min(1),
    }),
  ),
});

export function parseContextTopics(
  text: string,
  sent: ReadonlyMap<string, ContextRecordRow>,
): ContextTopic[] {
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  let parsed: z.infer<typeof TopicsSchema>;
  try {
    parsed = TopicsSchema.parse(JSON.parse(json));
  } catch {
    return [];
  }
  return parsed.topics.slice(0, CONTEXT_DREAM_LIMITS.topics).flatMap((topic) => {
    const ids = [...new Set(topic.recordIds)];
    if (!ids.every((id) => sent.has(id))) return [];
    const title = sanitizedContextText(topic.title, CONTEXT_DREAM_LIMITS.titleChars * 4).slice(
      0,
      CONTEXT_DREAM_LIMITS.titleChars,
    );
    const body = sanitizedContextText(topic.body, CONTEXT_DREAM_LIMITS.bodyChars * 4).slice(
      0,
      CONTEXT_DREAM_LIMITS.bodyChars,
    );
    if (title === "" || body === "") return [];
    return [
      {
        title,
        body,
        lineage: ids.map((id) => ({ recordId: id, version: sent.get(id)!.version })),
      },
    ];
  });
}

function visibility(current: ContextRequesterAccess, audience: ContextAudience) {
  return {
    userId: current.userId,
    teamIds: current.teamIds,
    repositories: current.repositories,
    channelIds: current.channelIds,
    audience,
    audienceLineage: audienceLineage(audience),
  };
}

export type ContextTopicView = {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly recordIds: readonly string[];
};

export async function visibleContextTopics(
  db: Db,
  current: ContextRequesterAccess,
  request: {
    namespace: ContextNamespace;
    audience: ContextAudience;
    repository?: string;
    ref?: string;
    now: number;
  },
): Promise<ContextTopicView[]> {
  const rows = await listContextSummaries(db, {
    namespace: request.namespace,
    visibility: visibility(current, request.audience),
    now: request.now,
    topics: true,
    limit: CONTEXT_DREAM_LIMITS.topics,
  });
  const topics: ContextTopicView[] = [];
  for (const row of rows) {
    if (
      !row.valid ||
      !row.title ||
      !canSee(current, row.restriction) ||
      !inRequestScope(row.restriction, request.repository, request.ref)
    )
      continue;
    const lineage = await contextSummaryLineage(db, row.id, row.covered);
    topics.push({
      id: row.id,
      title: row.title,
      body: row.body,
      recordIds: lineage.map((entry) => entry.recordId),
    });
  }
  return topics;
}

type DreamOptions = {
  readonly helper: ContextDreamHelper;
  readonly now: number;
  readonly signal?: AbortSignal;
  readonly journal: (line: string) => void;
};

async function dreamOne(
  db: Db,
  access: ContextAccess,
  target: ContextDreamTarget,
  options: DreamOptions,
): Promise<boolean> {
  const { namespace } = target;
  const { now } = options;
  const project = await contextSourceRestriction(db, namespace, {
    kind: "linear_project_description",
    id: namespace.scopeId,
  });
  if (project?.status !== "active") return false;
  const delegators: ContextRequesterAccess[] = [];
  for (const userId of target.delegatorIds) {
    const current = await requesterAccess(access, { workspaceId: namespace.workspaceId, userId });
    if (!current || !canSee(current, project.restriction)) return false;
    delegators.push(current);
  }
  const audience: ContextAudience = "project_members";
  const lineageName = audienceLineage(audience);
  const partition = contextPartition(lineageName, project.restriction);
  const candidates = await listContextCandidates(db, {
    namespace,
    visibility: visibility(delegators[0]!, audience),
    now,
    candidates: CONTEXT_DREAM_LIMITS.records,
  });
  const records = candidates.records.filter(
    (row) =>
      contextPartition(row.audienceLineage, row.restriction) === partition &&
      delegators.every((current) => disclosable(row, current, audience)),
  );
  const fresh = records.filter(
    (row) => target.dreamedAt === null || row.observedAt > target.dreamedAt,
  );
  if (fresh.length < CONTEXT_DREAM_LIMITS.newRecords) return false;
  await markContextDreamed(db, namespace, now);
  const label = `project memory dream for ${namespace.scopeId}`;
  let text: string;
  try {
    const output = await summarizeBounded(
      contextDreamSummarizer(options.helper, target),
      {
        previous: null,
        records: records.map((row) => ({
          id: row.id,
          classification: row.classification,
          source: sourceLabel(row),
          body: sanitizedContextText(row.body, CONTEXT_DREAM_LIMITS.recordBytes),
        })),
        maxTokens: CONTEXT_DREAM_LIMITS.topics * CONTEXT_DREAM_LIMITS.bodyChars,
      },
      CONTEXT_DREAM_LIMITS.timeoutMs,
      options.signal,
    );
    text = typeof output === "string" ? output : output.text;
  } catch (error) {
    options.journal(
      `${label} failed: ${error instanceof SummarizerTimeout ? "timed out" : "the helper failed"}; next try after 24 hours`,
    );
    return false;
  }
  const topics = parseContextTopics(text, new Map(records.map((row) => [row.id, row])));
  if (topics.length === 0) {
    options.journal(`${label} returned no usable topics; next try after 24 hours`);
    return false;
  }
  const outcome = await replaceContextTopics(db, {
    namespace,
    audience,
    audienceLineage: lineageName,
    restriction: project.restriction,
    topics,
    now,
  });
  if (outcome !== "published")
    options.journal(`${label} was discarded: its records changed; next try after 24 hours`);
  return outcome === "published";
}

export async function dreamProjectContexts(
  db: Db,
  access: ContextAccess,
  options: DreamOptions & { readonly enabled: boolean },
): Promise<number> {
  if (!options.enabled) return 0;
  const targets = await listContextDreamTargets(db, {
    dueBefore: options.now - CONTEXT_DREAM_LIMITS.everyMs,
    limit: CONTEXT_DREAM_LIMITS.scopes,
  });
  let dreamed = 0;
  for (const target of targets) {
    options.signal?.throwIfAborted();
    if (await dreamOne(db, access, target, options)) dreamed++;
  }
  return dreamed;
}
