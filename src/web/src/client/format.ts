import type {
  ItemState,
  RunState,
  StatusLink,
  StatusQueuePosition,
  VerdictDecision,
} from "../contract";

const ITEM_LABEL: Record<ItemState, string> = {
  queued: "Queued",
  planning: "Planning",
  running: "Running",
  awaiting_input: "Awaiting input",
  verifying: "Verifying",
  signoff: "Needs sign-off",
  merge_queue: "In merge queue",
  merged: "Merged",
  completed: "Completed",
  exhausted: "Exhausted",
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
  exhausted: "Retry budget for this task is used up.",
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
  if (itemState === "merged") return { current: 3, detail: "Merged. This task is complete." };
  if (recheck) {
    return {
      current: 1,
      detail:
        "Implementation finished. Closeout is verifying this candidate. The task is not complete.",
    };
  }
  if (closeoutDecision === "blocked") {
    return {
      current: 1,
      detail: "Closeout is blocked and needs a person. The task is not complete.",
    };
  }
  if (closeoutDecision === "exhausted" || itemState === "exhausted") {
    return {
      current: 1,
      detail: "Closeout stopped after its retry budget. The task is not complete.",
    };
  }
  if (closeoutDecision === "rejected") {
    return { current: 1, detail: "Closeout checks failed. The task is not complete." };
  }
  if (itemState === "merge_queue") {
    return {
      current: 2,
      detail: "Closeout accepted. Waiting to merge. The task is not complete.",
    };
  }
  if (itemState === "signoff") {
    return {
      current: 1,
      detail: "Closeout accepted this high-risk change. A person still has to sign off.",
    };
  }
  if (itemState === "needs_human" || itemState === "stopped" || runState === "stopped") {
    return { current: 1, detail: "Stopped before the task was complete." };
  }
  if (itemState === "awaiting_input" || runState === "awaiting_input") {
    return {
      current: 0,
      detail: "The implementing agent is waiting for an answer. The task is not complete.",
    };
  }
  if (itemState === "verifying" || runState === "verifying") {
    return {
      current: 1,
      detail:
        "Implementation finished. Closeout is verifying this candidate. The task is not complete.",
    };
  }
  return {
    current: 0,
    detail: "The implementing agent is still working. The task is not complete.",
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
  } catch {
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

/** "Queued, 2nd in line. 4 of 4 runner slots are busy." Matches the Linear thought. */
export function queueLine(queue: StatusQueuePosition): string {
  const tens = queue.position % 100;
  const suffix =
    tens >= 11 && tens <= 13 ? "th" : (["th", "st", "nd", "rd"][queue.position % 10] ?? "th");
  const slots = queue.totalSlots === 1 ? "runner slot" : "runner slots";
  return `Queued, ${queue.position}${suffix} in line. ${queue.busySlots} of ${queue.totalSlots} ${slots} ${queue.busySlots === 1 ? "is" : "are"} busy.`;
}

/** A commit pin reads as its short hash, like the skill settings show it. */
export function skillVersionLabel(version: string): string {
  return /^[0-9a-f]{40}$/.test(version) ? version.slice(0, 7) : version;
}
