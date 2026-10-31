import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { RestartHandoff } from "./restart";
import { joinMergeQueue } from "./merge-queue";

export type BudgetHandoff = {
  id: number;
  handoff: Omit<RestartHandoff, "now">;
  queue_repository: string | null;
  queue_ready_at: number | null;
};

/** Store the complete blocked request once, before halting removes its queue position. */
export function holdBudgetHandoff(db: Database, itemId: string, input: RestartHandoff): void {
  const { now: _now, ...handoff } = input;
  const serialized = JSON.stringify(handoff);
  const place = handoff.keepMergeQueuePlace
    ? db
        .query<{ repository: string; ready_at: number }, [string]>(
          "SELECT repository,ready_at FROM merge_queue_entry WHERE item_id=?",
        )
        .get(itemId)
    : null;
  db.run(
    `INSERT OR IGNORE INTO restart_budget_handoff
    (item_id,digest,handoff,queue_repository,queue_ready_at) VALUES (?,?,?,?,?)`,
    [
      itemId,
      createHash("sha256").update(serialized).digest("hex"),
      serialized,
      place?.repository ?? null,
      place?.ready_at ?? null,
    ],
  );
}

export function budgetHandoffs(db: Database, itemId: string): BudgetHandoff[] {
  return db
    .query<Omit<BudgetHandoff, "handoff"> & { handoff: string }, [string]>(
      "SELECT id,handoff,queue_repository,queue_ready_at FROM restart_budget_handoff WHERE item_id=? AND carried_version IS NULL ORDER BY id",
    )
    .all(itemId)
    .map((row) => ({ ...row, handoff: JSON.parse(row.handoff) as BudgetHandoff["handoff"] }));
}

/** Restore the original place only when a new restart is actually being admitted. */
export function restoreBudgetQueue(
  db: Database,
  itemId: string,
  held: readonly BudgetHandoff[],
): void {
  const place = held.find(
    (entry) => entry.queue_repository !== null && entry.queue_ready_at !== null,
  );
  if (place)
    joinMergeQueue(db, { itemId, repository: place.queue_repository!, now: place.queue_ready_at! });
}

export function carryBudgetHandoffs(
  db: Database,
  held: readonly BudgetHandoff[],
  version: number,
): void {
  for (const entry of held)
    db.run(
      "UPDATE restart_budget_handoff SET carried_version=? WHERE id=? AND carried_version IS NULL",
      [version, entry.id],
    );
}
