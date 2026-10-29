import type { StatusItem, StatusMergedTimes, StatusStateTime, StatusStateTimes } from "../contract";
import { esc } from "./format";

const MINUTE = 60_000;

/** Engine states in the order the bar and the 24-hour table list them. */
const STATE_ORDER = [
  "planning",
  "queued",
  "running",
  "verifying",
  "recovering",
  "awaiting_input",
  "paused",
  "merge_queue",
  "failed",
  "manual",
] as const;

const STATE_NAMES: Record<string, string> = {
  awaiting_input: "awaiting input",
  merge_queue: "merge queue",
};

/** States where nobody is working on the item: it waits for a slot, a person, a crash or a merge. */
const WAITING_STATES = new Set([
  "queued",
  "recovering",
  "awaiting_input",
  "paused",
  "merge_queue",
  "failed",
  "manual",
]);

export function stateName(state: string): string {
  return STATE_NAMES[state] ?? state.replace(/_/g, " ");
}

/** Whole minutes, such as "187 min". */
export function minutesLabel(ms: number): string {
  return `${Math.round(ms / MINUTE)} min`;
}

/** Hours and minutes, such as "3 h 10 min", "2 h" or "45 min". */
export function hoursLabel(ms: number): string {
  const minutes = Math.round(ms / MINUTE);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

function ordered(states: readonly StatusStateTime[]): StatusStateTime[] {
  const rank = (state: string) => {
    const at = (STATE_ORDER as readonly string[]).indexOf(state);
    return at === -1 ? STATE_ORDER.length : at;
  };
  return states
    .filter((entry) => entry.ms > 0)
    .sort((left, right) => rank(left.state) - rank(right.state));
}

function age(times: StatusStateTimes): number {
  return Date.parse(times.until) - Date.parse(times.since);
}

/** The waiting state the item spent longest in, while that is at least a minute. */
export function biggestWait(times: StatusStateTimes): StatusStateTime | null {
  let biggest: StatusStateTime | null = null;
  for (const entry of times.states)
    if (WAITING_STATES.has(entry.state) && entry.ms >= MINUTE && entry.ms > (biggest?.ms ?? 0))
      biggest = entry;
  return biggest;
}

/** An open item's age and its biggest waiting state, such as "3 h 10 min · 2 h recovering". */
export function itemAgeLine(item: StatusItem): string | null {
  const times = item.stateTimes;
  if (!times || times.current === null) return null;
  const wait = biggestWait(times);
  return [
    hoursLabel(age(times)),
    ...(wait ? [`${hoursLabel(wait.ms)} ${stateName(wait.state)}`] : []),
  ].join(" · ");
}

export function itemAge(item: StatusItem): string {
  const line = itemAgeLine(item);
  return line ? `<span class="muted item-age" data-item-age>${esc(line)}</span>` : "";
}

/**
 * The issue page's time bar: one segment per state the item spent time in, sized by that time
 * and labelled with its minutes, then the same as a list. The current state counts up to now.
 */
export function stateTimeBar(times: StatusStateTimes | undefined): string {
  const states = times ? ordered(times.states) : [];
  if (!times || states.length === 0) return "";
  const total = age(times);
  const label = (entry: StatusStateTime) =>
    `${stateName(entry.state)} ${minutesLabel(entry.ms)}${entry.state === times.current ? ", now" : ""}`;
  return `<section class="state-times" aria-labelledby="state-times-heading">
    <div class="between"><h2 id="state-times-heading">Time in each state</h2><span class="muted">${esc(times.current === null ? `${hoursLabel(total)} in all` : `${hoursLabel(total)} since delegation`)}</span></div>
    <div class="time-bar" aria-hidden="true">${states
      .map(
        (entry) =>
          `<span class="time-seg" data-state="${esc(entry.state)}" data-ms="${entry.ms}"${entry.state === times.current ? " data-current" : ""} title="${esc(label(entry))}"><span class="time-seg-label">${esc(minutesLabel(entry.ms))}</span></span>`,
      )
      .join("")}</div>
    <ul class="time-legend" role="list">${states
      .map(
        (entry) =>
          `<li data-state="${esc(entry.state)}"><i class="time-swatch" data-state="${esc(entry.state)}"></i>${esc(stateName(entry.state))} <b>${esc(minutesLabel(entry.ms))}</b>${entry.state === times.current ? ' <span class="muted">now</span>' : ""}</li>`,
      )
      .join("")}</ul>
  </section>`;
}

/** The overview's "Last 24 hours": merged items, their median and p90, and the average per state. */
export function mergedTimesSection(times: StatusMergedTimes | undefined): string {
  if (!times) return "";
  const summary = `${times.merged} merged · median ${hoursLabel(times.medianMs)} · p90 ${hoursLabel(times.p90Ms)} from start to merge`;
  return `<section class="overview-section merged-times" aria-labelledby="merged-times-heading"><h2 id="merged-times-heading">Last 24 hours</h2>
    <p class="muted">${esc(summary)}</p>
    ${
      times.states.length
        ? `<table class="merged-times-table"><caption class="sr-only">Average time per merged item in each state</caption><thead><tr><th scope="col">State</th><th scope="col">Average per item</th></tr></thead><tbody>${times.states
            .map(
              (entry) =>
                `<tr data-state="${esc(entry.state)}"><td><i class="time-swatch" data-state="${esc(entry.state)}"></i>${esc(stateName(entry.state))}</td><td>${esc(minutesLabel(entry.ms))}</td></tr>`,
            )
            .join("")}</tbody></table>`
        : ""
    }
  </section>`;
}
