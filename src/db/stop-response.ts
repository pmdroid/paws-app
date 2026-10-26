import type { Database } from "bun:sqlite";
import type { WorkItemRecord } from "./items";
import { enqueueOutboxOnce } from "./outbox";

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
  db.run(
    `INSERT INTO item_branch_state (item_id, run_id, head, base, commits, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (item_id) DO UPDATE SET run_id = excluded.run_id,
       head = excluded.head, base = excluded.base, commits = excluded.commits,
       recorded_at = excluded.recorded_at`,
    [state.itemId, state.runId, state.head, state.base, state.commits, state.recordedAt],
  );
}

export function getItemBranchState(db: Database, itemId: string): ItemBranchState | null {
  return (
    db
      .query<ItemBranchState, [string]>(
        `SELECT item_id AS itemId, run_id AS runId, head, base, commits, recorded_at AS recordedAt
         FROM item_branch_state WHERE item_id = ?`,
      )
      .get(itemId) ?? null
  );
}

/** The pull request Paws opened for the item. Republishing keeps the same number. */
export function recordItemPullRequest(db: Database, pull: ItemPullRequest): void {
  db.run(
    `INSERT INTO item_pull_request (item_id, pull_number, pull_url, opened_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (item_id) DO UPDATE SET pull_number = excluded.pull_number,
       pull_url = COALESCE(excluded.pull_url, pull_url)`,
    [pull.itemId, pull.pullNumber, pull.pullUrl, pull.openedAt],
  );
}

export function getItemPullRequest(db: Database, itemId: string): ItemPullRequest | null {
  return (
    db
      .query<ItemPullRequest, [string]>(
        `SELECT item_id AS itemId, pull_number AS pullNumber, pull_url AS pullUrl, opened_at AS openedAt
         FROM item_pull_request WHERE item_id = ?`,
      )
      .get(itemId) ?? null
  );
}

/**
 * "Stopped. Branch paws/pas-1 has 2 commits; PR #12 is open. Re-delegate to continue."
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
        : `PR #${pull.pullNumber} is open`;
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
  const previous = db
    .query<{ plan: string }, [string, string]>(
      `SELECT json_extract(payload, '$.plan') AS plan FROM outbox
       WHERE target = 'linear' AND ordering_key = ? AND op LIKE 'linear.session.%'
         AND json_type(payload, '$.plan') = 'array'
         AND COALESCE(json_extract(payload, '$.identifier'), ?2) = ?2
       ORDER BY id DESC LIMIT 1`,
    )
    .get(input.sessionId, input.item.linearIdentifier);
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
