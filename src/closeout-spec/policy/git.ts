import { sha256Hex } from "./canonical";

/** One blob from `git ls-tree` at the confirmed `origin/main` commit. */
export type GitBlob = {
  /** Git mode, such as `100644`, `100755`, or `120000`. */
  mode: string;
  object: string;
  /** Repository-root-relative path. */
  path: string;
};

export type GitFailure = { ok: false; stderr: string };

/**
 * Git reads the loader is allowed to perform. The loader does not invoke git
 * itself and does not read the work tree or a local ref.
 *
 * `fetchOriginMain` is the fetch of `refs/heads/main` from `origin`.
 * `lsRemoteOriginMain` is the second answer from `git ls-remote origin refs/heads/main`.
 */
export type GitReader = {
  fetchOriginMain(repo: string): { ok: true; commit: string } | GitFailure;
  lsRemoteOriginMain(repo: string): { ok: true; stdout: string } | GitFailure;
  listBlobs(
    repo: string,
    commit: string,
    prefix: string,
  ): { ok: true; blobs: GitBlob[] } | GitFailure;
  readBlob(repo: string, object: string): { ok: true; bytes: Uint8Array } | GitFailure;
};

export type AsyncGitReader = {
  local: GitReader;
  fetchOriginMain(repo: string): Promise<ReturnType<GitReader["fetchOriginMain"]>>;
  lsRemoteOriginMain(repo: string): Promise<ReturnType<GitReader["lsRemoteOriginMain"]>>;
};

export type FakeGitReader = GitReader & {
  calls: string[];
  /** Commit id returned by the fetch. Lowercase hex, 40 or 64 characters. */
  commit: string;
  /** When set, the fetch fails and `stderr` is this string, which may be empty. */
  fetchError: string | undefined;
  /** When set, `ls-remote` fails. */
  remoteError: string | undefined;
  /**
   * Raw `ls-remote` stdout. When omitted, the stdout names {@link commit} as
   * `refs/heads/main`. A different commit is a mismatching second answer.
   */
  remoteStdout: string | undefined;
  listError: string | undefined;
  readError: string | undefined;
  put(path: string, contents: string | Uint8Array, mode?: string): void;
};

type StoredBlob = { mode: string; object: string; path: string; bytes: Uint8Array };

const encoder = new TextEncoder();

export function createFakeGitReader(
  files: Record<string, string | Uint8Array> = {},
  commit = "a".repeat(40),
): FakeGitReader {
  const stored = new Map<string, StoredBlob>();
  const git: FakeGitReader = {
    calls: [],
    commit,
    fetchError: undefined,
    remoteError: undefined,
    remoteStdout: undefined,
    listError: undefined,
    readError: undefined,
    put(path, contents, mode = "100644") {
      const bytes = typeof contents === "string" ? encoder.encode(contents) : contents;
      stored.set(path, { path, mode, bytes, object: sha256Hex(bytes) });
    },
    fetchOriginMain(repo) {
      git.calls.push(`fetch ${repo}`);
      if (git.fetchError !== undefined) return { ok: false, stderr: git.fetchError };
      return { ok: true, commit: git.commit };
    },
    lsRemoteOriginMain(repo) {
      git.calls.push(`ls-remote ${repo}`);
      if (git.remoteError !== undefined) return { ok: false, stderr: git.remoteError };
      const stdout = git.remoteStdout ?? `${git.commit}\trefs/heads/main\n`;
      return { ok: true, stdout };
    },
    listBlobs(repo, listedCommit, prefix) {
      git.calls.push(`ls-tree ${repo} ${listedCommit} ${prefix}`);
      if (git.listError !== undefined) return { ok: false, stderr: git.listError };
      const blobs: GitBlob[] = [];
      for (const blob of stored.values()) {
        if (blob.path === prefix || blob.path.startsWith(`${prefix}/`)) {
          blobs.push({ mode: blob.mode, object: blob.object, path: blob.path });
        }
      }
      blobs.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
      return { ok: true, blobs };
    },
    readBlob(repo, object) {
      git.calls.push(`cat-file ${repo} ${object}`);
      if (git.readError !== undefined) return { ok: false, stderr: git.readError };
      for (const blob of stored.values()) {
        if (blob.object === object) return { ok: true, bytes: blob.bytes };
      }
      return { ok: false, stderr: "fatal: Not a valid object name" };
    },
  };
  for (const [path, contents] of Object.entries(files)) git.put(path, contents);
  return git;
}
