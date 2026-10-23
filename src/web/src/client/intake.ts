import type { StatusIntakeEntry, StatusLinearBudget, StatusSnapshot } from "../contract";
import { esc, utcClock } from "./format";

export function renderIntake(snapshot: StatusSnapshot): string {
  const waiting = snapshot.intake ?? [];
  const budget = snapshot.linearBudget;
  const webhook = snapshot.linearWebhook;
  if (!waiting.length && !budget && !webhook) return "";
  const now = Date.parse(snapshot.generatedAt);
  const holdUntil =
    budget?.holdUntil && Date.parse(budget.holdUntil) > now ? budget.holdUntil : null;
  return `<section class="overview-section" aria-labelledby="intake-heading"><h2 id="intake-heading">Intake</h2>
    <p class="overview-summary">${esc(summary(waiting, now, holdUntil))}</p>
    ${webhook ? `<p class="settings-message" role="alert">${esc(`${webhook.warning} Last verified delivery ${span(now - Date.parse(webhook.lastVerifiedAt))} ago. ${webhook.fix}`)}</p>` : ""}
    ${holdUntil ? `<p role="status">Linear rate limit: waiting until ${esc(utcClock(holdUntil))} UTC</p>` : ""}
    ${budget ? budgetLine(budget) : ""}
    ${waiting.length ? `<ul class="overview-work" role="list">${waiting.map((entry) => row(entry, now)).join("")}</ul>` : ""}
  </section>`;
}

function summary(waiting: StatusIntakeEntry[], now: number, holdUntil: string | null): string {
  if (!waiting.length) return "Intake: nothing waiting";
  const oldest = Date.parse(waiting[0]!.receivedAt);
  const ready = Math.min(
    ...waiting.map((entry) => (entry.nextAttemptAt ? Date.parse(entry.nextAttemptAt) : now)),
  );
  const next = Math.max(ready, holdUntil ? Date.parse(holdUntil) : now);
  return `Intake: ${waiting.length} waiting, oldest ${span(now - oldest)}, ${next > now ? `next in ${span(next - now)}` : "next now"}`;
}

function budgetLine(budget: StatusLinearBudget): string {
  if (budget.requestsRemaining === null) return "";
  const limit = budget.requestsLimit === null ? "" : ` of ${budget.requestsLimit}`;
  return `<p class="muted">Linear budget: ${budget.requestsRemaining}${limit} requests left this hour</p>`;
}

function row(entry: StatusIntakeEntry, now: number): string {
  const retry = entry.nextAttemptAt ? Date.parse(entry.nextAttemptAt) - now : 0;
  const facts = [
    `Waiting ${span(now - Date.parse(entry.receivedAt))}`,
    ...(entry.attempts
      ? [`${entry.attempts} failed attempt${entry.attempts === 1 ? "" : "s"}`]
      : []),
    ...(retry > 0 ? [`retry in ${span(retry)}`] : []),
  ];
  return `<li class="overview-row intake-row"><div class="overview-copy"><div><span class="lin-id">${esc(entry.issue)}</span>${entry.title ? ` <b>${esc(entry.title)}</b>` : ""}</div><p class="muted">${esc(facts.join(" · "))}</p>${entry.lastError ? `<p class="muted">Last error: ${esc(entry.lastError)}</p>` : ""}</div></li>`;
}

function span(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 120 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}
