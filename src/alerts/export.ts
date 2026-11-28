import { SeverityNumber, type LogRecord } from "@opentelemetry/api";
import {
  clearExportedAlertsSteps,
  exportedAlertsSteps,
  deliveredAlertEventsSteps,
  observeAlertsSteps,
  pendingAlertEventsSteps,
  type Db,
  readSetting,
  type ExportedAlertRow,
} from "../db";
import { TELEMETRY_SETTINGS_KEY, type Telemetry } from "../telemetry";
import { readAlerts, type AlertSeverity } from "./alerts";

export const ALERTS_EXPORT_JOB = "alerts.export";
export const ALERTS_EXPORT_EVERY_MS = 60_000;
export const ALERTS_EXPORT_MAX_RECORDS = 200;

const RANK: Record<AlertSeverity, number> = { info: 0, warning: 1, critical: 2 };
const OTLP_SEVERITY: Record<string, [SeverityNumber, string]> = {
  critical: [SeverityNumber.ERROR, "ERROR"],
  warning: [SeverityNumber.WARN, "WARN"],
  info: [SeverityNumber.INFO, "INFO"],
};

const eventId = (event: string, alert: ExportedAlertRow) => `${event}:${alert.key}:${alert.since}`;

const logRecord = (event: string, alert: ExportedAlertRow, now: number): LogRecord => {
  const [severityNumber, severityText] = OTLP_SEVERITY[alert.severity] ?? OTLP_SEVERITY.info!;
  return {
    eventName: event,
    timestamp: now,
    severityNumber,
    severityText,
    body: alert.title,
    attributes: {
      "paws.alert.event_id": eventId(event, alert),
      "paws.alert.key": alert.key,
      "paws.alert.title": alert.title,
      "paws.alert.since": alert.since,
      "paws.alert.count": alert.count,
    },
  };
};

export async function exportAlerts(db: Db, telemetry: Telemetry, now = Date.now()): Promise<void> {
  const settings = telemetry.settings();
  if (!settings.enabled || !settings.alerts.enabled) {
    await db.run((q) => clearExportedAlertsSteps(q));
    return;
  }
  const saved = await readSetting(db, TELEMETRY_SETTINGS_KEY);
  const floor = RANK[settings.alerts.minSeverity];
  const open = new Map<string, ExportedAlertRow>();
  for (const alert of await readAlerts(db, now))
    if (RANK[alert.severity] >= floor)
      open.set(alert.id, {
        key: alert.id,
        severity: alert.severity,
        title: alert.title,
        since: alert.since,
        count: alert.count,
      });
  const stored = await db.run((q) => exportedAlertsSteps(q));
  const known = new Set(stored.map((row) => row.key));
  const raised = [...open.values()].filter((alert) => !known.has(alert.key));
  const gone = stored.filter((row) => !open.has(row.key));
  const events = [
    ...raised.map((alert) => ({ ...alert, event: "paws.alert.raised" })),
    ...(settings.alerts.sendCleared ? gone : []).map((row) => ({
      ...row,
      event: "paws.alert.cleared",
    })),
  ].map((row) => ({ ...row, eventId: eventId(row.event, row) }));
  const observed = await db.run((q) =>
    observeAlertsSteps(q, {
      raised,
      gone: gone.map((row) => row.key),
      events,
      settings: { key: TELEMETRY_SETTINGS_KEY, value: saved },
    }),
  );
  if (!observed) return;
  const pending = await db.run((q) => pendingAlertEventsSteps(q, ALERTS_EXPORT_MAX_RECORDS));
  if (pending.length === 0) return;
  if (!(await telemetry.sendAlerts(pending.map((row) => logRecord(row.event, row, now))))) return;
  await db.run((q) =>
    deliveredAlertEventsSteps(
      q,
      pending.map((row) => row.id),
    ),
  );
}
