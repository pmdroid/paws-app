import type { PawsConfigFile } from "./file";

export const DEFAULT_QUEUE_START_TIMEOUT_HOURS = 24;
export const MAX_QUEUE_START_TIMEOUT_HOURS = 720;
export const MAX_RUNNING_PER_OWNER = 1000;

/** How long a delegated task may wait for a runner slot before Paws fails it. */
export type QueueSettings = { startTimeoutHours: number; maxRunningPerOwner: number | null };

export function readQueueSettings(config: PawsConfigFile): QueueSettings {
  const hours = config.queueStartTimeoutHours ?? DEFAULT_QUEUE_START_TIMEOUT_HOURS;
  return {
    startTimeoutHours: Math.min(Math.max(hours, 1), MAX_QUEUE_START_TIMEOUT_HOURS),
    maxRunningPerOwner:
      config.queueMaxRunningPerOwner === undefined || config.queueMaxRunningPerOwner < 1
        ? null
        : Math.min(config.queueMaxRunningPerOwner, MAX_RUNNING_PER_OWNER),
  };
}

/** A missing key keeps the stored value. */
export function parseQueueSettings(value: unknown): Partial<QueueSettings> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("queue must be an object");
  if (Object.keys(value).some((key) => key !== "startTimeoutHours" && key !== "maxRunningPerOwner"))
    throw new Error("queue has an unknown key");
  const { startTimeoutHours, maxRunningPerOwner } = value as Record<string, unknown>;
  if (
    maxRunningPerOwner !== undefined &&
    maxRunningPerOwner !== null &&
    (typeof maxRunningPerOwner !== "number" ||
      !Number.isInteger(maxRunningPerOwner) ||
      maxRunningPerOwner < 1 ||
      maxRunningPerOwner > MAX_RUNNING_PER_OWNER)
  )
    throw new Error(
      `queue.maxRunningPerOwner must be empty or a whole number from 1 to ${MAX_RUNNING_PER_OWNER}`,
    );
  const cap =
    maxRunningPerOwner === undefined
      ? {}
      : { maxRunningPerOwner: maxRunningPerOwner as number | null };
  if (startTimeoutHours === undefined) return cap;
  if (
    typeof startTimeoutHours !== "number" ||
    !Number.isInteger(startTimeoutHours) ||
    startTimeoutHours < 1 ||
    startTimeoutHours > MAX_QUEUE_START_TIMEOUT_HOURS
  )
    throw new Error(
      `queue.startTimeoutHours must be a whole number of hours from 1 to ${MAX_QUEUE_START_TIMEOUT_HOURS}`,
    );
  return { startTimeoutHours, ...cap };
}

export function renderQueueSettings(settings: Partial<QueueSettings>): string {
  const lines = [
    ...(settings.startTimeoutHours === undefined
      ? []
      : [`start_timeout_hours = ${settings.startTimeoutHours}`]),
    ...(settings.maxRunningPerOwner == null
      ? []
      : [`max_running_per_owner = ${settings.maxRunningPerOwner}`]),
  ];
  return lines.length ? `\n[queue]\n${lines.join("\n")}\n` : "";
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
  const table = renderQueueSettings(settings);
  return retained === "" ? table.trimStart() : `${retained}\n${table}`;
}
