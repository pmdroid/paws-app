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
export type StoredTimeLimits = TimeLimitMinutes & { projects: Record<string, TimeLimitMinutes> };
export type TimeLimitSettings = {
  configured: boolean;
  default: Required<TimeLimitMinutes>;
  projects: (TimeLimitMinutes & { id: string })[];
};

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;
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
      projects: z
        .record(
          z.string().regex(PROJECT_ID, "must be a Linear project id"),
          z.strictObject(tomlLevel),
        )
        .optional(),
    })
    .optional(),
});
const level = {
  implementationMinutes: minutes.optional(),
  fixesMinutes: minutes.optional(),
  closeoutMinutes: minutes.optional(),
};
const settingsSchema = z.strictObject({
  default: z.strictObject({
    implementationMinutes: minutes,
    fixesMinutes: minutes,
    closeoutMinutes: minutes,
  }),
  projects: z
    .array(
      z.strictObject({ id: z.string().regex(PROJECT_ID, "must be a Linear project id"), ...level }),
    )
    .max(500)
    .refine((list) => new Set(list.map((entry) => entry.id)).size === list.length, {
      message: "lists a project twice",
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
  const table = parsed.data.time_limits ?? {};
  return {
    timeLimits: {
      ...fromToml(table),
      projects: Object.fromEntries(
        Object.entries(table.projects ?? {}).map(([id, value]) => [id, fromToml(value)]),
      ),
    },
  };
}

export function resolveTimeLimits(
  config: Pick<PawsConfigFile, "timeLimits">,
  projectId: string | null,
  maxAwakeMs: number,
): StageLimits {
  const stored = config.timeLimits;
  const project = projectId === null ? undefined : stored?.projects[projectId];
  const pick = (key: keyof TimeLimitMinutes): number | undefined => project?.[key] ?? stored?.[key];
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
  const limits = resolveTimeLimits(config, null, maxAwakeMs);
  return {
    configured: config.timeLimits !== undefined,
    default: {
      implementationMinutes: Math.round(limits.implementation / 60_000),
      fixesMinutes: Math.round(limits.fixes / 60_000),
      closeoutMinutes: Math.round(limits.closeout / 60_000),
    },
    projects: Object.entries(config.timeLimits?.projects ?? {}).map(([id, value]) => ({
      id,
      ...value,
    })),
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
  return {
    ...result.data.default,
    projects: Object.fromEntries(
      result.data.projects.map(({ id, ...rest }) => [
        id,
        Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)),
      ]),
    ),
  };
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
  return [
    `\n[time_limits]\n${levelLines(settings)}`,
    ...Object.entries(settings.projects).map(
      ([id, value]) => `\n[time_limits.projects.${JSON.stringify(id)}]\n${levelLines(value)}`,
    ),
  ].join("");
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

export function writeTimeLimits(path: string, settings: StoredTimeLimits): void {
  updateConfigText(path, (text) => setTimeLimitsText(text, settings));
}
