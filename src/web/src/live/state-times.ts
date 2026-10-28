import type { WorkItemEventRow } from "../../../db";
import { isTerminalWorkItemState, type WorkItemState } from "../../../core";
import type { StatusMergedTimes, StatusStateTime, StatusStateTimes } from "../contract";

type Change = Pick<WorkItemEventRow, "at" | "fromState" | "toState">;

/** One item's time in each state, in ms, from `start` until it finished or `now`. */
export interface StateTotals {
  start: number;
  end: number;
  current: WorkItemState | null;
  states: Map<WorkItemState, number>;
}

/**
 * Splits an item's life into its states. Before its first change it was in that change's
 * `fromState`; after its last it is in `current` up to `now`, unless that state is terminal.
 * A change recorded before the previous one adds no time, so the states add up to `end - start`.
 */
export function stateTotals(
  start: number,
  changes: readonly Change[],
  current: WorkItemState,
  now: number,
): StateTotals {
  const states = new Map<WorkItemState, number>();
  const add = (state: WorkItemState, ms: number) =>
    states.set(state, (states.get(state) ?? 0) + ms);
  let state = changes[0]?.fromState ?? current;
  let cursor = start;
  for (const change of changes) {
    if (change.at > cursor) {
      add(state, change.at - cursor);
      cursor = change.at;
    }
    state = change.toState;
  }
  if (isTerminalWorkItemState(state)) return { start, end: cursor, current: null, states };
  const end = Math.max(cursor, now);
  add(state, end - cursor);
  return { start, end, current: state, states };
}

export function toStateTimes(totals: StateTotals): StatusStateTimes {
  return {
    since: new Date(totals.start).toISOString(),
    until: new Date(totals.end).toISOString(),
    current: totals.current,
    states: [...totals.states].map(([state, ms]) => ({ state, ms })),
  };
}

/**
 * Median and nearest-rank p90 of the merged items' time from delegation to merge, and their
 * average time in each state. Null when none merged.
 */
export function mergedTimes(
  merged: readonly StateTotals[],
  since: number,
): StatusMergedTimes | null {
  if (merged.length === 0) return null;
  const ages = merged
    .map((totals) => totals.end - totals.start)
    .sort((left, right) => left - right);
  const middle = Math.floor(ages.length / 2);
  const median =
    ages.length % 2 === 1 ? ages[middle]! : Math.round((ages[middle - 1]! + ages[middle]!) / 2);
  const p90 = ages[Math.ceil(ages.length * 0.9) - 1]!;
  const sums = new Map<string, number>();
  for (const totals of merged)
    for (const [state, ms] of totals.states) sums.set(state, (sums.get(state) ?? 0) + ms);
  const states: StatusStateTime[] = [...sums]
    .map(([state, ms]) => ({ state, ms: Math.round(ms / merged.length) }))
    .filter((entry) => entry.ms > 0)
    .sort((left, right) => right.ms - left.ms);
  return {
    since: new Date(since).toISOString(),
    merged: merged.length,
    medianMs: median,
    p90Ms: p90,
    states,
  };
}
