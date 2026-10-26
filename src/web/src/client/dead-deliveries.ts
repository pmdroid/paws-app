import type { StatusDeadDelivery, StatusSnapshot } from "../contract";
import { esc, utcClock } from "./format";

const OBSOLETE = "From an earlier state of this issue. Paws will not retry it.";

const NAMES: Record<string, string> = {
  "linear.elicitation": "Linear question",
  "linear.activity": "Linear activity",
  "linear.status": "Linear issue status",
};

/**
 * Dead outbox rows and dead jobs of one issue, each with a retry unless it is obsolete. A dead Linear delivery holds
 * every later update of its session, so the page names it instead of leaving the session quiet.
 */
export function deadDeliveriesSection(snapshot: StatusSnapshot, itemId: string): string {
  const dead = (snapshot.dead ?? []).filter((entry) => entry.itemId === itemId);
  if (dead.length === 0) return "";
  return `<section class="closeout-result blocked dead-deliveries" id="dead-deliveries" aria-labelledby="dead-heading"><div class="min-w-0">
    <h2 id="dead-heading">Stopped after every attempt</h2>
    <p>Paws stopped retrying ${dead.length === 1 ? "this delivery" : "these deliveries"}. A stopped Linear delivery holds the later updates of its session until it is retried.</p>
    <ul class="overview-work" role="list">${dead.map(row).join("")}</ul>
    <p class="muted" role="status" data-dead-message=""></p>
  </div></section>`;
}

function row(entry: StatusDeadDelivery): string {
  const name =
    entry.kind === "outbox" ? (NAMES[entry.name] ?? `Delivery ${entry.name}`) : `Job ${entry.name}`;
  const facts = `${entry.attempts} attempt${entry.attempts === 1 ? "" : "s"}, ${entry.kind === "job" ? "stopped" : "queued"} at ${utcClock(entry.at)} UTC`;
  return `<li class="overview-row"><div class="overview-copy"><div><b>${esc(name)}</b> <span class="muted">${esc(facts)}</span></div>${entry.lastError ? `<p class="muted">Last error: ${esc(entry.lastError)}</p>` : ""}${entry.retryable === false ? `<p class="muted">${esc(OBSOLETE)}</p>` : ""}</div>${entry.retryable === false ? "" : `<button class="btn sm" type="button" data-retry="${esc(entry.target)}" hidden="">Retry</button>`}</li>`;
}
