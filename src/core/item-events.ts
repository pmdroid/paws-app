/**
 * Kinds of `work_item_event` rows. Every committed transition writes one row. A transition that
 * sends the item back to the agent is a `restart` row and one that asks a person is an `ask` row,
 * so the item's whole history lives in one table.
 */
export const WORK_ITEM_EVENT_KINDS = ["transition", "restart", "ask"] as const;
export type WorkItemEventKind = (typeof WORK_ITEM_EVENT_KINDS)[number];

/** Why an item went back to the agent. A `restart` row carries one of these as its reason. */
export const RESTART_REASONS = [
  "findings",
  "ci",
  "review",
  "conflict",
  "follow_up",
  "answer",
] as const;
export type RestartReason = (typeof RESTART_REASONS)[number];
