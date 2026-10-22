import type { StatusPawsUpdate } from "../contract";
import { esc } from "./format";

const PHASE_TEXT = {
  working: "is working",
  closeout: "is in Closeout",
  resuming: "is resuming",
} as const;

/** The "Paws update waiting" banner at the top of the overview. */
export function updateBanner(update: StatusPawsUpdate | undefined): string {
  if (!update) return "";
  const target = esc(update.target.slice(0, 7));
  const failed = update.status === "failed";
  const now = update.status === "applying" || update.nowRequested || update.waitingFor === 0;
  const heading = failed ? "Paws update failed" : now ? "Paws is updating" : "Paws update waiting";
  const title = failed
    ? `Paws stays on ${esc(update.current.slice(0, 7))}`
    : now
      ? `Updating to ${target} now`
      : `Updating to ${target} when ${update.waitingFor} task${update.waitingFor === 1 ? " finishes" : "s finish"}`;
  const hidden = update.waitingFor - update.holding.length;
  const body = failed
    ? [`The update to ${target} did not apply. ${update.error ?? ""}`.trim()]
    : now
      ? ["Paws restarts on the new code in a moment."]
      : [
          "New work waits until the update.",
          ...update.holding.map(
            (item) => `${item.id} ${PHASE_TEXT[item.phase]} and keeps running.`,
          ),
          ...(hidden > 0 ? [`${hidden} more running elsewhere.`] : []),
        ];
  const actions = failed
    ? '<button class="btn" type="button" data-action="paws-update-cancel">Dismiss</button>'
    : update.status === "waiting"
      ? `${update.nowRequested ? "" : '<button class="btn" type="button" data-action="paws-update-now">Update now</button>'}<button class="btn" type="button" data-action="paws-update-cancel">Cancel</button>`
      : "";
  return `<section class="update-banner" aria-labelledby="update-heading">
    <div class="between"><h2 id="update-heading">${heading}</h2>${actions ? `<div class="row">${actions}</div>` : ""}</div>
    <div class="update-card"><span class="update-count" aria-hidden="true">${failed ? "!" : update.waitingFor}</span><div class="update-copy"><p class="update-title">${title}</p><p>${body.map(esc).join(" ")}</p></div></div>
    <p class="muted" role="status" data-paws-update-message></p>
  </section>`;
}
