import { and, desc, eq, ilike, sql } from "drizzle-orm";
import { type Q, type Steps, type Db } from "./db";
import type { WorkItemRecord } from "./items";
import { enqueueOutboxOnceSteps } from "./outbox";
import type { itemBranchState, itemPullRequest } from "./schema-pg";

export type ItemBranchState = typeof itemBranchState.$inferSelect;

export type ItemPullRequest = Omit<
  typeof itemPullRequest.$inferSelect,
  "publishedHead" | "openFindingsLine"
>;

type RecordedPullRequest = ItemPullRequest & { published?: { head: string; line: string } };

export function* recordItemBranchStateSteps(q: Q, state: ItemBranchState): Steps<void> {
  const { itemBranchState } = q.t;
  const { runId, head, base, commits, recordedAt } = state;
  yield* q.exec(
    q.orm.insert(itemBranchState).values(state).onConflictDoUpdate({
      target: itemBranchState.itemId,
      set: { runId, head, base, commits, recordedAt },
    }),
  );
}

/** The branch as the last finished agent turn left it. A later turn replaces it. */
export async function recordItemBranchState(store: Db, state: ItemBranchState): Promise<void> {
  await store.run((q) => recordItemBranchStateSteps(q, state));
}

export function* getItemBranchStateSteps(q: Q, itemId: string): Steps<ItemBranchState | null> {
  const { itemBranchState } = q.t;
  const row = yield* q.one(
    q.orm.select().from(itemBranchState).where(eq(itemBranchState.itemId, itemId)),
  );
  return row ?? null;
}

export async function getItemBranchState(
  store: Db,
  itemId: string,
): Promise<ItemBranchState | null> {
  return store.run((q) => getItemBranchStateSteps(q, itemId));
}

export function* recordItemPullRequestSteps(q: Q, pull: RecordedPullRequest): Steps<void> {
  const { itemPullRequest } = q.t;
  const { published, ...row } = pull;
  const findings = published
    ? { publishedHead: published.head, openFindingsLine: published.line }
    : {};
  yield* q.exec(
    q.orm
      .insert(itemPullRequest)
      .values({ ...row, ...findings })
      .onConflictDoUpdate({
        target: itemPullRequest.itemId,
        set: {
          pullNumber: pull.pullNumber,
          pullUrl: sql`COALESCE(excluded.pull_url, ${itemPullRequest.pullUrl})`,
          ...findings,
        },
      }),
  );
}

/**
 * The pull request Paws opened for the item. Republishing keeps the same number. `published`
 * is the head it published and the line the final Linear response carries for what was still
 * open there, already escaped; an empty line means nothing was open.
 */
export async function recordItemPullRequest(store: Db, pull: RecordedPullRequest): Promise<void> {
  await store.run((q) => recordItemPullRequestSteps(q, pull));
}

export function* getItemPullRequestSteps(q: Q, itemId: string): Steps<ItemPullRequest | null> {
  const { itemPullRequest } = q.t;
  const row = yield* q.one(
    q.orm
      .select({
        itemId: itemPullRequest.itemId,
        pullNumber: itemPullRequest.pullNumber,
        pullUrl: itemPullRequest.pullUrl,
        openedAt: itemPullRequest.openedAt,
      })
      .from(itemPullRequest)
      .where(eq(itemPullRequest.itemId, itemId)),
  );
  return row ?? null;
}

export async function getItemPullRequest(
  store: Db,
  itemId: string,
): Promise<ItemPullRequest | null> {
  return store.run((q) => getItemPullRequestSteps(q, itemId));
}

export function* getPublishedHeadSteps(q: Q, itemId: string): Steps<string | null> {
  const { itemPullRequest } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ head: itemPullRequest.publishedHead })
      .from(itemPullRequest)
      .where(eq(itemPullRequest.itemId, itemId)),
  );
  return row?.head ?? null;
}

/** The open-findings line of the item's last published head, or null when nothing was open. */
export function* getOpenFindingsLineSteps(q: Q, itemId: string): Steps<string | null> {
  const { itemPullRequest } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ line: itemPullRequest.openFindingsLine })
      .from(itemPullRequest)
      .where(eq(itemPullRequest.itemId, itemId)),
  );
  return row?.line ? row.line : null;
}

/** A final response with the open-findings line of the item's last published head after it. */
export function* withOpenFindingsSteps(q: Q, itemId: string, body: string): Steps<string> {
  const line = yield* getOpenFindingsLineSteps(q, itemId);
  return line === null ? body : `${body}\n\n${line}`;
}

type StopOptions = { reason?: boolean; pullClosing?: boolean };

export function* stoppedResponseSteps(
  q: Q,
  item: WorkItemRecord,
  lead: string,
  options: StopOptions = {},
): Steps<string> {
  const state = yield* getItemBranchStateSteps(q, item.id);
  const pull = yield* getItemPullRequestSteps(q, item.id);
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
 * "Stopped. Branch paws/pas-1 has 2 commits; PR #12 stays open. Re-delegate to continue."
 * `lead` names why the work ended; the rest is the branch and pull request as Paws last saw them.
 * A `reason` from elsewhere (issue closed, access denied) replaces the lead, drops the
 * re-delegate hint and names the branch only when something is left on it.
 */
export async function stoppedResponse(
  store: Db,
  item: WorkItemRecord,
  lead: string,
  options: StopOptions = {},
): Promise<string> {
  return store.run((q) => stoppedResponseSteps(q, item, lead, options));
}

type EndedSession = {
  sessionId: string;
  generation: number;
  item: WorkItemRecord;
  outcome: "stopped" | "manual";
  now: number;
};

/** A payload field as JSON text, and its JSON type, on either dialect. */
function payloadField(q: Q, key: "plan" | "identifier") {
  const { payload } = q.t.outbox;
  const field = sql.raw(`'${key}'`);
  return { text: sql`(${payload}->>${field})`, type: sql`jsonb_typeof(${payload}->${field})` };
}

export function* enqueueEndedSessionFaceSteps(q: Q, input: EndedSession): Steps<void> {
  const { outbox } = q.t;
  const identifier = input.item.linearIdentifier;
  const plan = payloadField(q, "plan");
  const previous = yield* q.one(
    q.orm
      .select({ plan: sql<string>`${plan.text}` })
      .from(outbox)
      .where(
        and(
          eq(outbox.target, "linear"),
          eq(outbox.orderingKey, input.sessionId),
          ilike(outbox.op, "linear.session.%"),
          sql`${plan.type} = 'array'`,
          sql`COALESCE(${payloadField(q, "identifier").text}, ${identifier}) = ${identifier}`,
        ),
      )
      .orderBy(desc(outbox.id))
      .limit(1),
  );
  const steps = previous
    ? (JSON.parse(previous.plan) as { content: string; status: string }[])
    : [];
  const planned = steps.map((step) => ({
    content: step.content,
    status: step.status === "completed" ? "completed" : "canceled",
  }));
  yield* enqueueOutboxOnceSteps(q, {
    target: "linear",
    op: "linear.session.plan",
    orderingKey: input.sessionId,
    delivery: "stop",
    generation: input.generation,
    idempotencyKey: `session-end:${input.outcome}:${input.sessionId}:${input.generation}`,
    payload: {
      sessionId: input.sessionId,
      ...(planned.length ? { plan: planned } : {}),
      summary: `${input.item.linearIdentifier}: ${input.outcome}`,
      identifier: input.item.linearIdentifier,
      itemId: input.item.id,
    },
    now: input.now,
  });
}

/**
 * Title and plan for a session that ended without merging: unfinished plan steps become
 * canceled and the title reads "<identifier>: <outcome>". Delivered with the stop response.
 */
export async function enqueueEndedSessionFace(store: Db, input: EndedSession): Promise<void> {
  await store.transaction((q) => enqueueEndedSessionFaceSteps(q, input));
}
