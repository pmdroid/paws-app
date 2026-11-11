import { eq } from "drizzle-orm";
import { type Q, type Db } from "./db";

export type TaskMergeSettings = {
  order: "queue" | "ci-green" | "github-queue";
  mainMoved: "overlap" | "green" | "ci" | "closeout";
  /** Where each choice came from and the matched rule, as resolved when the task started. */
  resolved: Record<string, unknown>;
};

export function* keepTaskMergeSettingsSteps(
  q: Q,
  itemId: string,
  settings: TaskMergeSettings,
  now: number,
) {
  yield* q.exec(
    q.orm
      .insert(q.t.workItemMergeSettings)
      .values({
        itemId,
        mergeOrder: settings.order,
        mainMoved: settings.mainMoved,
        resolvedJson: JSON.stringify(settings.resolved),
        resolvedAt: now,
      })
      .onConflictDoNothing(),
  );
}

/** Keep the first resolution: a task merges with the settings it started with. */
export async function keepTaskMergeSettings(
  store: Db,
  itemId: string,
  settings: TaskMergeSettings,
  now: number,
): Promise<void> {
  await store.run((q) => keepTaskMergeSettingsSteps(q, itemId, settings, now));
}

export function* getTaskMergeSettingsSteps(q: Q, itemId: string) {
  const { workItemMergeSettings } = q.t;
  const row = yield* q.one(
    q.orm
      .select({
        mergeOrder: workItemMergeSettings.mergeOrder,
        mainMoved: workItemMergeSettings.mainMoved,
        resolvedJson: workItemMergeSettings.resolvedJson,
      })
      .from(workItemMergeSettings)
      .where(eq(workItemMergeSettings.itemId, itemId)),
  );
  return row === undefined
    ? null
    : {
        order: row.mergeOrder as TaskMergeSettings["order"],
        mainMoved: row.mainMoved as TaskMergeSettings["mainMoved"],
        resolved: JSON.parse(row.resolvedJson) as Record<string, unknown>,
      };
}

export async function getTaskMergeSettings(
  store: Db,
  itemId: string,
): Promise<TaskMergeSettings | null> {
  return store.run((q) => getTaskMergeSettingsSteps(q, itemId));
}
