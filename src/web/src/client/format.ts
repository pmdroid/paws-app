import { journalCaught } from "../journal";
import type {
  HeldReason,
  ItemState,
  RunState,
  StatusLink,
  StatusItem,
  StatusQueuePosition,
  VerdictDecision,
} from "../contract";

const ITEM_LABEL: Record<ItemState, string> = {
  queued: "Queued",
  planning: "Planning",
  running: "Running",
  awaiting_input: "Awaiting input",
  verifying: "Verifying",
  merge_queue: "In merge queue",
  merged: "Merged",
  completed: "Completed",
  stopped: "Stopped",
  needs_human: "Needs a person",
};

const RUN_LABEL: Record<RunState, string> = {
  running: "Running",
  awaiting_input: "Awaiting input",
  verifying: "Verifying",
  paused: "Paused",
  done: "Done",
  stopped: "Stopped",
};

const VERDICT_LABEL: Record<VerdictDecision, string> = {
  accepted: "Accepted",
  rejected: "Rejected",
  exhausted: "Exhausted",
  running: "Verifying…",
  blocked: "Blocked",
};

const VERDICT_DETAIL: Record<VerdictDecision, string> = {
  accepted: "Fresh evidence satisfied the applicable requirements.",
  rejected: "Findings go back to the implementing agent.",
  exhausted: "Retry budget for this item is used up.",
  running: "Closeout is still collecting evidence.",
  blocked: "Closeout stopped and needs a person.",
};

export function esc(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

export function itemLabel(state: ItemState): string {
  return ITEM_LABEL[state];
}

export function runLabel(state: RunState): string {
  return RUN_LABEL[state];
}

export const PHASE_NAMES = ["Implementation", "Closeout", "Waiting to merge", "Complete"] as const;

export const RUN_STATES = Object.keys(RUN_LABEL) as RunState[];

export function taskPhase(
  itemState: ItemState | null,
  runState: RunState,
  closeoutDecision?: VerdictDecision,
): { current: number; detail: string } {
  const recheck =
    closeoutDecision === "running" &&
    itemState !== "running" &&
    itemState !== "queued" &&
    itemState !== "planning" &&
    itemState !== "awaiting_input";
  if (itemState === "completed")
    return { current: 3, detail: "The requested response is complete." };
  if (itemState === "merged") return { current: 3, detail: "Merged. This item is complete." };
  if (recheck) {
    return {
      current: 1,
      detail:
        "Implementation finished. Closeout is verifying this candidate. The item is not complete.",
    };
  }
  if (closeoutDecision === "blocked") {
    return {
      current: 1,
      detail: "Closeout is blocked and needs a person. The item is not complete.",
    };
  }
  if (closeoutDecision === "exhausted") {
    return {
      current: 1,
      detail: "Closeout stopped after its retry budget. The item is not complete.",
    };
  }
  if (closeoutDecision === "rejected") {
    return { current: 1, detail: "Closeout checks failed. The item is not complete." };
  }
  if (itemState === "merge_queue") {
    return {
      current: 2,
      detail: "Closeout accepted. Waiting to merge. The item is not complete.",
    };
  }
  if (itemState === "needs_human" || itemState === "stopped" || runState === "stopped") {
    return { current: 1, detail: "Stopped before the item was complete." };
  }
  if (itemState === "awaiting_input" || runState === "awaiting_input") {
    return {
      current: 0,
      detail: "The implementing agent is waiting for an answer. The item is not complete.",
    };
  }
  if (itemState === "verifying" || runState === "verifying") {
    return {
      current: 1,
      detail:
        "Implementation finished. Closeout is verifying this candidate. The item is not complete.",
    };
  }
  return {
    current: 0,
    detail: "The implementing agent is still working. The item is not complete.",
  };
}

export function durationLabel(ms: number): string {
  if (ms > 0 && ms < 60_000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")}s`;
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

export function verdictLabel(decision: VerdictDecision): string {
  return VERDICT_LABEL[decision];
}

export function verdictDetail(decision: VerdictDecision): string {
  return VERDICT_DETAIL[decision];
}

export function statePill(state: string, label: string): string {
  return `<span class="st ${esc(state)}">${esc(label)}</span>`;
}

export function agentChip(name: string): string {
  return `<span class="agent">${esc(name)}</span>`;
}

export function avatar(name: string, small = false): string {
  return `<span class="av${small ? " sm" : ""}" title="${esc(name)}">${esc(initials(name))}</span>`;
}

export function clock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(date);
}

/** Hours and minutes in UTC, as the Linear pause line shows them. */
export function utcClock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(11, 16);
}

export function ago(iso: string, now: string): string {
  const delta = Date.parse(now) - Date.parse(iso);
  if (Number.isNaN(delta)) return "";
  const minutes = Math.max(0, Math.round(delta / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m ago` : `${hours}h ago`;
}

export function linkList(links: StatusLink[]): string {
  const rendered = links.flatMap((link) => {
    const href = safeHref(link.href);
    if (!href) return [];
    return [
      `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(link.label)}</a>`,
    ];
  });
  return rendered.join(' <span class="dim">·</span> ');
}

export function linkButtons(links: StatusLink[]): string {
  return links
    .flatMap((link) => {
      const href = safeHref(link.href);
      if (!href) return [];
      return [
        `<a class="btn" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(link.label)}</a>`,
      ];
    })
    .join("");
}

export function safeHref(href: string): string | null {
  try {
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch (caughtError1) {
    journalCaught(caughtError1, "format.safeHref.toString", null);
    return null;
  }
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  const letters = parts.map((part) => part[0] ?? "").join("");
  return letters.toUpperCase() || "?";
}

const PLACES = [
  "First",
  "Second",
  "Third",
  "Fourth",
  "Fifth",
  "Sixth",
  "Seventh",
  "Eighth",
  "Ninth",
  "Tenth",
];

/** "Second in the acme/platform queue". Matches the Linear update. */
export function mergeQueueLine(queue: { position: number; repository: string }): string {
  const tens = queue.position % 100;
  const suffix =
    tens >= 11 && tens <= 13 ? "th" : (["th", "st", "nd", "rd"][queue.position % 10] ?? "th");
  return `${PLACES[queue.position - 1] ?? `${queue.position}${suffix}`} in the ${queue.repository} queue`;
}

export function waitReason(item: StatusItem): string | null {
  if (item.state !== "queued") return null;
  const held = heldLine(item);
  if (held) return held;
  const blockers = item.blockers;
  if (blockers.length) return `Blocked by ${blockers.join(", ")}`;
  return item.queue?.ownerCap
    ? `Waiting: ${capLine(item, item.queue.ownerCap)}`
    : "Waiting for a free runner";
}

const HELD_LINES: Record<HeldReason, string> = {
  blocked: "blocked by another issue",
  project: "its project has not released it yet",
  reconciling: "Linear changes are still syncing",
  snapshot: "reading its dependencies from Linear",
  cap: "its owner already runs the most items at once",
  slot: "no free slot on any runner",
  workspace: "no Linear workspace is configured",
  overlap: "another item that changes the same conflict-prone files has to merge first",
};

export function heldLine(item: StatusItem): string | null {
  const held = item.state === "queued" ? item.held : undefined;
  if (!held) return null;
  if (held.reason === "blocked" && held.blockers.length)
    return `Waiting: blocked by ${held.blockers.join(", ")}`;
  if (held.reason === "overlap" && held.blockers[0]) {
    const names = [...new Set((held.files ?? []).map((path) => path.split("/").pop()!))];
    return `Held: waiting for ${held.blockers[0]} to merge${names.length ? ` (both change ${names.join(", ")})` : ""}`;
  }
  if (held.reason === "cap" && item.queue?.ownerCap)
    return `Waiting: ${capLine(item, item.queue.ownerCap)}`;
  return `Waiting: ${HELD_LINES[held.reason]}`;
}

export function capLine(item: StatusItem, cap: number): string {
  return `its ${item.project ? "project" : "owner"} already runs ${cap} ${cap === 1 ? "item" : "items"}, the most at once`;
}

/** "Queued, 2nd in line. 4 of 4 runner slots are busy." Matches the Linear thought. */
export function queueLine(queue: StatusQueuePosition): string {
  const tens = queue.position % 100;
  const suffix =
    tens >= 11 && tens <= 13 ? "th" : (["th", "st", "nd", "rd"][queue.position % 10] ?? "th");
  const slots = queue.totalSlots === 1 ? "runner slot" : "runner slots";
  return `Queued, ${queue.position}${suffix} in line. ${queue.busySlots} of ${queue.totalSlots} ${slots} ${queue.busySlots === 1 ? "is" : "are"} busy.`;
}

export function skillVersionLabel(version: string): string {
  return /^[0-9a-f]{40}$/.test(version) ? version.slice(0, 7) : version;
}

/** Hours and minutes on a 24-hour clock in local time, such as 22:40. */
export function clock24(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

const HTTP = new Set(["http:", "https:"]);

export function parseEngineUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (!HTTP.has(url.protocol) || url.username || url.password) return null;
  return url.toString();
}
