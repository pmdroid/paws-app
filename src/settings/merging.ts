import { journalCaught } from "../journal";
import {
  loadConfigFile,
  parseHighRiskPathSettings,
  parseMergePolicy,
  readMergeSettings,
  storedMerge,
  writeMergePolicy,
  type MergeChoice,
  type MergeOverride,
  type MergePolicy,
  type MergeRule,
  type MergeSettings,
  type StoredMerge,
} from "../config";
import { json, localRequest, readJson, sameToken } from "./handler";

/** Linear projects and labels the page offers. Only names leave Linear. */
export type MergeChoices = {
  projects: { id: string; name: string }[];
  labels: string[];
};

export type MergeSettingsOptions = {
  trustedOrigin?: string;
  configPath: string;
  csrfToken: string;
  /** Records each change in the audit history. */
  audit?: (action: string, subject: string) => void;
  choices?: (signal: AbortSignal) => Promise<MergeChoices>;
  /**
   * The configured repositories (`owner/repo`) whose base branch has a GitHub merge queue. The
   * page offers "Add to the GitHub merge queue" only when one has.
   */
  githubQueues?: (signal: AbortSignal) => Promise<string[]>;
  upToDateRules?: (signal: AbortSignal) => Promise<string[]>;
  /**
   * Whether a high-risk pull request waits for an approval in Paws, and why not. The gate needs
   * a dashboard link a person can open, so a Paws without an https public URL keeps it off.
   */
  riskGate?: { on: boolean; reason?: string };
  /** Repositories Paws can access, `owner/repo`, listed under High-risk paths. */
  repos?: string[];
  /**
   * The repository's `.paws/high-risk-paths` on the last fetched `origin/main` of its local
   * mirror, without a network call. Null when Paws has no local copy yet.
   */
  highRiskFile?: (repo: string) => Promise<HighRiskFile | null>;
};

/** `paths` is null when the commit has no `.paws/high-risk-paths`. */
export type HighRiskFile = { commit: string; paths: string[] | null };

/**
 * One repository under Settings › Merging › High-risk paths: the globs Paws settings give it and,
 * read-only, the globs its own file adds.
 */
export type HighRiskRepositoryView = {
  repository: string;
  paths: string[];
  file:
    | { state: "present"; commit: string; paths: string[] }
    | { state: "missing"; commit: string }
    | { state: "unavailable"; reason: string };
};

export const MERGE_SETTINGS_PATH = "/api/settings/merging";

const ORDER_NAMES: Record<MergeChoice["order"], string> = {
  queue: "Merge queue",
  "ci-green": "Merge each pull request when its CI is green",
  "github-queue": "Add to the GitHub merge queue",
};
const MAIN_MOVED_NAMES: Record<MergeChoice["mainMoved"], string> = {
  overlap: "Update and re-test only when main changed the same files or package",
  green: "Merge on green CI without updating the branch onto main",
  ci: "Always update the branch and wait for CI",
  closeout: "Always update the branch and run Closeout again",
};

export async function handleMergeSettingsRequest(
  request: Request,
  options: MergeSettingsOptions,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== MERGE_SETTINGS_PATH) return null;
  if (!localRequest(request, options.trustedOrigin))
    return json({ error: "Merging settings are only available on the local Paws origin" }, 403);
  if (request.method === "GET") {
    let policy: MergeSettings;
    try {
      policy = readMergeSettings(loadConfigFile(options.configPath));
    } catch (caughtError1) {
      journalCaught(caughtError1, "merging.handleMergeSettingsRequest.readMergeSettings", null);
      return json({ error: "Merging settings could not be read" }, 503);
    }
    let choices: MergeChoices | null = null;
    let choicesError: string | undefined;
    if (options.choices) {
      try {
        choices = await options.choices(AbortSignal.timeout(10_000));
      } catch (caughtError2) {
        journalCaught(caughtError2, "merging.handleMergeSettingsRequest.choices", null);
        choicesError = "Linear projects and labels could not be loaded.";
      }
    }
    return json({
      ...view(policy),
      highRiskPaths: highRiskPathsView(policy),
      ...(options.riskGate ? { riskGate: options.riskGate } : {}),
      highRiskRepositories: await highRiskRepositoriesView(
        pathsByRepository(highRiskPathsView(policy)),
        options,
      ),
      choices,
      ...(choicesError ? { choicesError } : {}),
      ...(options.githubQueues ? await githubQueueView(options.githubQueues) : {}),
      ...(options.upToDateRules ? await upToDateRuleView(options.upToDateRules) : {}),
    });
  }
  if (request.method !== "PUT") return json({ error: "Method not allowed" }, 405);
  if (!sameToken(request.headers.get("x-paws-csrf"), options.csrfToken))
    return json({ error: "CSRF token missing" }, 403);
  let body: unknown;
  try {
    body = await readJson(request);
  } catch (caughtError3) {
    journalCaught(caughtError3, "merging.handleMergeSettingsRequest.readJson", null);
    return json({ error: "Expected a JSON body of at most 128 KiB" }, 400);
  }
  let policy: MergePolicy;
  // Optional, so a page that does not show High-risk paths keeps them.
  let highRiskPaths: Record<string, string[]> | undefined;
  try {
    if (isRecord(body) && "highRiskPaths" in body) {
      const { highRiskPaths: paths, ...rest } = body;
      highRiskPaths = parseHighRiskPathSettings(paths);
      body = rest;
    }
    policy = parseMergePolicy(body);
  } catch (error) {
    journalCaught(error, "merging.handleMergeSettingsRequest.parseMergePolicy", null);
    return json(
      { error: error instanceof Error ? error.message : "Invalid merging settings" },
      400,
    );
  }
  // A malformed saved file is repaired by this write.
  let current: StoredMerge = { projects: {}, rules: [] };
  let before: MergeSettings | null = null;
  try {
    const config = loadConfigFile(options.configPath);
    current = storedMerge(config);
    before = readMergeSettings(config);
  } catch (caughtError4) {
    journalCaught(caughtError4, "merging.handleMergeSettingsRequest.loadConfigFile", null);
  }
  if (options.githubQueues && usesGitHubQueue(policy) && !(before && usesGitHubQueue(before))) {
    let repositories: string[] | null = null;
    try {
      repositories = await options.githubQueues(AbortSignal.timeout(10_000));
    } catch (caughtError5) {
      journalCaught(caughtError5, "merging.handleMergeSettingsRequest.githubQueues", null);
    }
    if (repositories !== null && repositories.length === 0)
      return json(
        {
          error:
            "No configured repository has a GitHub merge queue, so Add to the GitHub merge queue is not available.",
        },
        400,
      );
  }
  try {
    writeMergePolicy(options.configPath, policy, current, highRiskPaths);
  } catch (caughtError6) {
    journalCaught(caughtError6, "merging.handleMergeSettingsRequest.writeMergePolicy", null);
    return json({ error: "Merging settings could not be saved" }, 503);
  }
  for (const change of mergeChanges(before, policy)) options.audit?.("settings.merging", change);
  const saved =
    highRiskPaths ??
    Object.fromEntries(highRiskPathsView(before).map((entry) => [entry.repository, entry.paths]));
  for (const change of highRiskPathChanges(before, saved))
    options.audit?.("settings.merging", change);
  return json({
    ...view(policy),
    highRiskPaths: Object.entries(saved)
      .filter(([, paths]) => paths.length > 0)
      .map(([repository, paths]) => ({ repository, paths })),
    highRiskRepositories: await highRiskRepositoriesView(saved, options),
  });
}

function pathsByRepository(
  entries: readonly { repository: string; paths: string[] }[],
): Record<string, string[]> {
  return Object.fromEntries(entries.map((entry) => [entry.repository, entry.paths]));
}

/**
 * Every repository Paws can access and every repository with settings globs, each with its
 * `.paws/high-risk-paths` read from the local mirror.
 */
async function highRiskRepositoriesView(
  settings: Record<string, string[]>,
  options: MergeSettingsOptions,
): Promise<HighRiskRepositoryView[]> {
  let configured: string[] = [];
  try {
    const config = loadConfigFile(options.configPath);
    configured = [config.repo, ...config.githubRepos].flatMap((repo) => (repo ? [repo] : []));
  } catch (caughtError) {
    journalCaught(caughtError, "merging.highRiskRepositoriesView.loadConfigFile", null);
  }
  const names = new Map<string, string>();
  for (const repository of [...Object.keys(settings), ...configured, ...(options.repos ?? [])])
    if (!names.has(repository.toLowerCase())) names.set(repository.toLowerCase(), repository);
  const paths = new Map(
    Object.entries(settings).map(([repository, globs]) => [repository.toLowerCase(), globs]),
  );
  return Promise.all(
    [...names.values()]
      .sort((left, right) => left.localeCompare(right))
      .map(async (repository) => ({
        repository,
        paths: paths.get(repository.toLowerCase()) ?? [],
        file: await highRiskFileView(repository, options.highRiskFile),
      })),
  );
}

async function highRiskFileView(
  repository: string,
  read: MergeSettingsOptions["highRiskFile"],
): Promise<HighRiskRepositoryView["file"]> {
  if (!read) return { state: "unavailable", reason: "Paws does not read repository files here." };
  try {
    const file = await read(repository);
    if (file === null)
      return {
        state: "unavailable",
        reason: "Paws has no copy of this repository yet. It reads the file once it clones it.",
      };
    return file.paths === null
      ? { state: "missing", commit: file.commit }
      : { state: "present", commit: file.commit, paths: file.paths };
  } catch (caughtError) {
    journalCaught(caughtError, "merging.highRiskFileView.read", null);
    return { state: "unavailable", reason: "Paws could not read .paws/high-risk-paths." };
  }
}

/** Settings › Merging › High-risk paths: each repository with globs. */
function highRiskPathsView(
  settings: MergeSettings | null,
): { repository: string; paths: string[] }[] {
  return Object.entries(settings?.repositories ?? {})
    .filter(([, value]) => value.highRiskPaths?.length)
    .map(([repository, value]) => ({ repository, paths: value.highRiskPaths! }));
}

/** One line per repository whose high-risk paths changed, for the audit history. */
function highRiskPathChanges(
  before: MergeSettings | null,
  after: Record<string, string[]>,
): string[] {
  const old = new Map(
    highRiskPathsView(before).map((entry) => [entry.repository.toLowerCase(), entry]),
  );
  const changes: string[] = [];
  const seen = new Set<string>();
  for (const [repository, paths] of Object.entries(after)) {
    const key = repository.toLowerCase();
    seen.add(key);
    const previous = old.get(key)?.paths ?? [];
    if (previous.join("\n") === paths.join("\n")) continue;
    changes.push(
      `High-risk paths for ${repository}: ${previous.join(", ") || "none"} → ${paths.join(", ") || "none"}`,
    );
  }
  for (const [key, entry] of old)
    if (!seen.has(key))
      changes.push(`High-risk paths for ${entry.repository}: ${entry.paths.join(", ")} → none`);
  return changes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function githubQueueView(
  githubQueues: (signal: AbortSignal) => Promise<string[]>,
): Promise<{ githubQueue: { repositories: string[] } | null; githubQueueError?: string }> {
  try {
    return { githubQueue: { repositories: await githubQueues(AbortSignal.timeout(10_000)) } };
  } catch (caughtError7) {
    journalCaught(caughtError7, "merging.githubQueueView.githubQueues", null);
    return {
      githubQueue: null,
      githubQueueError: "Paws could not check which repositories have a GitHub merge queue.",
    };
  }
}

async function upToDateRuleView(
  upToDateRules: (signal: AbortSignal) => Promise<string[]>,
): Promise<{ upToDateRule?: string[] }> {
  const repositories = await upToDateRules(AbortSignal.timeout(10_000)).catch((caughtError8) => {
    journalCaught(caughtError8, "merging.upToDateRuleView.upToDateRules", null);
    return [];
  });
  return repositories.length ? { upToDateRule: repositories } : {};
}

/** Whether any level chooses "Add to the GitHub merge queue". */
function usesGitHubQueue(policy: MergePolicy): boolean {
  return [policy.default, ...Object.values(policy.projects), ...policy.rules].some(
    (choice) => choice.order === "github-queue",
  );
}

function view(policy: MergePolicy) {
  return {
    default: policy.default,
    projects: Object.entries(policy.projects).map(([id, choice]) => ({ id, ...choice })),
    rules: policy.rules,
  };
}

/** One line per changed choice, for the audit history. */
export function mergeChanges(before: MergePolicy | null, after: MergePolicy): string[] {
  const changes: string[] = [];
  const describe = (scope: string, from: MergeOverride | undefined, to: MergeOverride) => {
    for (const [key, names, title] of [
      ["order", ORDER_NAMES, "merge order"],
      ["mainMoved", MAIN_MOVED_NAMES, "when main moved"],
    ] as const) {
      const old = from?.[key];
      const next = to[key];
      if (old === next) continue;
      const name = (value: string | undefined) =>
        value === undefined ? "inherited" : (names as Record<string, string>)[value]!;
      changes.push(`${scope} ${title}: ${name(old)} → ${name(next)}`);
    }
  };
  describe("Workspace default", before?.default, after.default);
  const projects = new Set([
    ...Object.keys(before?.projects ?? {}),
    ...Object.keys(after.projects),
  ]);
  for (const id of projects) {
    const old = before?.projects[id];
    const next = after.projects[id];
    if (next === undefined) changes.push(`Project ${id} removed`);
    else {
      if (old === undefined) changes.push(`Project ${id} added`);
      describe(`Project ${id}`, old ?? {}, next);
    }
  }
  const key = (rule: MergeRule) => `${rule.project ?? ""}\0${rule.label.toLowerCase()}`;
  const name = (rule: MergeRule) =>
    `Rule label ${rule.label} in ${rule.project === undefined ? "any project" : `project ${rule.project}`}`;
  const oldRules = new Map((before?.rules ?? []).map((rule) => [key(rule), rule]));
  const newRules = new Map(after.rules.map((rule) => [key(rule), rule]));
  for (const [id, rule] of oldRules) if (!newRules.has(id)) changes.push(`${name(rule)} removed`);
  for (const [id, rule] of newRules) {
    const old = oldRules.get(id);
    if (old === undefined) changes.push(`${name(rule)} added`);
    describe(name(rule), old ?? {}, rule);
  }
  return changes;
}
