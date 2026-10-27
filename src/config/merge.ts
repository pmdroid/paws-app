import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { HIGH_RISK_GLOBS_MAX, highRiskGlobError } from "../core";
import { replaceConfigText } from "./agents";
import type { PawsConfigFile } from "./file";

export const DEFAULT_CI_FIX_ATTEMPTS = 3;
export const MAX_CI_FIX_ATTEMPTS = 10;

/** `queue`: one pull request at a time per repository. `ci-green`: each merges on its own green CI. */
export const MERGE_ORDERS = ["queue", "ci-green", "github-queue"] as const;
/**
 * What happens when main moved before the merge. `ci` (default): rebase, and the new head merges
 * once its CI is green. `overlap`: merge without a rebase when main changed none of the pull
 * request's files or packages. `closeout`: rebase and run Closeout again on the new head.
 */
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
/**
 * Per repository. `ignoreCommentBots` replaces `DEFAULT_IGNORED_COMMENT_BOTS` for the repository:
 * bot logins whose pull request comments only report status and never restart the item.
 * `highRiskPaths` are the globs that make a candidate's risk tier high; the repository's
 * `.paws/high-risk-paths` file can add to them.
 */
export type MergeRepositories = Record<
  string,
  { packages: string[]; ignoreCommentBots?: string[]; highRiskPaths?: string[] }
>;
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

/**
 * Bots that comment on pull requests with status, not findings: deploy previews, coverage
 * summaries and tracker backlinks. Cloudflare Pages and Linear are the ones on pmdroid/paws-app.
 */
export const DEFAULT_IGNORED_COMMENT_BOTS = [
  "cloudflare-workers-and-pages[bot]",
  "linear[bot]",
  "linear-code[bot]",
  "codecov[bot]",
  "netlify[bot]",
  "vercel[bot]",
  "changeset-bot[bot]",
] as const;

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const PACKAGE_ROOT = /^(?:[^/*\s\\]+|\*)(?:\/(?:[^/*\s\\]+|\*))*\/?$/;
const LABEL_MAX = 200;
const BOT_LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]*(\[bot\])?$/;
const highRiskGlob = z.string().superRefine((glob, context) => {
  const error = highRiskGlobError(glob);
  if (error) context.addIssue({ code: "custom", message: error });
});
const highRiskGlobs = z
  .array(highRiskGlob)
  .max(HIGH_RISK_GLOBS_MAX)
  .refine((list) => new Set(list).size === list.length, { message: "lists a path twice" });

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
              .max(100)
              .default([]),
            ignore_comment_bots: z
              .array(z.string().regex(BOT_LOGIN, "must be a GitHub login such as codecov[bot]"))
              .max(100)
              .optional(),
            high_risk_paths: highRiskGlobs.optional(),
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
  const mainMoved = config.mainMoved;
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

/** Bot logins whose comments on this repository's pull requests Paws ignores, lowercased. */
export function ignoredCommentBots(settings: MergeSettings, repository: string): string[] {
  const wanted = repository.toLowerCase();
  const configured = Object.entries(settings.repositories).find(
    ([name]) => name.toLowerCase() === wanted,
  )?.[1].ignoreCommentBots;
  return (configured ?? DEFAULT_IGNORED_COMMENT_BOTS).map((login) => login.toLowerCase());
}

/** The high-risk globs Paws settings give this repository. */
export function highRiskPaths(settings: MergeSettings, repository: string): string[] {
  const wanted = repository.toLowerCase();
  return (
    Object.entries(settings.repositories).find(([name]) => name.toLowerCase() === wanted)?.[1]
      .highRiskPaths ?? []
  );
}

/**
 * The Settings › Merging › High-risk paths body: `[{ repository, paths }]`. It replaces every
 * repository's list; a repository left out has none.
 */
export function parseHighRiskPathSettings(value: unknown): Record<string, string[]> {
  const result = z
    .array(
      z.strictObject({
        repository: z.string().regex(REPOSITORY, "must be owner/repo"),
        paths: z.array(z.string().trim()).pipe(highRiskGlobs),
      }),
    )
    .max(100)
    .refine(
      (list) => new Set(list.map((entry) => entry.repository.toLowerCase())).size === list.length,
      { message: "lists a repository twice" },
    )
    .safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(
      `highRiskPaths${issue?.path.length ? `.${issue.path.join(".")}` : ""} ${issue?.message ?? "is invalid"}`,
    );
  }
  return Object.fromEntries(
    result.data.map((entry) => [entry.repository, entry.paths.filter((path) => path !== "")]),
  );
}

/** `repositories` with each repository's high-risk globs replaced by `paths`. */
export function withHighRiskPaths(
  repositories: MergeRepositories,
  paths: Record<string, string[]>,
): MergeRepositories {
  const next: MergeRepositories = {};
  for (const [name, value] of Object.entries(repositories)) {
    const { highRiskPaths: _old, ...rest } = value;
    next[name] = rest;
  }
  for (const [repository, globs] of Object.entries(paths)) {
    if (globs.length === 0) continue;
    const name =
      Object.keys(next).find((key) => key.toLowerCase() === repository.toLowerCase()) ?? repository;
    next[name] = { packages: [], ...next[name], highRiskPaths: globs };
  }
  return next;
}

export function repositoryPackages(settings: MergeSettings, repository: string): string[] {
  const wanted = repository.toLowerCase();
  return (
    Object.entries(settings.repositories).find(([name]) => name.toLowerCase() === wanted)?.[1]
      .packages ?? []
  );
}

/** `[merge.projects."…"]` and `[[merge.rules]]`. The flat `[merge]` keys are read in `file.ts`. */
export function parseMergeTables(
  text: string,
): Pick<PawsConfigFile, "mergeProjects" | "mergeRules" | "mergeRepositories"> {
  if (!/^\s*\[\[?\s*merge\.(projects|rules|repositories)/m.test(text)) return {};
  const parsed = tomlSchema.safeParse(Bun.TOML.parse(text));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `config.toml ${issue?.path.join(".") ?? "merge"} ${issue?.message ?? "is invalid"}`,
    );
  }
  const merge = parsed.data.merge;
  const projects = Object.entries(merge?.projects ?? {});
  const repositories = Object.entries(merge?.repositories ?? {});
  return {
    ...(repositories.length
      ? {
          mergeRepositories: Object.fromEntries(
            repositories.map(([name, value]) => [
              name,
              {
                packages: value.packages,
                ...(value.ignore_comment_bots === undefined
                  ? {}
                  : { ignoreCommentBots: value.ignore_comment_bots }),
                ...(value.high_risk_paths === undefined
                  ? {}
                  : { highRiskPaths: value.high_risk_paths }),
              },
            ]),
          ),
        }
      : {}),
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
          .join(", ")}]\n${
          value.ignoreCommentBots === undefined
            ? ""
            : `ignore_comment_bots = [${value.ignoreCommentBots.map((login) => JSON.stringify(login)).join(", ")}]\n`
        }${
          value.highRiskPaths === undefined
            ? ""
            : `high_risk_paths = [${value.highRiskPaths.map((glob) => JSON.stringify(glob)).join(", ")}]\n`
        }`,
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

/**
 * Write the Merging settings, keeping `ci_fix_attempts` and every other table. `riskPaths`,
 * when given, replaces each repository's high-risk globs.
 */
export function writeMergePolicy(
  path: string,
  policy: MergePolicy,
  current: StoredMerge,
  riskPaths?: Record<string, string[]>,
): void {
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const repositories =
    riskPaths === undefined
      ? current.repositories
      : withHighRiskPaths(current.repositories ?? {}, riskPaths);
  replaceConfigText(
    path,
    setMergeSettingsText(text, {
      ...policy.default,
      ...(current.ciFixAttempts === undefined ? {} : { ciFixAttempts: current.ciFixAttempts }),
      projects: policy.projects,
      rules: policy.rules,
      ...(repositories && Object.keys(repositories).length ? { repositories } : {}),
    }),
  );
}
