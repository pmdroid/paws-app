import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { replaceConfigText } from "./agents";
import type { PawsConfigFile } from "./file";

export const DEFAULT_CI_FIX_ATTEMPTS = 3;
export const MAX_CI_FIX_ATTEMPTS = 10;

/** `queue`: one pull request at a time per repository. `ci-green`: each merges on its own green CI. */
export const MERGE_ORDERS = ["queue", "ci-green", "github-queue"] as const;
/** What happens when main moved before the merge. `closeout` was the PAS-389 switch. */
export const MAIN_MOVED = ["overlap", "ci", "closeout"] as const;

export type MergeOrder = (typeof MERGE_ORDERS)[number];
export type MainMoved = (typeof MAIN_MOVED)[number];
export type MergeChoice = { order: MergeOrder; mainMoved: MainMoved };
/** A missing choice inherits from the next level. */
export type MergeOverride = Partial<MergeChoice>;
export type MergeRule = MergeOverride & { project?: string; label: string };
export type MergePolicy = {
  default: MergeChoice;
  /** Keyed by Linear project id. An empty override uses the workspace default. */
  projects: Record<string, MergeOverride>;
  rules: MergeRule[];
};
/** `[merge.repositories."owner/repo"]`: package roots such as `apps/*` (PAS-394). */
export type MergeRepositories = Record<string, { packages: string[] }>;
export type MergeSettings = MergePolicy & {
  ciFixAttempts: number;
  repositories: MergeRepositories;
};
/** The `[merge]` tables as written. Missing keys are not rendered. */
export type StoredMerge = Partial<MergeChoice> & {
  ciFixAttempts?: number;
  projects: Record<string, MergeOverride>;
  rules: MergeRule[];
  repositories?: MergeRepositories;
};
export type MergeLevel = "rule" | "project" | "default";
export type ResolvedMergeSettings = MergeChoice & {
  sources: Record<keyof MergeChoice, MergeLevel>;
  rule?: { project?: string; label: string };
};

export const DEFAULT_MERGE_CHOICE: MergeChoice = { order: "queue", mainMoved: "ci" };

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
/** A relative path whose segments are names or `*`. */
const PACKAGE_ROOT = /^(?:[^/*\s\\]+|\*)(?:\/(?:[^/*\s\\]+|\*))*\/?$/;
const LABEL_MAX = 200;

const override = {
  order: z.enum(MERGE_ORDERS).optional(),
  mainMoved: z.enum(MAIN_MOVED).optional(),
};
const projectId = z.string().regex(PROJECT_ID, "must be a Linear project id");
const label = z
  .string()
  .trim()
  .min(1)
  .max(LABEL_MAX)
  .refine(
    (value) => [...value].every((char) => char.charCodeAt(0) > 31),
    "has a control character",
  );
const policySchema = z.strictObject({
  default: z.strictObject({ order: z.enum(MERGE_ORDERS), mainMoved: z.enum(MAIN_MOVED) }),
  projects: z
    .array(z.strictObject({ id: projectId, ...override }))
    .max(500)
    .refine((list) => new Set(list.map((entry) => entry.id)).size === list.length, {
      message: "lists a project twice",
    }),
  rules: z
    .array(z.strictObject({ project: projectId.optional(), label, ...override }))
    .max(500)
    .refine(
      (list) =>
        new Set(list.map((rule) => `${rule.project ?? ""}\0${rule.label.toLowerCase()}`)).size ===
        list.length,
      { message: "lists a rule twice" },
    ),
});
const tomlSchema = z.object({
  merge: z
    .object({
      projects: z
        .record(
          projectId,
          z.strictObject({ order: override.order, main_moved: override.mainMoved }),
        )
        .optional(),
      repositories: z
        .record(
          z.string().regex(REPOSITORY, "must be owner/repo"),
          z.strictObject({
            packages: z
              .array(
                z
                  .string()
                  .regex(PACKAGE_ROOT, "must be a package root such as apps/*")
                  .refine((root) => !root.split("/").includes(".."), "must stay in the repository"),
              )
              .max(100),
          }),
        )
        .optional(),
      rules: z
        .array(
          z.strictObject({
            project: projectId.optional(),
            label,
            order: override.order,
            main_moved: override.mainMoved,
          }),
        )
        .optional(),
    })
    .optional(),
});

export function storedMerge(config: PawsConfigFile): StoredMerge {
  const mainMoved =
    config.mainMoved ??
    (config.closeoutAfterUpdate === undefined
      ? undefined
      : config.closeoutAfterUpdate
        ? "closeout"
        : "ci");
  return {
    ...(config.mergeOrder === undefined ? {} : { order: config.mergeOrder }),
    ...(mainMoved === undefined ? {} : { mainMoved }),
    ...(config.ciFixAttempts === undefined ? {} : { ciFixAttempts: config.ciFixAttempts }),
    projects: config.mergeProjects ?? {},
    rules: config.mergeRules ?? [],
    ...(config.mergeRepositories ? { repositories: config.mergeRepositories } : {}),
  };
}

export function readMergeSettings(config: PawsConfigFile): MergeSettings {
  const stored = storedMerge(config);
  return {
    default: {
      order: stored.order ?? DEFAULT_MERGE_CHOICE.order,
      mainMoved: stored.mainMoved ?? DEFAULT_MERGE_CHOICE.mainMoved,
    },
    projects: stored.projects,
    rules: stored.rules,
    repositories: stored.repositories ?? {},
    ciFixAttempts: Math.min(stored.ciFixAttempts ?? DEFAULT_CI_FIX_ATTEMPTS, MAX_CI_FIX_ATTEMPTS),
  };
}

/**
 * The merge settings for one task: the first issue rule whose label is on the issue, then the
 * issue's Linear project, then the workspace default. A rule for the issue's project wins over a
 * rule for any project. Each choice inherits on its own.
 */
export function resolveMergeSettings(
  item: { projectId: string | null; labels: readonly string[] },
  policy: MergePolicy,
): ResolvedMergeSettings {
  const labels = new Set(item.labels.map((name) => name.trim().toLowerCase()));
  const matches = (rule: MergeRule) => labels.has(rule.label.trim().toLowerCase());
  const rule =
    policy.rules.find(
      (entry) => entry.project !== undefined && entry.project === item.projectId && matches(entry),
    ) ?? policy.rules.find((entry) => entry.project === undefined && matches(entry));
  const project = item.projectId === null ? undefined : policy.projects[item.projectId];
  const pick = <K extends keyof MergeChoice>(key: K): [MergeChoice[K], MergeLevel] => {
    const fromRule: MergeOverride[K] = rule?.[key];
    if (fromRule !== undefined) return [fromRule as MergeChoice[K], "rule"];
    const fromProject: MergeOverride[K] = project?.[key];
    if (fromProject !== undefined) return [fromProject as MergeChoice[K], "project"];
    return [policy.default[key], "default"];
  };
  const [order, orderSource] = pick("order");
  const [mainMoved, mainMovedSource] = pick("mainMoved");
  return {
    order,
    mainMoved,
    sources: { order: orderSource, mainMoved: mainMovedSource },
    ...(rule
      ? {
          rule: {
            ...(rule.project === undefined ? {} : { project: rule.project }),
            label: rule.label,
          },
        }
      : {}),
  };
}

/** Package roots for one repository. Without them, only the same file overlaps. */
export function repositoryPackages(settings: MergeSettings, repository: string): string[] {
  const wanted = repository.toLowerCase();
  return (
    Object.entries(settings.repositories).find(([name]) => name.toLowerCase() === wanted)?.[1]
      .packages ?? []
  );
}

/**
 * `[merge.projects."…"]`, `[[merge.rules]]` and `[merge.repositories."owner/repo"]`. The flat
 * `[merge]` keys are read in `file.ts`.
 */
export function parseMergeTables(
  text: string,
): Pick<PawsConfigFile, "mergeProjects" | "mergeRules" | "mergeRepositories"> {
  if (!/^\s*\[\[?\s*merge\.(projects|rules|repositories)/m.test(text)) return {};
  const merge = tomlSchema.parse(Bun.TOML.parse(text)).merge;
  const projects = Object.entries(merge?.projects ?? {});
  const repositories = Object.entries(merge?.repositories ?? {});
  return {
    ...(repositories.length ? { mergeRepositories: Object.fromEntries(repositories) } : {}),
    ...(projects.length
      ? {
          mergeProjects: Object.fromEntries(projects.map(([id, value]) => [id, fromToml(value)])),
        }
      : {}),
    ...(merge?.rules?.length
      ? {
          mergeRules: merge.rules.map(({ project, label: name, ...value }) => ({
            ...(project === undefined ? {} : { project }),
            label: name,
            ...fromToml(value),
          })),
        }
      : {}),
  };
}

function fromToml(value: { order?: MergeOrder; main_moved?: MainMoved }): MergeOverride {
  return {
    ...(value.order === undefined ? {} : { order: value.order }),
    ...(value.main_moved === undefined ? {} : { mainMoved: value.main_moved }),
  };
}

/** The Merging settings body: `{ default, projects: [{ id, … }], rules }`. */
export function parseMergePolicy(value: unknown): MergePolicy {
  const result = policySchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(
      `merge${issue?.path.length ? `.${issue.path.join(".")}` : ""} ${issue?.message ?? "is invalid"}`,
    );
  }
  return {
    default: result.data.default,
    projects: Object.fromEntries(result.data.projects.map(({ id, ...rest }) => [id, rest])),
    rules: result.data.rules.map((rule) => ({ ...rule, label: rule.label.trim() })),
  };
}

/** Agent settings carry only `ciFixAttempts`. A missing key keeps the stored value. */
export function parseMergeSettings(value: unknown): { ciFixAttempts?: number } {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("merge must be an object");
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "ciFixAttempts")) throw new Error("merge has an unknown key");
  const { ciFixAttempts } = value as Record<string, unknown>;
  if (
    ciFixAttempts !== undefined &&
    (typeof ciFixAttempts !== "number" ||
      !Number.isInteger(ciFixAttempts) ||
      ciFixAttempts < 0 ||
      ciFixAttempts > MAX_CI_FIX_ATTEMPTS)
  )
    throw new Error(`merge.ciFixAttempts must be a whole number from 0 to ${MAX_CI_FIX_ATTEMPTS}`);
  return ciFixAttempts === undefined ? {} : { ciFixAttempts };
}

function choiceLines(value: MergeOverride): string[] {
  return [
    ...(value.order === undefined ? [] : [`order = ${JSON.stringify(value.order)}`]),
    ...(value.mainMoved === undefined ? [] : [`main_moved = ${JSON.stringify(value.mainMoved)}`]),
  ];
}

export function renderMergeSettings(settings: StoredMerge): string {
  const lines = [
    ...choiceLines(settings),
    ...(settings.ciFixAttempts === undefined
      ? []
      : [`ci_fix_attempts = ${settings.ciFixAttempts}`]),
  ];
  return [
    lines.length === 0 ? "" : `\n[merge]\n${lines.join("\n")}\n`,
    ...Object.entries(settings.projects).map(
      ([id, value]) =>
        `\n[merge.projects.${JSON.stringify(id)}]\n${choiceLines(value)
          .map((line) => `${line}\n`)
          .join("")}`,
    ),
    ...settings.rules.map(
      (rule) =>
        `\n[[merge.rules]]\n${[
          ...(rule.project === undefined ? [] : [`project = ${JSON.stringify(rule.project)}`]),
          `label = ${JSON.stringify(rule.label)}`,
          ...choiceLines(rule),
        ].join("\n")}\n`,
    ),
    ...Object.entries(settings.repositories ?? {}).map(
      ([repository, value]) =>
        `\n[merge.repositories.${JSON.stringify(repository)}]\npackages = [${value.packages
          .map((root) => JSON.stringify(root))
          .join(", ")}]\n`,
    ),
  ].join("");
}

/** Replace every `[merge…]` table, keeping every other line. */
export function setMergeSettingsText(current: string, settings: StoredMerge): string {
  let section = "";
  const retained = current
    .split(/\r?\n/)
    .filter((line) => {
      const heading = /^\s*\[\[?\s*([^[\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
      if (heading?.[1]) section = heading[1].toLowerCase();
      return section !== "merge" && !section.startsWith("merge.");
    })
    .join("\n")
    .trimEnd();
  const table = renderMergeSettings(settings);
  return retained === "" ? table.trimStart() : `${retained}\n${table}`;
}

/** Write the Merging settings, keeping `ci_fix_attempts` and every other table. */
export function writeMergePolicy(path: string, policy: MergePolicy, current: StoredMerge): void {
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  replaceConfigText(
    path,
    setMergeSettingsText(text, {
      ...policy.default,
      ...(current.ciFixAttempts === undefined ? {} : { ciFixAttempts: current.ciFixAttempts }),
      projects: policy.projects,
      rules: policy.rules,
      ...(current.repositories ? { repositories: current.repositories } : {}),
    }),
  );
}
