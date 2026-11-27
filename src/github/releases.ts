import { acquireOperationToken } from "./auth/provider";
import { repositoryGet } from "./compare";
import type { GitHubGitRepository } from "./git-reader";

export type RunnerReleaseLookup = (
  repository: string,
  mergeSha: string,
  signal?: AbortSignal,
) => Promise<string | null>;

type Release = { tag_name?: unknown; draft?: unknown };

function order(tag: string): number {
  const [major = 0, minor = 0, patch = 0] = (tag.match(/\d+/g) ?? []).map(Number);
  return (major * 1e6 + minor) * 1e6 + patch;
}

export function createRunnerReleaseLookup(
  locate: (repository: string) => GitHubGitRepository | null,
): RunnerReleaseLookup {
  const contains = new Map<string, boolean>();
  return async (name, mergeSha, signal) => {
    const repository = locate(name);
    if (!repository) return null;
    const get = repositoryGet({
      ...repository,
      token: await acquireOperationToken(repository, "pr"),
      ...(signal ? { signal } : {}),
    });
    const releases = (await get("/releases?per_page=30")) as unknown as Release[];
    if (!Array.isArray(releases)) throw new Error("GitHub returned no release list");
    let found: string | null = null;
    for (const release of releases) {
      if (release.draft === true || typeof release.tag_name !== "string") continue;
      const tag = release.tag_name;
      const key = JSON.stringify([name, tag, mergeSha]);
      let inside = contains.get(key);
      if (inside === undefined) {
        const status = (await get(`/compare/${mergeSha}...${encodeURIComponent(tag)}?per_page=1`))
          .status;
        inside = status === "ahead" || status === "identical";
        contains.set(key, inside);
      }
      if (inside && (found === null || order(tag) < order(found))) found = tag;
    }
    return found;
  };
}

export function createFakeRunnerReleases() {
  const calls: { repository: string; mergeSha: string }[] = [];
  const releases = new Map<string, string>();
  const lookup: RunnerReleaseLookup = async (repository, mergeSha) => {
    calls.push({ repository, mergeSha });
    return releases.get(mergeSha) ?? null;
  };
  return { calls, releases, lookup };
}
