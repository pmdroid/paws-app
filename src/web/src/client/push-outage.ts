import type { StatusPushOutage, StatusSnapshot } from "../contract";
import { esc, safeHref, utcClock } from "./format";

/** One banner per repository GitHub refuses pushes from the Paws App for. */
export function renderPushOutages(snapshot: StatusSnapshot): string {
  return (snapshot.pushOutages ?? []).map(banner).join("");
}

function banner(outage: StatusPushOutage): string {
  const since = `${outage.since.slice(0, 10)} ${utcClock(outage.since)} UTC`;
  const href = outage.installationUrl ? safeHref(outage.installationUrl) : null;
  return `<section class="settings-message push-outage" role="alert" aria-label="${esc(`Push outage on ${outage.repository}`)}">
    <p><b>${esc(outage.repository)}</b>: GitHub refuses pushes from the Paws app since ${esc(since)}. Pushes wait and retry.</p>
    <p class="muted">Next try at ${esc(utcClock(outage.nextProbeAt))} UTC. Last error from GitHub:</p>
    <pre>${esc(outage.lastError)}</pre>
    ${href ? `<p><a class="btn" href="${esc(href)}" target="_blank" rel="noopener noreferrer">Check the App's permissions and repository access</a></p>` : ""}
  </section>`;
}
