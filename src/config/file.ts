import { parseBriefTemplates } from "./brief";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parseAgentSettingsSection, type AgentSettings } from "./agents";

import {
  MAIN_MOVED,
  MERGE_LANES,
  MERGE_NO_PROJECT,
  MERGE_ORDERS,
  MAX_CONFLICT_PRONE_AFTER,
  MAX_CONFLICT_PRONE_DAYS,
  MAX_MERGE_PARALLEL,
  parseMergeLanes,
  parseMergeTables,
  type MainMoved,
  type MergeLane,
  type MergeLaneSplit,
  type MergeNoProject,
  type MergeOrder,
  type MergeRepositories,
} from "./merge";
import {
  knownConfigSection,
  readSettingSections,
  SAVED_SETTINGS_SECTIONS,
  savedSettingsSections,
  SETTINGS_SECTIONS,
  tomlSettingSections,
  updateSettingSections,
  type SettingSections,
} from "./settings-store";
import { parseTimeLimitTables, type StoredTimeLimits } from "./time-limits";
import {
  assignMemberVmKey,
  memberVmSection,
  upgradeSettingSections,
  type MemberVmProviderName,
  type VmSizes,
} from "./member-vm";
import { assignIssueVmKey, type StoredIssueVmSettings } from "./issue-vm";
import { parseProjectSkills, type ProjectSkills } from "./skills";

/** `github.auth`. Paws uses the GitHub App only. */
export type GitHubConfigAuth = "app";

export type TrackerKind = "linear";

export const IMPLEMENTERS = ["claude", "grok", "codex", "opencode"] as const;

export type ImplementerName = (typeof IMPLEMENTERS)[number];

export type AgentsConfig = {
  implementer: ImplementerName;
};

export function defaultAgents(): AgentsConfig {
  return {
    implementer: "claude",
  };
}

export function isImplementer(value: string): value is ImplementerName {
  return (IMPLEMENTERS as readonly string[]).includes(value);
}

/**
 * Parsed saved settings. No saved settings is empty.
 * Secret values are paths, never the secret itself.
 */
export type PawsConfigFile = {
  savedLinearCommentAgents?: string[];
  githubAccess?: GitHubAccess;
  closeoutProjects?: Record<string, string>;
  agents: AgentsConfig;
  agentSettings?: AgentSettings;
  /** `[merge] order`. Missing means the merge queue. */
  mergeOrder?: MergeOrder;
  /** `[merge] main_moved`. Missing means `ci`. */
  mainMoved?: MainMoved;
  /** `[merge] lanes`, or the old `[merge] lane` mapped onto it. Missing means both splits. */
  mergeLanes?: MergeLaneSplit[];
  /** `[merge] no_project`. Missing means `own`. */
  mergeNoProject?: MergeNoProject;
  /** A choice under `[merge.projects."<Linear project id>"]` or a `[[merge.rules]]`, both ignored. */
  ignoredMergeOverrides?: true;
  /** `[merge.projects."<Linear project id>"] lane`. */
  mergeProjectLanes?: Record<string, MergeLane>;
  mergeRepositories?: MergeRepositories;
  /** `[merge] ci_fix_attempts`. Missing means the default of 3. */
  ciFixAttempts?: number;
  mergeParallel?: number;
  /** `[merge] conflict_prone_after`. Missing means the default of 2. */
  conflictProneAfter?: number;
  /** `[merge] conflict_prone_days`. Missing means the default of 7. */
  conflictProneDays?: number;
  autoApproveHighRisk?: boolean;
  overlapHold?: boolean;
  /** `[merge] comment_quiet_seconds`. Missing means the default of 60. */
  commentQuietSeconds?: number;
  /** `[merge] comment_max_wait_seconds`. Missing means the default of 300. */
  commentMaxWaitSeconds?: number;
  reviewWaitMaxSeconds?: number;
  /** `[queue] start_timeout_hours`. Missing means the default of 24. */
  queueStartTimeoutHours?: number;
  /** `[queue] max_running_per_owner`. Missing means no cap. */
  queueMaxRunningPerOwner?: number;
  /** `[findings] grouping_time`, HH:MM UTC; default 06:00. */
  findingsGroupingTime?: string;
  projectSkills?: ProjectSkills[];
  vmSizes?: VmSizes;
  issueVm?: StoredIssueVmSettings;
  /** `[brief] template`. Missing means the built-in brief. */
  briefTemplate?: string | null;
  timeLimits?: StoredTimeLimits;
};

export function emptyConfigFile(): PawsConfigFile {
  return {
    agents: defaultAgents(),
  };
}

export function loadSettings(home: string): PawsConfigFile {
  return configFromSections(readSettingSections(home));
}

export function parseConfigToml(text: string): PawsConfigFile {
  return configFromSections(tomlSettingSections(text));
}

export function configFromSections(sections: SettingSections): PawsConfigFile {
  const config = emptyConfigFile();
  for (const [name, value] of Object.entries(sections))
    if (isTable(value)) assignTable(config, name.toLowerCase(), value);
  const skills = parseProjectSkills(sections["skills"]);
  if (skills.length > 0) config.projectSkills = skills;
  const settings = parseAgentSettingsSection(sections["agents"], config.agents.implementer);
  if (settings !== null) config.agentSettings = settings;
  const brief = parseBriefTemplates(sections["brief"]);
  if (brief.template !== null) config.briefTemplate = brief.template;
  Object.assign(config, parseMergeTables(sections["merge"]));
  Object.assign(config, parseTimeLimitTables(sections["time_limits"]));
  return config;
}

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assignTable(config: PawsConfigFile, section: string, table: Record<string, unknown>) {
  const values = Object.values(table);
  if (!knownConfigSection(section) && !(values.length > 0 && values.every(isTable)))
    throw new Error(`Saved settings have an unknown section: ${section}`);
  if (/^(brief|time_limits|member_vm)(\.|$)/.test(section)) return;
  for (const [key, value] of Object.entries(table)) {
    const nested = `${section}.${/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)}`;
    if (isTable(value)) assignTable(config, nested.toLowerCase(), value);
    else if (Array.isArray(value) && value.length > 0 && value.every(isTable))
      for (const item of value) assignTable(config, nested.toLowerCase(), item);
    else assignConfig(config, section, key.toLowerCase(), value as ConfigValue);
  }
}

export function configSettingsSections(text: string): SettingSections {
  return savedSettingsSections(text, (known) => void parseConfigToml(known));
}

export const SETTINGS_CONVERSION = {
  names: SAVED_SETTINGS_SECTIONS,
  sectionsOf: configSettingsSections,
  upgrade: upgradeSettingSections,
};

export type GitHubAccess = { agentRead?: boolean; mirrors?: boolean };

export function agentReadAllowed(config: Pick<PawsConfigFile, "githubAccess">) {
  return config.githubAccess?.agentRead ?? true;
}

export function githubMirrorsOn(config: Pick<PawsConfigFile, "githubAccess">) {
  return config.githubAccess?.mirrors ?? true;
}

type ConfigValue = string | number | boolean | string[];

function assignConfig(
  config: PawsConfigFile,
  section: string,
  key: string,
  value: ConfigValue,
): void {
  const at = `${section}.${key}`;
  if (section === "findings") {
    if (key !== "grouping_time" || typeof value !== "string" || !GROUPING_TIME_PATTERN.test(value))
      throw new Error(`Saved settings findings.grouping_time must be HH:MM UTC`);
    config.findingsGroupingTime = value;
    return;
  }
  if (section === "linear_comments") {
    if (key !== "agents") throw new Error(`Saved settings have an unknown key: ${section}.${key}`);
    config.savedLinearCommentAgents = asStringArray(value, at);
    return;
  }
  if (section === "github_access") {
    const access = (config.githubAccess ??= {});
    if (key === "agent_read") access.agentRead = asBoolean(value, at);
    else if (key === "mirrors") access.mirrors = asBoolean(value, at);
    else throw new Error(`Saved settings have an unknown key: ${section}.${key}`);
    return;
  }
  const closeoutProject = /^closeout\.projects\."([^"\\]+)"$/.exec(section);
  if (closeoutProject) {
    const repo = closeoutProject[1]!;
    if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repo))
      throw new Error(`Saved settings ${at} requires a Closeout owner/repo`);
    if (key !== "policy_root")
      throw new Error(`Saved settings ${at} has an unknown Closeout project key`);
    const root = asString(value, at);
    if (!root.trim() || root.includes("\0"))
      throw new Error(`Saved settings ${at} requires a nonempty Closeout policy_root`);
    (config.closeoutProjects ??= {})[repo] = root;
    return;
  }
  if (section.startsWith("closeout.projects"))
    throw new Error(`Saved settings require [closeout.projects."owner/repo"]`);
  if (section === "closeout") {
    return;
  }
  if (section === "merge") {
    if (key === "auto_approve_high_risk") config.autoApproveHighRisk = asBoolean(value, at);
    else if (key === "overlap_hold") config.overlapHold = asBoolean(value, at);
    else if (key === "ci_fix_attempts") config.ciFixAttempts = asInt(value, at);
    else if (key === "parallel") config.mergeParallel = mergeParallel(value, at);
    else if (key === "conflict_prone_after")
      config.conflictProneAfter = mergeRange(
        value,
        at,
        "conflict_prone_after",
        MAX_CONFLICT_PRONE_AFTER,
      );
    else if (key === "conflict_prone_days")
      config.conflictProneDays = mergeRange(
        value,
        at,
        "conflict_prone_days",
        MAX_CONFLICT_PRONE_DAYS,
      );
    else if (key === "comment_quiet_seconds") config.commentQuietSeconds = asInt(value, at);
    else if (key === "comment_max_wait_seconds") config.commentMaxWaitSeconds = asInt(value, at);
    else if (key === "review_wait_max_seconds") config.reviewWaitMaxSeconds = asInt(value, at);
    else if (key === "order") config.mergeOrder = oneOf(MERGE_ORDERS, value, at, "merge.order");
    else if (key === "main_moved")
      config.mainMoved = oneOf(MAIN_MOVED, value, at, "merge.main_moved");
    else if (key === "lanes") config.mergeLanes = mergeLanes(value);
    else if (key === "lane")
      config.mergeLanes ??=
        oneOf(MERGE_LANES, value, at, "merge.lane") === "project"
          ? ["project", "person"]
          : ["person"];
    else if (key === "no_project")
      config.mergeNoProject = oneOf(MERGE_NO_PROJECT, value, at, "merge.no_project");
    else throw new Error(`Saved settings have an unknown key: ${section}.${key}`);
    return;
  }
  if (section === "queue") {
    if (key === "start_timeout_hours") config.queueStartTimeoutHours = asInt(value, at);
    if (key === "max_running_per_owner") config.queueMaxRunningPerOwner = asInt(value, at);
    return;
  }
  if (section === "vm_sizes" || section.startsWith("vm_sizes.")) {
    assignMemberVmKey((config.vmSizes ??= {}), section, key, value);
    return;
  }
  if (section === "issue_vm") {
    assignIssueVmKey((config.issueVm ??= {}), key, value);
    return;
  }
  if (section === "agents") {
    if (key === "implementer") config.agents.implementer = implementerName(value, at);
    return;
  }
}

export type SettingsSectionName = (typeof SETTINGS_SECTIONS)[number];

export type SettingsSectionValues = Partial<Record<SettingsSectionName, unknown>>;

export function saveSettingsSections(
  path: string,
  values: SettingsSectionValues | ((stored: SettingSections) => SettingsSectionValues),
): Promise<void> {
  return updateSettingSections(path, (stored) => {
    const next = { ...stored };
    for (const [name, value] of Object.entries(
      typeof values === "function" ? values(stored) : values,
    ))
      if (value === undefined) delete next[name];
      else next[name] = value;
    configFromSections(next);
    return next;
  });
}

export function saveSettingsSection(
  path: string,
  name: SettingsSectionName,
  value: unknown,
): Promise<void> {
  return saveSettingsSections(path, { [name]: value });
}

export function updateVmSizes(path: string, change: (saved: VmSizes) => VmSizes): Promise<void> {
  return saveSettingsSections(path, (stored) => ({
    vm_sizes: memberVmSection(change(configFromSections(stored).vmSizes ?? {})),
  }));
}

export function writeMemberVmProviderOff(
  path: string,
  provider: MemberVmProviderName,
  off: boolean,
): Promise<void> {
  return updateVmSizes(path, (size) => {
    const others = (size.offProviders ?? []).filter((name) => name !== provider);
    return { ...size, offProviders: off ? [...others, provider] : others };
  });
}

const GROUPING_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export function writeFindingsGroupingTime(path: string, groupingTime: string): Promise<void> {
  if (!GROUPING_TIME_PATTERN.test(groupingTime))
    throw new Error("findings.grouping_time must be HH:MM UTC");
  return saveSettingsSection(path, "findings", { grouping_time: groupingTime });
}

function oneOf<T extends string>(
  choices: readonly T[],
  value: ConfigValue,
  at: string,
  name: string,
): T {
  const text = asString(value, at);
  if (!(choices as readonly string[]).includes(text))
    throw new Error(`Saved settings ${name} must be ${choices.join(", ")}`);
  return text as T;
}

function mergeParallel(value: ConfigValue, at: string): number {
  return mergeRange(value, at, "parallel", MAX_MERGE_PARALLEL);
}

function mergeRange(value: ConfigValue, at: string, key: string, max: number): number {
  const count = asInt(value, at);
  if (count < 1 || count > max)
    throw new Error(`Saved settings merge.${key} must be from 1 to ${max}`);
  return count;
}

function mergeLanes(value: ConfigValue): MergeLaneSplit[] {
  try {
    return parseMergeLanes(value);
  } catch (error) {
    throw new Error(`Saved settings merge.${(error as Error).message}`, {
      cause: error,
    });
  }
}

function implementerName(value: ConfigValue, at: string): ImplementerName {
  const name = asString(value, at);
  if (!isImplementer(name)) {
    throw new Error(`Saved settings agents.implementer must be claude, grok, codex, or opencode`);
  }
  return name;
}

function asString(value: ConfigValue, at: string): string {
  if (typeof value !== "string") throw new Error(`Saved settings ${at} must be a string`);
  return value;
}

function asStringArray(value: ConfigValue, at: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Saved settings ${at} must be an array of strings`);
  }
  return value;
}

function asBoolean(value: ConfigValue, at: string): boolean {
  if (typeof value !== "boolean") throw new Error(`Saved settings ${at} must be true or false`);
  return value;
}

function asInt(value: ConfigValue, at: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Saved settings ${at} must be a non-negative integer`);
  }
  return value;
}

export function closeoutPolicyRoot(
  config: PawsConfigFile,
  pawsHome: string,
  repository: string | null,
): string | undefined {
  const root =
    repository === null ? undefined : config.closeoutProjects?.[repository.toLowerCase()];
  return root === undefined ? undefined : resolve(pawsHome, root);
}

export type CloseoutSettings = { projects: Record<string, { policyRoot: string }> };

export function readCloseoutSettings(config: PawsConfigFile): CloseoutSettings {
  return {
    projects: Object.fromEntries(
      Object.entries(config.closeoutProjects ?? {}).map(([repo, policyRoot]) => [
        repo,
        { policyRoot },
      ]),
    ),
  };
}

export function parseCloseoutSettings(value: unknown): CloseoutSettings {
  const projects =
    typeof value === "object" && value !== null ? (value as { projects?: unknown }).projects : null;
  if (typeof projects !== "object" || projects === null || Array.isArray(projects))
    throw new Error("projects must be an object keyed by owner/repo");
  const parsed: CloseoutSettings["projects"] = {};
  for (const [key, entry] of Object.entries(projects)) {
    const repo = key.toLowerCase();
    if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repo))
      throw new Error(`projects.${key} must be an owner/repo`);
    const root = typeof entry === "object" && entry !== null ? entry.policyRoot : undefined;
    if (typeof root !== "string" || !isAbsolute(root) || root.includes("\0"))
      throw new Error(`projects.${key}.policyRoot must be an absolute path`);
    if (!existsSync(root) || !statSync(root).isDirectory())
      throw new Error(`projects.${key}.policyRoot ${root} is not a directory on the Paws host`);
    parsed[repo] = { policyRoot: root };
  }
  return { projects: parsed };
}

export function writeCloseoutSettings(path: string, settings: CloseoutSettings): Promise<void> {
  return saveSettingsSections(path, (stored) => {
    const { projects: _projects, ...rest } = isTable(stored["closeout"]) ? stored["closeout"] : {};
    const projects = Object.fromEntries(
      Object.entries(settings.projects).map(([repo, { policyRoot }]) => [
        repo,
        { policy_root: policyRoot },
      ]),
    );
    const closeout = Object.keys(projects).length > 0 ? { ...rest, projects } : rest;
    return { closeout: Object.keys(closeout).length > 0 ? closeout : undefined };
  });
}
