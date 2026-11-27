import { journalCaught } from "../journal";
import { ago, esc } from "./format";

export const ALERTS_API_PATH = "/api/alerts";

const SEVERITIES = ["critical", "warning", "info"] as const;

export type HealthAlertSeverity = (typeof SEVERITIES)[number];

export interface HealthAlert {
  id: string;
  severity: HealthAlertSeverity;
  title: string;
  detail: string;
  since: number;
  count: number;
}

function readAlert(input: unknown): HealthAlert | null {
  if (typeof input !== "object" || input === null) return null;
  const entry = input as Record<string, unknown>;
  const severity = SEVERITIES.find((value) => value === entry.severity);
  if (
    severity === undefined ||
    typeof entry.id !== "string" ||
    typeof entry.title !== "string" ||
    typeof entry.detail !== "string" ||
    typeof entry.since !== "number" ||
    typeof entry.count !== "number"
  )
    return null;
  return {
    id: entry.id,
    severity,
    title: entry.title,
    detail: entry.detail,
    since: entry.since,
    count: entry.count,
  };
}

export function parseHealthAlerts(input: unknown): HealthAlert[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap((entry) => {
    const alert = readAlert(entry);
    return alert === null ? [] : [alert];
  });
}

export async function readHealthAlerts(): Promise<HealthAlert[]> {
  try {
    const response = await fetch(ALERTS_API_PATH, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) return [];
    return parseHealthAlerts(await response.json());
  } catch (caught) {
    journalCaught(caught, "healthAlerts.read", null);
    return [];
  }
}

const LABELS: Record<HealthAlertSeverity, string> = {
  critical: "Critical",
  warning: "Warning",
  info: "Info",
};

function line(alert: HealthAlert, now: string): string {
  const since = Number.isFinite(alert.since) ? ago(new Date(alert.since).toISOString(), now) : "";
  const facts = [since ? `since ${since}` : "", `count ${alert.count}`].filter(Boolean).join(" · ");
  return `<li class="health-alert" data-severity="${alert.severity}" data-alert="${esc(alert.id)}"><span class="health-alert-severity">${LABELS[alert.severity]}</span><div class="min-w-0"><p><b>${esc(alert.title)}</b></p><p class="health-alert-detail">${esc(alert.detail)}</p><p class="muted">${esc(facts)}</p></div></li>`;
}

export function renderHealthAlerts(
  alerts: readonly HealthAlert[] | undefined,
  now: string,
): string {
  if (!alerts?.length) return "";
  return `<section class="health-alerts" role="alert" aria-label="Health alerts"><ul role="list">${alerts.map((alert) => line(alert, now)).join("")}</ul></section>`;
}
