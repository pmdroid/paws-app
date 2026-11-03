import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { setImplementerText, type ImplementerName, type PawsConfigFile } from "./file";
import { setMergeSettingsText, type StoredMerge } from "./merge";
import { setQueueSettingsText, type QueueSettings } from "./queue";

export type AgentProfile = { agent: ImplementerName; model: string | null; effort?: string };
export type AgentProfiles = {
  implementer: AgentProfile;
  reviewer: AgentProfile;
  reviewerFallback?: AgentProfile;
};
export type AccountLists = {
  implementer?: string[];
  reviewer?: string[];
  reviewerFallback?: string[];
};
export type ProjectAgentProfiles = {
  repo: string;
  implementer?: AgentProfile;
  reviewer?: AgentProfile;
  accounts?: Omit<AccountLists, "reviewerFallback">;
};
export type AgentSettings = {
  defaults: AgentProfiles & { accounts?: AccountLists };
  projects: ProjectAgentProfiles[];
};
export type RoleAccountPolicy = {
  agent: ImplementerName;
  accounts: string[];
  source: "project" | "defaults";
};
export type AccountPolicy = {
  revision: string;
  implementer?: RoleAccountPolicy;
  reviewer?: RoleAccountPolicy;
  reviewerFallback?: RoleAccountPolicy;
};

export const MAX_ACCOUNTS_PER_ROLE = 8;

const profileSchema = z.strictObject({
  agent: z.enum(["claude", "grok", "codex", "opencode"]),
  model: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine(
      (value) =>
        !/\s/.test(value) &&
        [...value].every((char) => char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127),
    )
    .nullable(),
  effort: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9_-]+$/)
    .optional(),
});
const accountIdSchema = z
  .string()
  .regex(
    /^(?:[0-9A-HJKMNP-TV-Z]{26}|legacy_(?:claude|codex|grok|opencode)_[A-Za-z0-9][A-Za-z0-9_-]{0,99})$/,
    "Agent account references must be account ids, not names, paths or credentials",
  );
const accountListSchema = z
  .array(accountIdSchema)
  .min(1, "An account list needs at least one account; remove it to use the default sign-in")
  .max(MAX_ACCOUNTS_PER_ROLE, `An account list holds at most ${MAX_ACCOUNTS_PER_ROLE} accounts`)
  .refine((ids) => new Set(ids).size === ids.length, "An account list names an account twice");
const projectSchema = z.strictObject({
  repo: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\/[a-zA-Z0-9_.-]+$/)
    .max(240)
    .transform((value) => value.toLowerCase()),
  implementer: profileSchema.optional(),
  reviewer: profileSchema.optional(),
  accounts: z
    .strictObject({
      implementer: accountListSchema.optional(),
      reviewer: accountListSchema.optional(),
    })
    .optional(),
});
const settingsSchema = z.strictObject({
  defaults: z.strictObject({
    implementer: profileSchema,
    reviewer: profileSchema,
    reviewerFallback: profileSchema.optional(),
    accounts: z
      .strictObject({
        implementer: accountListSchema.optional(),
        reviewer: accountListSchema.optional(),
        reviewerFallback: accountListSchema.optional(),
      })
      .optional(),
  }),
  projects: z.array(projectSchema).max(200),
});

export function parseAgentSettings(value: unknown): AgentSettings {
  const settings = pruneAccounts(settingsSchema.parse(value));
  const repos = new Set<string>();
  validateIndependence(settings.defaults);
  if (settings.defaults.reviewerFallback?.agent === settings.defaults.reviewer.agent)
    throw new Error("The reviewer fallback must use a different agent than the reviewer");
  if (settings.defaults.accounts?.reviewerFallback && !settings.defaults.reviewerFallback)
    throw new Error("Reviewer fallback accounts need a reviewer fallback profile");
  for (const project of settings.projects) {
    if (repos.has(project.repo)) throw new Error(`Duplicate project: ${project.repo}`);
    repos.add(project.repo);
    validateIndependence({ ...settings.defaults, ...project });
  }
  return settings;
}

function pruneAccounts<T extends AgentSettings>(settings: T): T {
  const empty = (lists: object | undefined) => lists && Object.keys(lists).length === 0;
  if (empty(settings.defaults.accounts)) delete settings.defaults.accounts;
  for (const project of settings.projects) if (empty(project.accounts)) delete project.accounts;
  return settings;
}

export type AgentAccountReference = {
  id: string;
  agent: ImplementerName;
  enabled: boolean;
  removed: boolean;
};

export function validateAccountReferences(
  settings: AgentSettings,
  accounts: readonly AgentAccountReference[],
): void {
  const known = new Map(accounts.map((account) => [account.id, account]));
  const check = (where: string, agent: ImplementerName, ids: readonly string[] | undefined) => {
    for (const id of ids ?? []) {
      const account = known.get(id);
      if (!account) throw new Error(`${where} names an unknown agent account ${id}`);
      if (account.removed) throw new Error(`${where} names removed agent account ${id}`);
      if (!account.enabled) throw new Error(`${where} names disabled agent account ${id}`);
      if (account.agent !== agent)
        throw new Error(
          `${where} names a ${account.agent} account for a ${agent} profile; an account cannot change the agent`,
        );
    }
  };
  const { defaults } = settings;
  check("Default implementer accounts", defaults.implementer.agent, defaults.accounts?.implementer);
  check("Default reviewer accounts", defaults.reviewer.agent, defaults.accounts?.reviewer);
  if (defaults.reviewerFallback)
    check(
      "Reviewer fallback accounts",
      defaults.reviewerFallback.agent,
      defaults.accounts?.reviewerFallback,
    );
  for (const project of settings.projects) {
    check(
      `${project.repo} implementer accounts`,
      (project.implementer ?? defaults.implementer).agent,
      project.accounts?.implementer,
    );
    check(
      `${project.repo} reviewer accounts`,
      (project.reviewer ?? defaults.reviewer).agent,
      project.accounts?.reviewer,
    );
  }
}

const REVIEW_PATHS: Partial<Record<ImplementerName, "review command" | "ACP reviewer">> = {
  claude: "review command",
  codex: "review command",
  grok: "ACP reviewer",
  opencode: "ACP reviewer",
};

function validateIndependence(profiles: AgentProfiles): void {
  for (const reviewer of [profiles.reviewer, profiles.reviewerFallback])
    if (reviewer && REVIEW_PATHS[reviewer.agent] === undefined)
      throw new Error(`Paws has no review path for ${reviewer.agent}; choose another reviewer`);
  if (
    profiles.implementer.agent === profiles.reviewer.agent &&
    profiles.implementer.model === profiles.reviewer.model
  ) {
    throw new Error("Implementer and reviewer must use different agents or different models");
  }
  const fallback = profiles.reviewerFallback;
  if (
    fallback &&
    fallback.agent === profiles.implementer.agent &&
    fallback.model === profiles.implementer.model
  )
    throw new Error(
      "Implementer and reviewer fallback must use different agents or different models",
    );
}

export function readAgentSettings(config: PawsConfigFile): AgentSettings {
  return structuredClone(
    config.agentSettings ?? {
      defaults: {
        implementer: { agent: config.agents.implementer, model: null },
        reviewer: { agent: "codex", model: null },
      },
      projects: [],
    },
  );
}

export function resolveAgentProfiles(config: PawsConfigFile, repo?: string): AgentProfiles {
  const settings = readAgentSettings(config);
  const project = settings.projects.find((entry) => entry.repo === repo?.toLowerCase());
  const reviewer = project?.reviewer ?? settings.defaults.reviewer;
  const fallback = settings.defaults.reviewerFallback;
  return {
    implementer: project?.implementer ?? settings.defaults.implementer,
    reviewer,
    ...(fallback && fallback.agent !== reviewer.agent ? { reviewerFallback: fallback } : {}),
  };
}

export function resolveAccountPolicy(config: PawsConfigFile, repo?: string): AccountPolicy | null {
  const settings = readAgentSettings(config);
  const project = settings.projects.find((entry) => entry.repo === repo?.toLowerCase());
  const profiles = resolveAgentProfiles(config, repo);
  const defaults = settings.defaults.accounts;
  const role = (name: "implementer" | "reviewer"): RoleAccountPolicy | undefined => {
    const agent = profiles[name].agent;
    const own = project?.accounts?.[name];
    if (own) return { agent, accounts: [...own], source: "project" };
    const inherited = defaults?.[name];
    if (inherited && settings.defaults[name].agent === agent)
      return { agent, accounts: [...inherited], source: "defaults" };
    return undefined;
  };
  const implementer = role("implementer");
  const reviewer = role("reviewer");
  const reviewerFallback =
    profiles.reviewerFallback && defaults?.reviewerFallback
      ? {
          agent: profiles.reviewerFallback.agent,
          accounts: [...defaults.reviewerFallback],
          source: "defaults" as const,
        }
      : undefined;
  if (!implementer && !reviewer && !reviewerFallback) return null;
  const lists = { implementer, reviewer, reviewerFallback };
  return {
    revision: new Bun.CryptoHasher("sha256")
      .update(JSON.stringify([implementer, reviewer, reviewerFallback]))
      .digest("hex")
      .slice(0, 16),
    ...Object.fromEntries(Object.entries(lists).filter(([, value]) => value !== undefined)),
  };
}

export function parseAgentSettingsToml(
  text: string,
  implementer: ImplementerName,
): AgentSettings | null {
  if (!/^\s*\[agents\.(defaults|projects)(?:[.\]])/m.test(text)) return null;
  const parsed = Bun.TOML.parse(text) as {
    agents?: {
      defaults?: {
        implementer?: Partial<AgentProfile>;
        reviewer?: Partial<AgentProfile>;
        reviewer_fallback?: Partial<AgentProfile>;
        accounts?: { implementer?: unknown; reviewer?: unknown; reviewer_fallback?: unknown };
      };
      projects?: Record<
        string,
        {
          implementer?: Partial<AgentProfile>;
          reviewer?: Partial<AgentProfile>;
          accounts?: { implementer?: unknown; reviewer?: unknown };
        }
      >;
    };
  };
  const agents = parsed.agents;
  return parseAgentSettings({
    defaults: {
      implementer: { model: null, ...(agents?.defaults?.implementer ?? { agent: implementer }) },
      reviewer: { model: null, ...(agents?.defaults?.reviewer ?? { agent: "codex" }) },
      ...(agents?.defaults?.reviewer_fallback
        ? { reviewerFallback: { model: null, ...agents.defaults.reviewer_fallback } }
        : {}),
      ...(agents?.defaults?.accounts
        ? {
            accounts: {
              ...defined("implementer", agents.defaults.accounts.implementer),
              ...defined("reviewer", agents.defaults.accounts.reviewer),
              ...defined("reviewerFallback", agents.defaults.accounts.reviewer_fallback),
            },
          }
        : {}),
    },
    projects: Object.entries(agents?.projects ?? {}).map(([repo, profiles]) => ({
      repo,
      ...(profiles.implementer ? { implementer: { model: null, ...profiles.implementer } } : {}),
      ...(profiles.reviewer ? { reviewer: { model: null, ...profiles.reviewer } } : {}),
      ...(profiles.accounts
        ? {
            accounts: {
              ...defined("implementer", profiles.accounts.implementer),
              ...defined("reviewer", profiles.accounts.reviewer),
            },
          }
        : {}),
    })),
  });
}

function defined<K extends string>(key: K, value: unknown): Partial<Record<K, unknown>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, unknown>);
}

export function renderAgentSettingsText(current: string, input: AgentSettings): string {
  const settings = parseAgentSettings(input);
  let section = "";
  const retained = current
    .split(/\r?\n/)
    .filter((line) => {
      const heading = /^\s*\[\[?\s*([^[\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
      if (heading?.[1]) section = heading[1].trim();
      return !/^agents\.(defaults|projects)(?:\.|$)/i.test(section);
    })
    .join("\n");
  const base = setImplementerText(retained, settings.defaults.implementer.agent).trimEnd();
  const sections = [
    renderProfile("agents.defaults.implementer", settings.defaults.implementer),
    renderProfile("agents.defaults.reviewer", settings.defaults.reviewer),
  ];
  if (settings.defaults.reviewerFallback)
    sections.push(
      renderProfile("agents.defaults.reviewer_fallback", settings.defaults.reviewerFallback),
    );
  if (settings.defaults.accounts)
    sections.push(renderAccounts("agents.defaults.accounts", settings.defaults.accounts));
  for (const project of settings.projects) {
    const prefix = `agents.projects.${JSON.stringify(project.repo)}`;
    if (!project.implementer && !project.reviewer && !project.accounts)
      sections.push(`[${prefix}]`);
    if (project.implementer)
      sections.push(renderProfile(`${prefix}.implementer`, project.implementer));
    if (project.reviewer) sections.push(renderProfile(`${prefix}.reviewer`, project.reviewer));
    if (project.accounts) sections.push(renderAccounts(`${prefix}.accounts`, project.accounts));
  }
  const next = `${base}\n\n${sections.join("\n\n")}\n`;
  Bun.TOML.parse(next);
  return next;
}

export function selectDefaultImplementer(
  settings: AgentSettings,
  implementer: ImplementerName,
): AgentSettings {
  const same = settings.defaults.implementer.agent === implementer;
  const { implementer: accounts, ...otherAccounts } = settings.defaults.accounts ?? {};
  return parseAgentSettings({
    ...settings,
    defaults: {
      ...settings.defaults,
      ...(settings.defaults.accounts
        ? {
            accounts:
              same && accounts ? { ...otherAccounts, implementer: accounts } : otherAccounts,
          }
        : {}),
      implementer: {
        ...(settings.defaults.implementer.agent === implementer
          ? settings.defaults.implementer
          : {}),
        agent: implementer,
        model:
          settings.defaults.implementer.agent === implementer
            ? settings.defaults.implementer.model
            : null,
      },
    },
  });
}

export function writeAgentSettings(
  path: string,
  input: AgentSettings,
  merge?: StoredMerge,
  queue?: QueueSettings,
): void {
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const agents = renderAgentSettingsText(current, input);
  const merged = merge === undefined ? agents : setMergeSettingsText(agents, merge);
  replaceConfigText(path, queue === undefined ? merged : setQueueSettingsText(merged, queue));
}

/** Atomically replace `config.toml`, keeping its mode at most 0600. */
export function replaceConfigText(path: string, next: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const mode = existsSync(path) ? statSync(path).mode & 0o600 : 0o600;
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(temp, next, { mode });
    chmodSync(temp, mode);
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

function renderAccounts(section: string, lists: AccountLists): string {
  const lines = [`[${section}]`];
  if (lists.implementer) lines.push(`implementer = ${JSON.stringify(lists.implementer)}`);
  if (lists.reviewer) lines.push(`reviewer = ${JSON.stringify(lists.reviewer)}`);
  if (lists.reviewerFallback)
    lines.push(`reviewer_fallback = ${JSON.stringify(lists.reviewerFallback)}`);
  return lines.join("\n");
}

function renderProfile(section: string, profile: AgentProfile): string {
  const lines = [`[${section}]`, `agent = ${JSON.stringify(profile.agent)}`];
  if (profile.model !== null) lines.push(`model = ${JSON.stringify(profile.model)}`);
  if (profile.effort !== undefined) lines.push(`effort = ${JSON.stringify(profile.effort)}`);
  return lines.join("\n");
}
