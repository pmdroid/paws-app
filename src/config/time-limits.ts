import { z } from "zod";
import type { StageLimits } from "../core";
import { updateConfigText } from "./settings-store";
import type { PawsConfigFile } from "./file";

export const MAX_TIME_LIMIT_MINUTES = 7 * 24 * 60;

export type TimeLimitMinutes = {
  implementationMinutes?: number;
  fixesMinutes?: number;
  closeoutMinutes?: number;
};
export type StoredTimeLimits = TimeLimitMinutes;
export type TimeLimitSettings = {
  configured: boolean;
  default: Required<TimeLimitMinutes>;
};

const minutes = z
  .number()
  .int()
  .min(0)
  .max(MAX_TIME_LIMIT_MINUTES, `must be at most ${MAX_TIME_LIMIT_MINUTES} minutes`);
const tomlLevel = {
  implementation_minutes: minutes.optional(),
  fixes_minutes: minutes.optional(),
  closeout_minutes: minutes.optional(),
};
const tomlSchema = z.object({
  time_limits: z
    .strictObject({
      ...tomlLevel,
      projects: z.unknown().optional(),
    })
    .optional(),
});
const settingsSchema = z.strictObject({
  default: z.strictObject({
    implementationMinutes: minutes,
    fixesMinutes: minutes,
    closeoutMinutes: minutes,
  }),
});

function fromToml(value: {
  implementation_minutes?: number | undefined;
  fixes_minutes?: number | undefined;
  closeout_minutes?: number | undefined;
}): TimeLimitMinutes {
  return {
    ...(value.implementation_minutes === undefined
      ? {}
      : { implementationMinutes: value.implementation_minutes }),
    ...(value.fixes_minutes === undefined ? {} : { fixesMinutes: value.fixes_minutes }),
    ...(value.closeout_minutes === undefined ? {} : { closeoutMinutes: value.closeout_minutes }),
  };
}

export function parseTimeLimitTables(text: string): Pick<PawsConfigFile, "timeLimits"> {
  if (!/^\s*\[\s*time_limits\s*[\].]/m.test(text)) return {};
  const parsed = tomlSchema.safeParse(Bun.TOML.parse(text));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `config.toml ${issue?.path.join(".") ?? "time_limits"} ${issue?.message ?? "is invalid"}`,
    );
  }
  return { timeLimits: fromToml(parsed.data.time_limits ?? {}) };
}

export function resolveTimeLimits(
  config: Pick<PawsConfigFile, "timeLimits">,
  maxAwakeMs: number,
): StageLimits {
  const stored = config.timeLimits;
  const pick = (key: keyof TimeLimitMinutes): number | undefined => stored?.[key];
  const ms = (value: number | undefined, fallback: number) =>
    value === undefined ? fallback : value * 60_000;
  return {
    implementation: ms(pick("implementationMinutes"), maxAwakeMs),
    fixes: ms(pick("fixesMinutes"), 0),
    closeout: ms(pick("closeoutMinutes"), 0),
  };
}

export function readTimeLimitSettings(
  config: Pick<PawsConfigFile, "timeLimits">,
  maxAwakeMs: number,
): TimeLimitSettings {
  const limits = resolveTimeLimits(config, maxAwakeMs);
  return {
    configured: config.timeLimits !== undefined,
    default: {
      implementationMinutes: Math.round(limits.implementation / 60_000),
      fixesMinutes: Math.round(limits.fixes / 60_000),
      closeoutMinutes: Math.round(limits.closeout / 60_000),
    },
  };
}

export function parseTimeLimitSettings(value: unknown): StoredTimeLimits {
  const result = settingsSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(
      `timeLimits${issue?.path.length ? `.${issue.path.join(".")}` : ""} ${issue?.message ?? "is invalid"}`,
    );
  }
  return result.data.default;
}

function levelLines(value: TimeLimitMinutes): string {
  return [
    value.implementationMinutes === undefined
      ? null
      : `implementation_minutes = ${value.implementationMinutes}`,
    value.fixesMinutes === undefined ? null : `fixes_minutes = ${value.fixesMinutes}`,
    value.closeoutMinutes === undefined ? null : `closeout_minutes = ${value.closeoutMinutes}`,
  ]
    .filter((line) => line !== null)
    .map((line) => `${line}\n`)
    .join("");
}

export function renderTimeLimits(settings: StoredTimeLimits): string {
  return `\n[time_limits]\n${levelLines(settings)}`;
}

export function setTimeLimitsText(current: string, settings: StoredTimeLimits): string {
  let section = "";
  const retained = current
    .split(/\r?\n/)
    .filter((line) => {
      const heading = /^\s*\[\[?\s*([^[\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
      if (heading?.[1]) section = heading[1].toLowerCase();
      return section !== "time_limits" && !section.startsWith("time_limits.");
    })
    .join("\n")
    .trimEnd();
  const table = renderTimeLimits(settings);
  return retained === "" ? table.trimStart() : `${retained}\n${table}`;
}

export function writeTimeLimits(path: string, settings: StoredTimeLimits): Promise<void> {
  return updateConfigText(path, (text) => setTimeLimitsText(text, settings));
}

export async function copyCapsToTimeLimits(
  configPath: string,
  config: Pick<PawsConfigFile, "maxAwakeMs" | "timeLimits">,
): Promise<string | null> {
  if (config.maxAwakeMs === null || config.timeLimits?.implementationMinutes !== undefined)
    return null;
  const rounded = Math.ceil(config.maxAwakeMs / 60_000);
  const implementationMinutes = Math.min(rounded, MAX_TIME_LIMIT_MINUTES);
  await writeTimeLimits(configPath, { ...config.timeLimits, implementationMinutes });
  const capped =
    rounded > MAX_TIME_LIMIT_MINUTES
      ? ` (shortened from ${rounded} minutes, the most time limits allow is ${MAX_TIME_LIMIT_MINUTES})`
      : "";
  return `config.toml [caps] max_awake_ms copied to the saved time limits as implementation_minutes = ${implementationMinutes}${capped}; the [caps] key is no longer read`;
}
