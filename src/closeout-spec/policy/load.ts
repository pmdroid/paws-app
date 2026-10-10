import { statSync } from "node:fs";
import type {
  DecisionWarning,
  PolicyLoadResult,
  ResolvedPolicy,
  ResolvedPolicyPresent,
} from "../types";
import { decodeUtf8, tryParseYamlValue } from "./document";
import type { GitBlob, GitReader } from "./git";
import { repoPath } from "./paths";
import {
  enqueuePolicyPaths,
  loadHomePolicy,
  loadMemoryPolicy,
  PUBLIC_POLICY_PATH,
  type TreePolicy,
} from "./resolve";

/** Decision message when both the remote entry and the global file are absent. */
export const NO_CLOSEOUT_POLICY = "no closeout policy";

export const GLOBAL_POLICY_CODE = "global-policy";

export type PolicyLoadOutcome =
  | { ok: true; policy: ResolvedPolicy; warnings: DecisionWarning[] }
  | Extract<PolicyLoadResult, { ok: false }>;

export type LoadPolicyInput = {
  /** Candidate repository. Passed to {@link GitReader}. The work tree is not a policy source. */
  repo: string;
  git: GitReader;
  /**
   * Home directory for `~/.agents/closeout.yaml`.
   * When omitted, `env.HOME` is used. An empty string is unset.
   */
  home?: string;
  /** Environment used when `home` is omitted. Defaults to `process.env`. */
  env?: { HOME?: string | undefined };
};

/**
 * Load the acceptance policy for `repo`.
 *
 * The entry is `.agents/closeout.yaml` on `refs/heads/main` of `origin`.
 * The fetch and `git ls-remote` answers must name the same commit. The work
 * tree and local refs are not read. An unreadable remote is blocked and does
 * not fall back to the home file. A missing remote entry reads
 * `~/.agents/closeout.yaml`, with imports and skills resolved from that home.
 * When both are absent the result is `source: "none"`, which accepts with
 * {@link NO_CLOSEOUT_POLICY}. A file that exists and fails to load is blocked.
 */
export function loadPolicy(input: LoadPolicyInput): PolicyLoadOutcome {
  const fetched = input.git.fetchOriginMain(input.repo);
  if (!fetched.ok) return blocked("repo", unavailable(fetched.stderr));
  const commit = fetched.commit.trim().toLowerCase();
  if (!isSha(commit)) return blocked("repo", "origin/main is unavailable");
  const listed = input.git.lsRemoteOriginMain(input.repo);
  if (!listed.ok) return blocked("repo", unavailable(listed.stderr));
  const remote = remoteSha(listed.stdout);
  if (remote === undefined || remote !== commit)
    return blocked("repo", "origin/main is unavailable");

  const staged = materialize(input.git, input.repo, commit);
  if (!staged.ok) return blocked("repo", staged.message);
  const loaded = loadMemoryPolicy(staged.files);
  if (!loaded.ok) return blocked("repo", loaded.message);
  if (loaded.absent) return loadGlobal(input);
  return { ok: true, policy: present("repo", loaded.policy), warnings: [] };
}

function loadGlobal(input: LoadPolicyInput): PolicyLoadOutcome {
  const home = resolveHome(input);
  if (home === undefined) return blocked("global", "HOME is unset");
  if (!isDirectory(home)) return blocked("global", "policy root is not a directory");
  const loaded = loadHomePolicy(home);
  if (!loaded.ok) return blocked("global", loaded.message);
  if (loaded.absent) {
    return {
      ok: true,
      warnings: [],
      policy: {
        source: "none",
        digest: null,
        entryPath: null,
        setup: [],
        items: [],
        files: [],
      },
    };
  }
  const shown = `~/${loaded.policy.entryPath}`;
  return {
    ok: true,
    warnings: [
      {
        code: GLOBAL_POLICY_CODE,
        message: `Using ${shown} because origin/main has no closeout policy.`,
      },
    ],
    policy: present("global", loaded.policy, shown),
  };
}

function present(
  source: "repo" | "global",
  policy: TreePolicy,
  entryPath = policy.entryPath,
): ResolvedPolicyPresent {
  const resolved: ResolvedPolicyPresent = {
    source,
    digest: policy.digest,
    entryPath,
    setup: policy.setup,
    items: policy.items,
    files: policy.files,
  };
  if (policy.retry !== undefined) resolved.retry = policy.retry;
  return resolved;
}

function resolveHome(input: LoadPolicyInput): string | undefined {
  if (input.home !== undefined) return input.home.length > 0 ? input.home : undefined;
  const home = (input.env ?? process.env).HOME;
  if (home === undefined || home.length === 0) return undefined;
  return home;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function unavailable(stderr: string): string {
  const line = stderr
    .split(/\r?\n/)
    .find((entry) => entry.trim().length > 0)
    ?.trim();
  if (line === undefined || line.length === 0) return "origin/main is unavailable";
  return `origin/main is unavailable: ${line}`;
}

function remoteSha(stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    const sha = parts[0]?.toLowerCase();
    const name = parts[1];
    if (sha !== undefined && name === "refs/heads/main" && isSha(sha)) return sha;
  }
  return undefined;
}

function isSha(value: string): boolean {
  return (value.length === 40 || value.length === 64) && /^[0-9a-f]+$/.test(value);
}

function blocked(source: "repo" | "global", message: string): PolicyLoadOutcome {
  return { ok: false, source, message };
}

function regularMode(mode: string): boolean {
  return mode === "100644" || mode === "100755";
}

function materialize(
  git: GitReader,
  repo: string,
  commit: string,
): { ok: true; files: Map<string, Uint8Array> } | { ok: false; message: string } {
  const files = new Map<string, Uint8Array>();
  const pending = [PUBLIC_POLICY_PATH];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const relative = pending.pop();
    if (relative === undefined) break;
    if (seen.has(relative)) continue;
    seen.add(relative);
    if (repoPath(relative) === undefined) continue;
    const listed = git.listBlobs(repo, commit, relative);
    if (!listed.ok) return { ok: false, message: "could not read the policy file" };
    const blob = listed.blobs.find((entry) => entry.path === relative);
    if (blob === undefined) continue;
    if (!regularMode(blob.mode))
      return { ok: false, message: `policy path is not a file: ${relative}` };
    const read = git.readBlob(repo, blob.object);
    if (!read.ok) return { ok: false, message: "could not read the policy file" };
    files.set(relative, read.bytes);
    if (relative.endsWith("/SKILL.md")) {
      const slash = relative.lastIndexOf("/");
      const copied = copyTree(git, repo, commit, files, relative.slice(0, slash));
      if (!copied.ok) return copied;
    } else {
      const text = decodeUtf8(read.bytes);
      if (text !== undefined) {
        const parsed = tryParseYamlValue(text);
        if (parsed !== undefined) enqueuePolicyPaths(parsed, pending);
      }
    }
  }
  return { ok: true, files };
}

function copyTree(
  git: GitReader,
  repo: string,
  commit: string,
  files: Map<string, Uint8Array>,
  dir: string,
): { ok: true } | { ok: false; message: string } {
  const listed = git.listBlobs(repo, commit, dir);
  if (!listed.ok) return { ok: false, message: "could not read the policy file" };
  for (const blob of listed.blobs) {
    const stored = storeSkillBlob(git, repo, files, blob);
    if (!stored.ok) return stored;
  }
  return { ok: true };
}

function storeSkillBlob(
  git: GitReader,
  repo: string,
  files: Map<string, Uint8Array>,
  blob: GitBlob,
): { ok: true } | { ok: false; message: string } {
  if (blob.mode === "120000")
    return { ok: false, message: `skill file is a symlink: ${blob.path}` };
  if (!regularMode(blob.mode))
    return { ok: false, message: `skill path is not a file: ${blob.path}` };
  const read = git.readBlob(repo, blob.object);
  if (!read.ok) return { ok: false, message: "could not read the policy file" };
  if (repoPath(blob.path) === undefined) {
    return { ok: false, message: `import path is not repository-relative: ${blob.path}` };
  }
  files.set(blob.path, read.bytes);
  return { ok: true };
}
