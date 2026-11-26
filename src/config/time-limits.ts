import { z } from "zod";
import type { StageLimits } from "../core";
import { saveSettingsSection, type PawsConfigFile } from "./file";

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

export function parseTimeLimitTables(section: unknown): Pick<PawsConfigFile, "timeLimits"> {
  if (section === undefined) return {};
  const parsed = tomlSchema.safeParse({ time_limits: section });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `Saved settings ${issue?.path.join(".") ?? "time_limits"} ${issue?.message ?? "is invalid"}`,
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

export function writeTimeLimits(path: string, settings: StoredTimeLimits): Promise<void> {
  return saveSettingsSection(path, "time_limits", {
    ...(settings.implementationMinutes === undefined
      ? {}
      : { implementation_minutes: settings.implementationMinutes }),
    ...(settings.fixesMinutes === undefined ? {} : { fixes_minutes: settings.fixesMinutes }),
    ...(settings.closeoutMinutes === undefined
      ? {}
      : { closeout_minutes: settings.closeoutMinutes }),
  });
}
