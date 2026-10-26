import { journalCaught } from "../journal";
import {
  loadConfigFile,
  parseMergePolicy,
  readMergeSettings,
  storedMerge,
  writeMergePolicy,
  type MergeChoice,
  type MergeOverride,
  type MergePolicy,
  type MergeRule,
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
};

export const MERGE_SETTINGS_PATH = "/api/settings/merging";

const ORDER_NAMES: Record<MergeChoice["order"], string> = {
  queue: "Merge queue",
  "ci-green": "Merge each pull request when its CI is green",
  "github-queue": "Add to the GitHub merge queue",
};
const MAIN_MOVED_NAMES: Record<MergeChoice["mainMoved"], string> = {
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
    let policy: MergePolicy;
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
  try {
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
  let before: MergePolicy | null = null;
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
    writeMergePolicy(options.configPath, policy, current);
  } catch (caughtError6) {
    journalCaught(caughtError6, "merging.handleMergeSettingsRequest.writeMergePolicy", null);
    return json({ error: "Merging settings could not be saved" }, 503);
  }
  for (const change of mergeChanges(before, policy)) options.audit?.("settings.merging", change);
  return json(view(policy));
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
