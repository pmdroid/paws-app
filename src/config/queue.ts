import type { PawsConfigFile } from "./file";

export const DEFAULT_QUEUE_START_TIMEOUT_HOURS = 24;
export const MAX_QUEUE_START_TIMEOUT_HOURS = 720;

/** Workspace queue settings. A queued task fails when it has not started after this long. */
export type QueueSettings = { startTimeoutHours: number };

export function readQueueSettings(config: PawsConfigFile): QueueSettings {
  const hours = config.queueStartTimeoutHours ?? DEFAULT_QUEUE_START_TIMEOUT_HOURS;
  return {
    startTimeoutHours: Math.min(Math.max(hours, 1), MAX_QUEUE_START_TIMEOUT_HOURS),
  };
}

export function parseQueueSettings(value: unknown): QueueSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("queue must be an object");
  if (Object.keys(value).some((key) => key !== "startTimeoutHours"))
    throw new Error("queue has an unknown key");
  const { startTimeoutHours } = value as Record<string, unknown>;
  if (
    typeof startTimeoutHours !== "number" ||
    !Number.isInteger(startTimeoutHours) ||
    startTimeoutHours < 1 ||
    startTimeoutHours > MAX_QUEUE_START_TIMEOUT_HOURS
  )
    throw new Error(
      `queue.startTimeoutHours must be a whole number of hours from 1 to ${MAX_QUEUE_START_TIMEOUT_HOURS}`,
    );
  return { startTimeoutHours };
}

export function renderQueueSettings(config: { queueStartTimeoutHours?: number }): string {
  return config.queueStartTimeoutHours === undefined
    ? ""
    : `\n[queue]\nstart_timeout_hours = ${config.queueStartTimeoutHours}\n`;
}

/** Replace the `[queue]` table, keeping every other line. */
export function setQueueSettingsText(current: string, settings: QueueSettings): string {
  let section = "";
  const retained = current
    .split(/\r?\n/)
    .filter((line) => {
      const heading = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
      if (heading?.[1]) section = heading[1].trim().toLowerCase();
      return section !== "queue";
    })
    .join("\n")
    .trimEnd();
  const table = renderQueueSettings({ queueStartTimeoutHours: settings.startTimeoutHours });
  return retained === "" ? table.trimStart() : `${retained}\n${table}`;
}

/** "24 hours", "1 hour", "3 days". */
export function formatQueueTimeout(hours: number): string {
  if (hours >= 48 && hours % 24 === 0) return `${hours / 24} days`;
  return hours === 1 ? "1 hour" : `${hours} hours`;
}
