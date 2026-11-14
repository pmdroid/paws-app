import { repoApiPath } from "./client";
import type { GitHubClient } from "./types";

export const COMPARE_FILE_LIMIT = 300;

export type RepositoryGet = (suffix: string) => Promise<Record<string, unknown>>;

export function repositoryGet(input: {
  client: GitHubClient;
  token: string;
  owner: string;
  repo: string;
  signal?: AbortSignal;
}): RepositoryGet {
  return async (suffix) => {
    const response = await input.client.request({
      method: "GET",
      path: repoApiPath(input.owner, input.repo, suffix),
      token: input.token,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (response.status !== 200 || typeof response.body !== "object" || response.body === null)
      throw new Error(`GitHub GET ${suffix} failed with status ${response.status}`);
    return response.body as Record<string, unknown>;
  };
}

type TreeEntry = { mode: string; object: string; path: string };
type CompareFile = { filename?: unknown; previous_filename?: unknown };

export async function readTree(get: RepositoryGet, commit: string): Promise<TreeEntry[]> {
  const body = await get(`/git/trees/${commit}?recursive=1`);
  if (body.truncated === true || !Array.isArray(body.tree))
    throw new Error(`the tree at ${commit.slice(0, 7)} is too large to read`);
  return (body.tree as { mode?: unknown; type?: unknown; sha?: unknown; path?: unknown }[])
    .filter((item) => item.type !== "tree")
    .map((item) => ({ mode: String(item.mode), object: String(item.sha), path: String(item.path) }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

export async function compareChangedPaths(
  get: RepositoryGet,
  base: string,
  head: string,
  tree: (commit: string) => Promise<TreeEntry[]> = (commit) => readTree(get, commit),
): Promise<{ mergeBase: string; paths: string[] }> {
  const body = await get(`/compare/${base}...${head}?per_page=1`);
  const mergeBase = (body.merge_base_commit as { sha?: unknown } | undefined)?.sha;
  if (typeof mergeBase !== "string") throw new Error("the compare has no merge base");
  if (!Array.isArray(body.files)) throw new Error("the compare lists no files");
  const files = body.files as CompareFile[];
  if (files.length >= COMPARE_FILE_LIMIT) {
    const [atBase, atHead] = await Promise.all(
      [mergeBase.toLowerCase(), head].map(
        async (commit) => new Map((await tree(commit)).map((entry) => [entry.path, entry])),
      ),
    );
    const paths = [...new Set([...atBase!.keys(), ...atHead!.keys()])].filter((path) => {
      const left = atBase!.get(path);
      const right = atHead!.get(path);
      return left?.object !== right?.object || left?.mode !== right?.mode;
    });
    return { mergeBase: mergeBase.toLowerCase(), paths: paths.sort() };
  }
  const paths = new Set<string>();
  for (const file of files) {
    if (typeof file.filename !== "string") throw new Error("a compared file has no name");
    paths.add(file.filename);
    if (typeof file.previous_filename === "string") paths.add(file.previous_filename);
  }
  return { mergeBase: mergeBase.toLowerCase(), paths: [...paths].sort() };
}
