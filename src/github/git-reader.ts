import { createHash } from "node:crypto";
import { journalCaught } from "../journal";
import { acquireOperationToken } from "./auth/provider";
import type { GitHubTokenProvider } from "./auth/types";
import { repoApiPath } from "./client";
import type { GitHubClient } from "./types";

export type GitHubGitRepository = {
  client: GitHubClient;
  owner: string;
  repo: string;
  tokenProvider?: GitHubTokenProvider;
  appId?: string;
  installationId?: string;
  privateKeyPem?: string;
};

export type GitHubBlobCache = {
  get(sha: string): Promise<Uint8Array | null>;
  put(sha: string, bytes: Uint8Array): Promise<void>;
};

type Entry = { mode: string; object: string; path: string };
type Failure = { ok: false; stderr: string };

export type GitHubGitReader = {
  fetchOriginMain(repo: string): Promise<{ ok: true; commit: string } | Failure>;
  lsRemoteOriginMain(repo: string): Promise<{ ok: true; stdout: string } | Failure>;
  listBlobs(repo: string, commit: string, prefix: string): { ok: true; blobs: Entry[] } | Failure;
  readBlob(repo: string, object: string): { ok: true; bytes: Uint8Array } | Failure;
  fill(repo: string): Promise<boolean>;
  mainCommit(repo: string): string | undefined;
  mergeView(
    repo: string,
    main: string,
    head: string,
  ): Promise<{ ok: true; commit: string; both: string[] } | Failure>;
};

const NOT_LOADED = "not read from GitHub yet";
const MAX_TREES = 32;

export function createGitHubGitReader(options: {
  locate(repo: string): GitHubGitRepository | null;
  blobs?: GitHubBlobCache;
  timeoutMs?: number;
}): GitHubGitReader {
  const mains = new Map<string, string>();
  const trees = new Map<string, Entry[]>();
  const blobs = new Map<string, Uint8Array>();
  const wanted = new Map<string, { trees: Set<string>; blobs: Set<string> }>();
  const want = (repo: string) => {
    let entry = wanted.get(repo);
    if (!entry) wanted.set(repo, (entry = { trees: new Set(), blobs: new Set() }));
    return entry;
  };
  const get = async (target: GitHubGitRepository, suffix: string) => {
    const token = await acquireOperationToken(target, "pr");
    const response = await target.client.request({
      method: "GET",
      path: repoApiPath(target.owner, target.repo, suffix),
      token,
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
    });
    if (response.status !== 200 || typeof response.body !== "object" || response.body === null)
      throw new Error(`GitHub GET ${suffix} failed with status ${response.status}`);
    return response.body as Record<string, unknown>;
  };
  const loadTree = async (target: GitHubGitRepository, commit: string) => {
    const body = await get(target, `/git/trees/${commit}?recursive=1`);
    if (body.truncated === true || !Array.isArray(body.tree))
      throw new Error(`the tree at ${commit.slice(0, 7)} is too large to read`);
    return (body.tree as { mode?: unknown; type?: unknown; sha?: unknown; path?: unknown }[])
      .filter((item) => item.type !== "tree")
      .map((item) => ({
        mode: String(item.mode),
        object: String(item.sha),
        path: String(item.path),
      }))
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  };
  const loadBlob = async (target: GitHubGitRepository, sha: string) => {
    const cached = await options.blobs?.get(sha);
    if (cached) return cached;
    const body = await get(target, `/git/blobs/${sha}`);
    if (body.encoding !== "base64" || typeof body.content !== "string")
      throw new Error(`blob ${sha.slice(0, 7)} has no base64 content`);
    const bytes = new Uint8Array(Buffer.from(body.content, "base64"));
    await options.blobs?.put(sha, bytes);
    return bytes;
  };
  const treeAt = async (target: GitHubGitRepository, repo: string, commit: string) => {
    const cached = trees.get(`${repo}\0${commit}`);
    if (cached) return cached;
    const tree = await loadTree(target, commit);
    trees.set(`${repo}\0${commit}`, tree);
    return tree;
  };
  const failure = (caught: unknown): Failure => ({
    ok: false,
    stderr: caught instanceof Error ? caught.message : String(caught),
  });
  return {
    async fetchOriginMain(repo) {
      const target = options.locate(repo);
      if (!target) return { ok: false, stderr: `${repo} is not a GitHub repository Paws reads` };
      try {
        const body = await get(target, "/git/ref/heads/main");
        const object = body.object as { sha?: unknown; type?: unknown } | undefined;
        if (object?.type !== "commit" || typeof object.sha !== "string")
          return { ok: false, stderr: "refs/heads/main is not a commit" };
        const commit = object.sha.toLowerCase();
        mains.set(repo, commit);
        return { ok: true, commit };
      } catch (caught) {
        return failure(caught);
      }
    },
    async lsRemoteOriginMain(repo) {
      const commit = mains.get(repo);
      if (commit === undefined) return { ok: false, stderr: "refs/heads/main was not read" };
      return { ok: true, stdout: `${commit}\trefs/heads/main\n` };
    },
    listBlobs(repo, commit, prefix) {
      const tree = trees.get(`${repo}\0${commit}`);
      if (!tree) {
        want(repo).trees.add(commit);
        return { ok: false, stderr: NOT_LOADED };
      }
      return {
        ok: true,
        blobs: tree.filter((entry) => entry.path === prefix || entry.path.startsWith(`${prefix}/`)),
      };
    },
    readBlob(repo, object) {
      const bytes = blobs.get(object);
      if (bytes) return { ok: true, bytes };
      want(repo).blobs.add(object);
      return { ok: false, stderr: NOT_LOADED };
    },
    async fill(repo) {
      const pending = wanted.get(repo);
      wanted.delete(repo);
      const target = options.locate(repo);
      if (!pending || !target || (!pending.trees.size && !pending.blobs.size)) return false;
      try {
        for (const commit of pending.trees) {
          trees.set(`${repo}\0${commit}`, await loadTree(target, commit));
          for (const key of trees.keys()) if (trees.size > MAX_TREES) trees.delete(key);
        }
        for (const sha of pending.blobs) blobs.set(sha, await loadBlob(target, sha));
        return true;
      } catch (caught) {
        journalCaught(caught, "github.gitReader.fill", null);
        return false;
      }
    },
    mainCommit: (repo) => mains.get(repo),
    async mergeView(repo, main, head) {
      const target = options.locate(repo);
      if (!target) return { ok: false, stderr: `${repo} is not a GitHub repository Paws reads` };
      try {
        const compared = await get(target, `/compare/${main}...${head}?per_page=1`);
        const base = (compared.merge_base_commit as { sha?: unknown } | undefined)?.sha;
        if (typeof base !== "string") return { ok: false, stderr: "the compare has no merge base" };
        const [atBase, atMain, atHead] = await Promise.all(
          [base.toLowerCase(), main, head].map(async (commit) => {
            const entries = await treeAt(target, repo, commit);
            return new Map(entries.map((entry) => [entry.path, entry]));
          }),
        );
        const same = (left?: Entry, right?: Entry) =>
          left?.object === right?.object && left?.mode === right?.mode;
        const merged: Entry[] = [];
        const both: string[] = [];
        for (const path of new Set([...atBase!.keys(), ...atMain!.keys(), ...atHead!.keys()])) {
          const onMain = !same(atBase!.get(path), atMain!.get(path));
          const onHead = !same(atBase!.get(path), atHead!.get(path));
          if (onMain && onHead) both.push(path);
          const entry = onHead && !onMain ? atHead!.get(path) : atMain!.get(path);
          if (entry) merged.push(entry);
        }
        merged.sort((left, right) =>
          left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
        );
        const commit = createHash("sha256").update(`merge\0${main}\0${head}`).digest("hex");
        trees.set(`${repo}\0${commit}`, merged);
        return { ok: true, commit, both: both.sort() };
      } catch (caught) {
        return failure(caught);
      }
    },
  };
}
