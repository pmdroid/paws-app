import { acquireOperationToken } from "./auth/provider";
import { repositoryGet } from "./compare";
import type { GitHubGitRepository } from "./git-reader";

export type RepositorySnapshot = {
  repository: string;
  ref: string;
  commit: string;
  visibility: "public" | "private";
  description?: string;
};

export type SnapshotFile = { path: string; object: string; size: number };

export type GitHubSnapshotReader = {
  resolve(
    repository: string,
    ref: string | null,
    signal: AbortSignal,
  ): Promise<RepositorySnapshot | null>;
  files(snapshot: RepositorySnapshot, signal: AbortSignal): Promise<SnapshotFile[]>;
  read(snapshot: RepositorySnapshot, file: SnapshotFile, signal: AbortSignal): Promise<Uint8Array>;
};

const SHA = /^[0-9a-f]{40}$/;
const MAX_FILES = 20_000;
const SNAPSHOT_REF = /^(?!.*\.\.)(?!\/)[A-Za-z0-9._/-]{1,200}$/;

export function createGitHubSnapshotReader(options: {
  locate(repository: string): GitHubGitRepository | null | Promise<GitHubGitRepository | null>;
  timeoutMs?: number;
}): GitHubSnapshotReader {
  const getter = async (repository: string, signal: AbortSignal) => {
    const target = await Promise.resolve(options.locate(repository)).catch(() => null);
    if (!target) return null;
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000);
    return repositoryGet({
      client: target.client,
      token: await acquireOperationToken(target, "pr"),
      owner: target.owner,
      repo: target.repo,
      signal: AbortSignal.any([signal, timeout]),
    });
  };
  return {
    async resolve(repository, ref, signal) {
      if (ref !== null && !SNAPSHOT_REF.test(ref)) return null;
      const get = await getter(repository, signal);
      if (!get) return null;
      const info = await get("").catch(() => null);
      const branch = info?.default_branch;
      if (!info || typeof branch !== "string") return null;
      const wanted = ref ?? branch;
      const path = wanted.split("/").map(encodeURIComponent).join("/");
      const commit = (await get(`/commits/${path}`).catch(() => null))?.sha;
      if (typeof commit !== "string" || !SHA.test(commit.toLowerCase())) return null;
      const visibility =
        info.private === false && info.visibility === "public" ? "public" : "private";
      const description = typeof info.description === "string" ? info.description : undefined;
      return {
        repository,
        ref: wanted,
        commit: commit.toLowerCase(),
        visibility,
        ...(description ? { description } : {}),
      };
    },
    async files(snapshot, signal) {
      const get = await getter(snapshot.repository, signal);
      if (!get) throw new Error(`${snapshot.repository} is not a repository Paws reads`);
      const body = await get(`/git/trees/${snapshot.commit}?recursive=1`);
      const tree = Array.isArray(body.tree) ? (body.tree as Record<string, unknown>[]) : [];
      return tree
        .filter((entry) => entry.type === "blob" && typeof entry.path === "string")
        .slice(0, MAX_FILES)
        .map((entry) => ({
          path: String(entry.path),
          object: String(entry.sha),
          size: typeof entry.size === "number" ? entry.size : Number.MAX_SAFE_INTEGER,
        }));
    },
    async read(snapshot, file, signal) {
      const get = await getter(snapshot.repository, signal);
      if (!get) throw new Error(`${snapshot.repository} is not a repository Paws reads`);
      const body = await get(`/git/blobs/${file.object}`);
      if (body.encoding !== "base64" || typeof body.content !== "string")
        throw new Error(`blob ${file.object.slice(0, 7)} has no base64 content`);
      return new Uint8Array(Buffer.from(body.content, "base64"));
    },
  };
}

export type FakeSnapshotRepository = {
  visibility: "public" | "private";
  refs: Record<string, string>;
  defaultRef: string;
  files: Record<string, Record<string, string>>;
  description?: string;
};

export type FakeSnapshotReader = GitHubSnapshotReader & {
  repositories: Record<string, FakeSnapshotRepository>;
  calls: { method: "resolve" | "files" | "read"; repository: string; target: string }[];
};

export function createFakeSnapshotReader(
  repositories: Record<string, FakeSnapshotRepository> = {},
): FakeSnapshotReader {
  const calls: FakeSnapshotReader["calls"] = [];
  const objectOf = (commit: string, path: string) =>
    Buffer.from(`${commit}\0${path}`).toString("hex").slice(0, 40);
  const tree = (snapshot: RepositorySnapshot) =>
    repositories[snapshot.repository]?.files[snapshot.commit] ?? {};
  return {
    repositories,
    calls,
    async resolve(repository, ref, signal) {
      signal.throwIfAborted();
      calls.push({ method: "resolve", repository, target: ref ?? "" });
      const found = repositories[repository];
      if (!found || (ref !== null && !SNAPSHOT_REF.test(ref))) return null;
      const wanted = ref ?? found.defaultRef;
      const commit = found.refs[wanted] ?? (found.files[wanted] ? wanted : undefined);
      if (!commit) return null;
      return {
        repository,
        ref: wanted,
        commit,
        visibility: found.visibility,
        ...(found.description ? { description: found.description } : {}),
      };
    },
    async files(snapshot, signal) {
      signal.throwIfAborted();
      calls.push({ method: "files", repository: snapshot.repository, target: snapshot.commit });
      return Object.entries(tree(snapshot)).map(([path, text]) => ({
        path,
        object: objectOf(snapshot.commit, path),
        size: Buffer.byteLength(text),
      }));
    },
    async read(snapshot, file, signal) {
      signal.throwIfAborted();
      calls.push({ method: "read", repository: snapshot.repository, target: file.path });
      return new TextEncoder().encode(tree(snapshot)[file.path] ?? "");
    },
  };
}
