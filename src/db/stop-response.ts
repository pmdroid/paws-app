import type { Database } from "bun:sqlite";
import { and, desc, eq, like, sql } from "drizzle-orm";
import type { WorkItemRecord } from "./items";
import { orm } from "./orm";
import { enqueueOutboxOnce } from "./outbox";
import { itemBranchState, itemPullRequest, outbox } from "./schema";

export type ItemBranchState = {
  itemId: string;
  runId: string;
  head: string;
  base: string;
  commits: number;
  recordedAt: number;
};

export type ItemPullRequest = {
  itemId: string;
  pullNumber: number;
  pullUrl: string | null;
  openedAt: number;
};

/** The branch as the last finished agent turn left it. A later turn replaces it. */
export function recordItemBranchState(db: Database, state: ItemBranchState): void {
  const { runId, head, base, commits, recordedAt } = state;
  orm(db)
    .insert(itemBranchState)
    .values(state)
    .onConflictDoUpdate({
      target: itemBranchState.itemId,
      set: { runId, head, base, commits, recordedAt },
    })
    .run();
}

export function getItemBranchState(db: Database, itemId: string): ItemBranchState | null {
  return (
    orm(db).select().from(itemBranchState).where(eq(itemBranchState.itemId, itemId)).get() ?? null
  );
}

/** The pull request Paws opened for the item. Republishing keeps the same number. */
export function recordItemPullRequest(db: Database, pull: ItemPullRequest): void {
  orm(db)
    .insert(itemPullRequest)
    .values(pull)
    .onConflictDoUpdate({
      target: itemPullRequest.itemId,
      set: {
        pullNumber: pull.pullNumber,
        pullUrl: sql`COALESCE(excluded.pull_url, ${itemPullRequest.pullUrl})`,
      },
    })
    .run();
}

export function getItemPullRequest(db: Database, itemId: string): ItemPullRequest | null {
  return (
    orm(db).select().from(itemPullRequest).where(eq(itemPullRequest.itemId, itemId)).get() ?? null
  );
}

/**
 * "Stopped. Branch paws/pas-1 has 2 commits; PR #12 stays open. Re-delegate to continue."
 * `lead` names why the work ended; the rest is the branch and pull request as Paws last saw them.
 * A `reason` from elsewhere (issue closed, access denied) replaces the lead, drops the
 * re-delegate hint and names the branch only when something is left on it.
 */
export function stoppedResponse(
  db: Database,
  item: WorkItemRecord,
  lead: string,
  options: { reason?: boolean; pullClosing?: boolean } = {},
): string {
  const state = getItemBranchState(db, item.id);
  const pull = getItemPullRequest(db, item.id);
  const wip = item.checkpoint?.wipCommit;
  const kept = wip !== undefined && wip !== item.checkpoint?.baseSha;
  if (options.reason && pull === null && !state?.commits && !(state === null && kept)) return lead;
  const branch =
    state !== null
      ? `has ${state.commits === 0 ? "no" : state.commits} commit${state.commits === 1 ? "" : "s"}`
      : kept
        ? "is kept"
        : "has no commits";
  const pr =
    pull === null
      ? "no PR was opened"
      : options.pullClosing
        ? `PR #${pull.pullNumber} will be closed`
        : `PR #${pull.pullNumber} stays open`;
  const text = `${lead} Branch ${item.branchName} ${branch}; ${pr}.`;
  return options.reason ? text : `${text} Re-delegate to continue.`;
}

/**
 * Title and plan for a session that ended without merging: unfinished plan steps become
 * canceled and the title reads "<identifier>: <outcome>". Delivered with the stop response.
 */
export function enqueueEndedSessionFace(
  db: Database,
  input: {
    sessionId: string;
    generation: number;
    item: WorkItemRecord;
    outcome: "stopped" | "manual";
    now: number;
  },
): void {
  const identifier = input.item.linearIdentifier;
  const previous = orm(db)
    .select({ plan: sql<string>`json_extract(${outbox.payload}, '$.plan')` })
    .from(outbox)
    .where(
      and(
        eq(outbox.target, "linear"),
        eq(outbox.orderingKey, input.sessionId),
        like(outbox.op, "linear.session.%"),
        sql`json_type(${outbox.payload}, '$.plan') = 'array'`,
        sql`COALESCE(json_extract(${outbox.payload}, '$.identifier'), ${identifier}) = ${identifier}`,
      ),
    )
    .orderBy(desc(outbox.id))
    .limit(1)
    .get();
  const steps = previous
    ? (JSON.parse(previous.plan) as { content: string; status: string }[])
    : [];
  const plan = steps.map((step) => ({
    content: step.content,
    status: step.status === "completed" ? "completed" : "canceled",
  }));
  enqueueOutboxOnce(db, {
    target: "linear",
    op: "linear.session.plan",
    orderingKey: input.sessionId,
    delivery: "stop",
    generation: input.generation,
    idempotencyKey: `session-end:${input.outcome}:${input.sessionId}:${input.generation}`,
    payload: {
      sessionId: input.sessionId,
      ...(plan.length ? { plan } : {}),
      summary: `${input.item.linearIdentifier}: ${input.outcome}`,
      identifier: input.item.linearIdentifier,
      itemId: input.item.id,
    },
    now: input.now,
  });
}
