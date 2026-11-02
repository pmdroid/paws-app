import type { StatusPolicyRunnerWarning, StatusSnapshot } from "../contract";
import { esc } from "./format";

/** One banner per repository whose Closeout policy uses keys the lowest online runner lacks. */
export function renderPolicyRunnerWarnings(snapshot: StatusSnapshot): string {
  return (snapshot.policyRunnerWarnings ?? []).map(banner).join("");
}

function banner(warning: StatusPolicyRunnerWarning): string {
  const keys = warning.keys
    .map((entry) => `<li><code>${esc(entry.key)}</code> needs runner ${esc(entry.needs)}</li>`)
    .join("");
  return `<section class="settings-message policy-runners" role="alert" aria-label="${esc(`Closeout policy needs a newer runner for ${warning.repository}`)}">
    <p><b>${esc(warning.repository)}</b>: the Closeout policy uses keys runner ${esc(warning.runnerVersion)} does not know. That runner leaves them out and runs the rest of the policy.</p>
    <ul class="mt-2 list-disc pl-5">${keys}</ul>
    <p class="muted mt-2">Update the runners to apply them. Policy ${esc(warning.policyDigest.slice(0, 19))}.</p>
  </section>`;
}
