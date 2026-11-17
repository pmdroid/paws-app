import {
  claimContextCompaction,
  contextLineageCurrent,
  contextPartition,
  contextSummaryLineage,
  listContextSummaryDelta,
  listContextSummaries,
  listRequestedContextCompactions,
  publishContextSummary,
  releaseContextCompaction,
  type ContextClassification,
  type ContextLineageEntry,
  type ContextNamespace,
  type ContextRecordRow,
  type ContextSummaryRow,
  type Db,
} from "../db";
import { randomUUID } from "node:crypto";
import {
  CONTEXT_TOKEN_ESTIMATE,
  estimateContextTokens,
  tokenCounter,
  validateContextBudget,
  type ContextBudgetSettings,
  type ContextModelBudget,
} from "./budget";
import {
  audienceLineage,
  canSee,
  destinationAllowed,
  requesterAccess,
  type ContextAccess,
  type ContextDestination,
  type ContextRequester,
  type ContextRequesterAccess,
} from "./policy";
import { sanitizedContextText } from "./sanitize";
import { summarizable } from "./select";
import { disclosable } from "./store";

export const CONTEXT_COMPACTION_LIMITS = {
  summariesPerRun: 4,
  lineage: 1_000,
  minRecordTokens: 200,
} as const;

export type ContextSummarizerInput = {
  readonly previous: string | null;
  readonly records: readonly {
    readonly id: string;
    readonly classification: ContextClassification;
    readonly body: string;
  }[];
  readonly maxTokens: number;
};

export type ContextSummaryOutput = {
  readonly text: string;
  readonly omittedIds?: readonly string[];
};

export type ContextSummarizer = {
  summarize(
    input: ContextSummarizerInput,
    options: { signal: AbortSignal },
  ): Promise<string | ContextSummaryOutput>;
};

export const extractiveContextSummarizer: ContextSummarizer = {
  async summarize(input) {
    const lines = input.previous ? [input.previous] : [];
    if (estimateContextTokens(lines.join("\n")) > input.maxTokens)
      throw new Error("The previous summary no longer fits.");
    const omittedIds: string[] = [];
    for (const record of input.records) {
      const first =
        record.body
          .replace(/\s+/g, " ")
          .trim()
          .split(/(?<=[.!?])\s/)[0] ?? "";
      const line = `- ${first.slice(0, 240)}`;
      if (first === "" || estimateContextTokens([...lines, line].join("\n")) > input.maxTokens)
        omittedIds.push(record.id);
      else lines.push(line);
    }
    return { text: lines.join("\n"), omittedIds };
  },
};

export type ContextCapacity = {
  readonly slots: number;
  inUse(): number;
  tryAcquire(): (() => void) | null;
};

export function createContextCapacity(slots = 2): ContextCapacity {
  if (!Number.isSafeInteger(slots) || slots < 1 || slots > 16)
    throw new Error("Context capacity needs 1 to 16 slots.");
  let used = 0;
  return {
    slots,
    inUse: () => used,
    tryAcquire() {
      if (used >= slots) return null;
      used++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        used--;
      };
    },
  };
}

export type ContextCompactionOutcome = {
  readonly summaryId: string;
  readonly status:
    | "published"
    | "nothing_to_do"
    | "busy"
    | "conflict"
    | "invalidated"
    | "refused"
    | "failed";
  readonly covered?: number;
  readonly version?: number;
};

export type ContextCompactionRun =
  | { status: "ok"; outcomes: ContextCompactionOutcome[] }
  | { status: "invalid_budget"; errors: string[] }
  | { status: "refused" };

export type ContextCompactionRequestInput = {
  readonly namespace: ContextNamespace;
  readonly requester: ContextRequester;
  readonly destination: ContextDestination;
  readonly settings?: Partial<ContextBudgetSettings>;
  readonly model?: ContextModelBudget;
  readonly now: number;
  readonly signal?: AbortSignal;
};

class SummarizerTimeout extends Error {}

async function summarizeBounded(
  summarizer: ContextSummarizer,
  input: ContextSummarizerInput,
  timeoutMs: number,
  outer: AbortSignal | undefined,
): Promise<string | ContextSummaryOutput> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  outer?.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (outer?.aborted) throw new SummarizerTimeout();
    return await Promise.race([
      summarizer.summarize(input, { signal: controller.signal }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new SummarizerTimeout());
        }, timeoutMs);
        controller.signal.addEventListener("abort", () => reject(new SummarizerTimeout()), {
          once: true,
        });
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    outer?.removeEventListener("abort", abort);
  }
}

function stillAuthorized(
  access: ContextRequesterAccess | null,
  summary: ContextSummaryRow,
): access is ContextRequesterAccess {
  return access !== null && canSee(access, summary.restriction);
}

async function compactOne(
  db: Db,
  access: ContextAccess,
  summarizer: ContextSummarizer,
  capacity: ContextCapacity,
  request: ContextCompactionRequestInput,
  settings: ContextBudgetSettings,
  current: ContextRequesterAccess,
  target: ContextSummaryRow,
): Promise<ContextCompactionOutcome> {
  const { namespace, destination, now } = request;
  const count = tokenCounter(request.model ?? { contextTokens: settings.hardCapTokens });
  const audience = destination.audience as Parameters<typeof audienceLineage>[0];
  if (
    target.audience !== audience ||
    target.audienceLineage !== audienceLineage(audience) ||
    !canSee(current, target.restriction)
  )
    return { summaryId: target.id, status: "refused" };
  const release = capacity.tryAcquire();
  if (!release) return { summaryId: target.id, status: "busy" };
  const leaseToken = randomUUID();
  try {
    const claimed = await claimContextCompaction(db, {
      namespace,
      summaryId: target.id,
      leaseToken,
      leaseMs: settings.compactionLeaseMs,
      now,
    });
    if (!claimed) return { summaryId: target.id, status: "conflict" };
    const give = async (status: ContextCompactionOutcome["status"], failure: string) => {
      await releaseContextCompaction(db, {
        namespace,
        summaryId: claimed.id,
        leaseToken,
        version: claimed.version,
        failure,
        now,
      });
      return { summaryId: claimed.id, status };
    };

    const [previous] = await listContextSummaries(db, {
      namespace,
      partitions: [claimed.partition],
      now,
    });
    const reuse = previous?.valid === true && previous.body !== "";
    const previousLineage = reuse
      ? await contextSummaryLineage(db, claimed.id, CONTEXT_COMPACTION_LIMITS.lineage + 1)
      : [];
    const carried =
      reuse && previousLineage.length === previous.covered
        ? previousLineage
        : ([] as ContextLineageEntry[]);
    const previousText = carried.length ? previous!.body : null;
    const carriedIds = new Set(carried.map((entry) => entry.recordId));

    const delta = (
      await listContextSummaryDelta(db, {
        namespace,
        summaryId: claimed.id,
        restriction: claimed.restriction,
        visibility: {
          userId: current.userId,
          teamIds: current.teamIds,
          repositories: current.repositories,
          channelIds: current.channelIds,
          audience,
          audienceLineage: audienceLineage(audience),
        },
        excludeCovered: carried.length > 0,
        now,
        limit: settings.candidates,
      })
    ).filter(
      (row) =>
        disclosable(row, current, audience) &&
        summarizable(row) &&
        contextPartition(row.audienceLineage, row.restriction) === claimed.partition &&
        !carriedIds.has(row.id),
    );
    if (delta.length === 0) return await give("nothing_to_do", "nothing_to_do");

    let budget = settings.summaryInputTokens - (previousText ? count(previousText) : 0);
    const perRecord = Math.max(
      CONTEXT_COMPACTION_LIMITS.minRecordTokens,
      Math.floor(settings.summaryInputTokens / 4),
    );
    const included: { row: ContextRecordRow; body: string }[] = [];
    const room = CONTEXT_COMPACTION_LIMITS.lineage - carried.length;
    for (const row of delta) {
      if (included.length >= room) break;
      const body = sanitizedContextText(row.body, perRecord * CONTEXT_TOKEN_ESTIMATE.bytesPerToken);
      const cost = count(body);
      if (body === "" || cost > budget) continue;
      budget -= cost;
      included.push({ row, body });
    }
    if (included.length === 0) return await give("nothing_to_do", "input_budget");
    const inputLineage: ContextLineageEntry[] = [
      ...carried,
      ...included.map(({ row }) => ({ recordId: row.id, version: row.version })),
    ];

    const before = await requesterAccess(access, request.requester);
    if (
      !stillAuthorized(before, claimed) ||
      !(await contextLineageCurrent(db, {
        namespace,
        partition: claimed.partition,
        lineage: inputLineage,
        now,
      }))
    )
      return await give("invalidated", "changed_before_summary");

    let output: string | ContextSummaryOutput;
    try {
      output = await summarizeBounded(
        summarizer,
        {
          previous: previousText,
          records: included.map(({ row, body }) => ({
            id: row.id,
            classification: row.classification,
            body,
          })),
          maxTokens: settings.summaryOutputTokens,
        },
        settings.summaryTimeoutMs,
        request.signal,
      );
    } catch (error) {
      return await give(
        "failed",
        error instanceof SummarizerTimeout ? "timeout" : "summarizer_failed",
      );
    }
    const text = typeof output === "string" ? output : output?.text;
    const omitted = new Set(typeof output === "string" ? [] : (output?.omittedIds ?? []));
    const summarized = included.filter(({ row }) => !omitted.has(row.id));
    const body =
      typeof text === "string"
        ? sanitizedContextText(
            text,
            settings.summaryOutputTokens * CONTEXT_TOKEN_ESTIMATE.bytesPerToken,
          )
        : "";
    if (summarized.length === 0) return await give("nothing_to_do", "summary_full");
    if (body === "" || count(body) > settings.summaryOutputTokens)
      return await give("failed", "invalid_output");

    const after = await requesterAccess(access, request.requester);
    if (!stillAuthorized(after, claimed)) return await give("invalidated", "access_changed");
    const watermark = Math.max(
      previousText ? (previous!.watermark ?? 0) : 0,
      ...summarized.map(({ row }) => row.observedAt),
    );
    const lineage: ContextLineageEntry[] = [
      ...carried,
      ...summarized.map(({ row }) => ({ recordId: row.id, version: row.version })),
    ];
    const published = await publishContextSummary(db, {
      namespace,
      summaryId: claimed.id,
      leaseToken,
      version: claimed.version,
      body,
      lineage,
      watermark,
      now,
    });
    if (published.status !== "published")
      return { summaryId: claimed.id, status: published.status };
    return {
      summaryId: claimed.id,
      status: "published",
      covered: lineage.length,
      version: published.version,
    };
  } finally {
    release();
  }
}

export async function compactContext(
  db: Db,
  access: ContextAccess,
  summarizer: ContextSummarizer,
  capacity: ContextCapacity,
  request: ContextCompactionRequestInput,
): Promise<ContextCompactionRun> {
  const validation = validateContextBudget(request.settings);
  if (!validation.ok) return { status: "invalid_budget", errors: validation.errors };
  const { namespace, requester, destination } = request;
  if (!destinationAllowed(namespace, requester, destination)) return { status: "refused" };
  const current = await requesterAccess(access, requester);
  if (!current) return { status: "refused" };
  const audience = destination.audience as Parameters<typeof audienceLineage>[0];
  const requested = await listRequestedContextCompactions(db, {
    namespace,
    visibility: {
      userId: current.userId,
      teamIds: current.teamIds,
      repositories: current.repositories,
      channelIds: current.channelIds,
      audience,
      audienceLineage: audienceLineage(audience),
    },
    now: request.now,
    limit: CONTEXT_COMPACTION_LIMITS.summariesPerRun,
  });
  const outcomes: ContextCompactionOutcome[] = [];
  for (const target of requested) {
    const outcome = await compactOne(
      db,
      access,
      summarizer,
      capacity,
      request,
      validation.settings,
      current,
      target,
    );
    if (outcome.status !== "refused") outcomes.push(outcome);
  }
  return { status: "ok", outcomes };
}
