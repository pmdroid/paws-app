import { journalCaught } from "../journal";
import {
  FULL_CHECKOUT_LABEL,
  checkoutExclusionsFor,
  loadConfigFile,
  writeCheckoutProjects,
  type CheckoutProjects,
} from "../config";
import { exclusionMatcher, isGlobExclusion, validateExclusion } from "../worktree-checkout";
import { isRecord, json, localRequest, readJson, sameToken } from "./handler";

export const CHECKOUT_SETTINGS_PATH = "/api/settings/checkout";

/** `agent` is `exclude`; `checks` is `exclude_from_checks`, hidden from Closeout checks too. */
export type CheckoutHideFrom = "agent" | "checks";

/** What Paws knows about a repository's `origin/main` without a network call. */
export type RepositoryCheckoutFacts = {
  /** Every file path at the commit. */
  files?: readonly string[];
  /** Each Closeout check and the repository paths it names. */
  checks: ReadonlyArray<{ id: string; paths: readonly string[] }>;
};

export type CheckoutSettingsOptions = {
  trustedOrigin?: string;
  configPath: string;
  csrfToken: string;
  /** Repositories Paws can access, `owner/repo`. */
  repos?: string[];
  /** Records each change in the audit history. */
  audit?: (action: string, subject: string) => void;
  /** `null` when Paws has no local copy of the repository yet. */
  inspect?: (repo: string) => Promise<RepositoryCheckoutFacts | null>;
};

const REPO = /^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/;
const MAX_PATHS = 128;

/**
 * Settings › Agents › Repository checkout. `GET` lists one entry per repository with the paths
 * it leaves out; `PUT` replaces the paths of the repositories it names and writes the same
 * `[checkout.projects]` tables `config.toml` holds. A running item keeps the checkout it started with.
 */
export async function handleCheckoutSettingsRequest(
  request: Request,
  options: CheckoutSettingsOptions,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== CHECKOUT_SETTINGS_PATH) return null;
  if (!localRequest(request, options.trustedOrigin))
    return json({ error: "Checkout settings are only available on the local Paws origin" }, 403);
  if (request.method === "GET") {
    let projects: CheckoutProjects;
    let repos: string[];
    try {
      ({ projects, repos } = read(options));
    } catch {
      return json({ error: "Checkout settings could not be read" }, 503);
    }
    return json(await view(projects, repos, options));
  }
  if (request.method !== "PUT") return json({ error: "Method not allowed" }, 405);
  if (!sameToken(request.headers.get("x-paws-csrf"), options.csrfToken))
    return json({ error: "CSRF token missing" }, 403);
  let body: unknown;
  try {
    body = await readJson(request);
  } catch {
    return json({ error: "Expected a JSON body of at most 128 KiB" }, 400);
  }
  let changes: CheckoutProjects;
  try {
    changes = parseCheckoutSettings(body);
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : "Invalid checkout settings" },
      400,
    );
  }
  let before: CheckoutProjects = {};
  let repos: string[] = [];
  try {
    ({ projects: before, repos } = read(options));
  } catch (caughtError) {
    // A malformed saved file is repaired by this write.
    journalCaught(caughtError, "checkout.handleCheckoutSettingsRequest.read", null);
  }
  const after: CheckoutProjects = { ...before };
  for (const [repo, project] of Object.entries(changes)) {
    if (project.exclude.length || project.excludeFromChecks?.length) after[repo] = project;
    else delete after[repo];
  }
  try {
    writeCheckoutProjects(options.configPath, after);
  } catch {
    return json({ error: "Checkout settings could not be saved" }, 503);
  }
  for (const change of checkoutChanges(before, after)) options.audit?.("settings.checkout", change);
  const saved = await view(after, [...repos, ...Object.keys(changes)], options);
  const warnings = saved.repositories.flatMap((repository) =>
    repository.paths
      .filter((path) => path.hideFrom === "checks" && path.usedBy.length)
      .map(
        (path) =>
          `${repository.repo}: ${path.path} is used by the Closeout ${
            path.usedBy.length === 1 ? "check" : "checks"
          } ${path.usedBy.join(", ")} and is hidden from checks.`,
      ),
  );
  return json({ ...saved, ...(warnings.length ? { warnings } : {}) });
}

function read(options: CheckoutSettingsOptions): { projects: CheckoutProjects; repos: string[] } {
  const config = loadConfigFile(options.configPath);
  return {
    projects: config.checkoutProjects ?? {},
    repos: [config.repo, ...config.githubRepos, ...(options.repos ?? [])].flatMap((repo) =>
      repo === null ? [] : [repo],
    ),
  };
}

/** The `PUT` body: `{ repositories: [{ repo, paths: [{ path, hideFrom }] }] }`. */
export function parseCheckoutSettings(body: unknown): CheckoutProjects {
  if (!isRecord(body) || !Array.isArray(body.repositories))
    throw new Error("Expected repositories");
  const projects: CheckoutProjects = {};
  for (const entry of body.repositories) {
    if (!isRecord(entry) || typeof entry.repo !== "string" || !REPO.test(entry.repo))
      throw new Error("Each repository must be owner/repo");
    if (!Array.isArray(entry.paths)) throw new Error(`${entry.repo}: expected a list of paths`);
    if (entry.paths.length > MAX_PATHS)
      throw new Error(`${entry.repo}: at most ${MAX_PATHS} paths can be left out`);
    const exclude: string[] = [];
    const excludeFromChecks: string[] = [];
    for (const item of entry.paths) {
      if (!isRecord(item) || typeof item.path !== "string")
        throw new Error(`${entry.repo}: each entry needs a path`);
      const path = item.path.trim();
      try {
        validateExclusion(path);
      } catch {
        throw new Error(
          `${entry.repo}: ${JSON.stringify(path)} is not a path or glob inside the repository. Use a relative path such as docs/archive/ or **/*.snap; .git and .. are not allowed.`,
        );
      }
      if (item.hideFrom !== undefined && item.hideFrom !== "agent" && item.hideFrom !== "checks")
        throw new Error(`${entry.repo}: hideFrom must be "agent" or "checks"`);
      if (exclude.includes(path) || excludeFromChecks.includes(path))
        throw new Error(`${entry.repo}: ${path} is listed twice`);
      (item.hideFrom === "checks" ? excludeFromChecks : exclude).push(path);
    }
    const repo = entry.repo.toLowerCase();
    if (repo in projects) throw new Error(`${entry.repo} is listed twice`);
    projects[repo] = { exclude, ...(excludeFromChecks.length ? { excludeFromChecks } : {}) };
  }
  return projects;
}

async function view(projects: CheckoutProjects, repos: string[], options: CheckoutSettingsOptions) {
  const names = [
    ...new Set([...repos, ...Object.keys(projects)].map((repo) => repo.toLowerCase())),
  ];
  const repositories = await Promise.all(
    names.map(async (repo) => {
      const project = projects[repo];
      const paths: Array<{ path: string; hideFrom: CheckoutHideFrom }> = [
        ...(project?.exclude ?? []).map((path) => ({ path, hideFrom: "agent" as const })),
        ...(project?.excludeFromChecks ?? []).map((path) => ({
          path,
          hideFrom: "checks" as const,
        })),
      ];
      let facts: RepositoryCheckoutFacts | null = null;
      if (paths.length && options.inspect) facts = await options.inspect(repo).catch(() => null);
      const files = facts?.files;
      const hidden = exclusionMatcher(checkoutExclusionsFor(projects, repo).agent);
      return {
        repo,
        paths: paths.map((path) => ({
          ...path,
          usedBy: facts ? checksUsing(path.path, facts) : [],
        })),
        ...(files && paths.length
          ? {
              files: {
                total: files.length,
                agent: files.filter((file) => !hidden(file)).length,
              },
            }
          : {}),
      };
    }),
  );
  return { label: FULL_CHECKOUT_LABEL, repositories };
}

/**
 * The checks that name a path the entry leaves out. With the file list, a check uses the entry
 * when one of its paths covers a file the entry hides. Without it, their literal folders overlap.
 */
export function checksUsing(entry: string, facts: RepositoryCheckoutFacts): string[] {
  const hides = exclusionMatcher([entry]);
  const hidden = facts.files?.filter(hides);
  return facts.checks
    .filter((check) =>
      check.paths.some((path) => {
        if (hidden) {
          const reads = exclusionMatcher([path]);
          if (hidden.some(reads)) return true;
        }
        return foldersOverlap(entry, path);
      }),
    )
    .map((check) => check.id);
}

/** Whether the literal folders before the first wildcard of `a` and `b` nest, both non-empty. */
function foldersOverlap(a: string, b: string): boolean {
  const prefix = (path: string) => {
    const parts = path.replace(/\/$/, "").split("/");
    const glob = parts.findIndex(isGlobExclusion);
    return glob === -1 ? parts : parts.slice(0, glob);
  };
  const left = prefix(a);
  const right = prefix(b);
  if (!left.length || !right.length) return false;
  const shorter = left.length <= right.length ? left : right;
  const longer = shorter === left ? right : left;
  return shorter.every((part, index) => part === longer[index]);
}

/** One line per changed repository, for the audit history. */
export function checkoutChanges(before: CheckoutProjects, after: CheckoutProjects): string[] {
  const describe = (project: CheckoutProjects[string] | undefined) => [
    ...(project?.exclude ?? []).map((path) => `${path} (agent)`),
    ...(project?.excludeFromChecks ?? []).map((path) => `${path} (agent and checks)`),
  ];
  const changes: string[] = [];
  for (const repo of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const old = describe(before[repo]);
    const next = describe(after[repo]);
    if (JSON.stringify(old) === JSON.stringify(next)) continue;
    changes.push(
      `Checkout ${repo} leaves out ${next.length ? next.join(", ") : "nothing"} (was ${
        old.length ? old.join(", ") : "nothing"
      })`,
    );
  }
  return changes;
}
