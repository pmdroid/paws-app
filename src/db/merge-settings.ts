import type { Database } from "bun:sqlite";

export type TaskMergeSettings = {
  order: "queue" | "ci-green" | "github-queue";
  mainMoved: "overlap" | "ci" | "closeout";
  /** Where each choice came from and the matched rule, as resolved when the task started. */
  resolved: Record<string, unknown>;
};

/** Keep the first resolution: a task merges with the settings it started with. */
export function keepTaskMergeSettings(
  db: Database,
  itemId: string,
  settings: TaskMergeSettings,
  now: number,
): void {
  db.run(
    `INSERT OR IGNORE INTO work_item_merge_settings(item_id,merge_order,main_moved,resolved_json,resolved_at)
     VALUES(?,?,?,?,?)`,
    [itemId, settings.order, settings.mainMoved, JSON.stringify(settings.resolved), now],
  );
}

export function getTaskMergeSettings(db: Database, itemId: string): TaskMergeSettings | null {
  const row = db
    .query<
      {
        merge_order: TaskMergeSettings["order"];
        main_moved: TaskMergeSettings["mainMoved"];
        resolved_json: string;
      },
      [string]
    >("SELECT merge_order,main_moved,resolved_json FROM work_item_merge_settings WHERE item_id=?")
    .get(itemId);
  return row === null
    ? null
    : {
        order: row.merge_order,
        mainMoved: row.main_moved,
        resolved: JSON.parse(row.resolved_json),
      };
}
