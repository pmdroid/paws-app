import { journalCaught } from "../../journal";
import { join, resolve } from "node:path";
import { readFileSync, statSync } from "node:fs";
import type {
  DecisionWarning,
  PolicyLoadResult,
  PublishedEvidence,
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
  policyRoot?: string;
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
  if (input.policyRoot !== undefined) {
    const root = resolve(input.policyRoot);
    if (!input.policyRoot.trim() || !isDirectory(root))
      return blocked("local", "local policy root is not a directory");
    const loaded = loadHomePolicy(root);
    if (!loaded.ok) return blocked("local", loaded.message);
    if (loaded.absent)
      return blocked("local", `local policy is missing: ${join(root, PUBLIC_POLICY_PATH)}`);
    return {
      ok: true,
      policy: present("local", loaded.policy, join(root, loaded.policy.entryPath)),
      warnings: [
        {
          code: "local-policy",
          message: `Using configured local policy ${join(root, loaded.policy.entryPath)}.`,
        },
      ],
    };
  }
  const staged = originMainFiles(input);
  if (!staged.ok) return blocked("repo", staged.message);
  const loaded = loadMemoryPolicy(staged.files);
  if (!loaded.ok) return blocked("repo", loaded.message);
  if (loaded.absent) return loadGlobal(input);
  return { ok: true, policy: present("repo", loaded.policy), warnings: [] };
}

/** `published` is the task's videos and screenshots, which Paws adds for the agent session. */
export type PolicyFilesLoad =
  | { ok: true; absent: true }
  | {
      ok: true;
      absent: false;
      digest: string;
      files: ReadonlyMap<string, Uint8Array>;
      published?: readonly PublishedEvidence[];
      acceptedPreviews?: readonly { checkId: string; commit: string }[];
    }
  | { ok: false; message: string };

export function loadPolicyFiles(input: LoadPolicyInput): PolicyFilesLoad {
  if (input.policyRoot !== undefined) {
    const root = resolve(input.policyRoot);
    if (!input.policyRoot.trim() || !isDirectory(root))
      return { ok: false, message: "local policy root is not a directory" };
    const local = treeFiles(root);
    return local.ok && local.absent
      ? { ok: false, message: `local policy is missing: ${join(root, PUBLIC_POLICY_PATH)}` }
      : local;
  }
  const staged = originMainFiles(input);
  if (!staged.ok) return staged;
  const loaded = loadMemoryPolicy(staged.files);
  if (!loaded.ok) return loaded;
  if (!loaded.absent)
    return { ok: true, absent: false, digest: loaded.policy.digest, files: staged.files };
  const home = resolveHome(input);
  if (home === undefined) return { ok: false, message: "HOME is unset" };
  if (!isDirectory(home)) return { ok: false, message: "policy root is not a directory" };
  return treeFiles(home);
}

export function treeFiles(root: string): PolicyFilesLoad {
  const loaded = loadHomePolicy(root);
  if (!loaded.ok || loaded.absent) return loaded;
  return {
    ok: true,
    absent: false,
    digest: loaded.policy.digest,
    files: new Map(
      loaded.policy.files.map((file) => [
        file.path,
        new Uint8Array(readFileSync(join(root, file.path))),
      ]),
    ),
  };
}

/** Largest repository-root file {@link loadOriginMainRootFiles} reads. */
export const ROOT_FILE_MAX_BYTES = 65_536;

export type RootFilesLoad =
  | { ok: true; files: ReadonlyMap<string, Uint8Array> }
  | { ok: false; message: string };

/**
 * Read the named files at the repository root of `origin/main`, through the
 * same confirmed fetch and `ls-remote` answer as the Closeout policy. The work
 * tree and local refs are not read. A name that is absent is left out of the
 * result. A name that is a symlink, a directory or larger than
 * {@link ROOT_FILE_MAX_BYTES} fails the load.
 */
export function loadOriginMainRootFiles(
  input: Pick<LoadPolicyInput, "repo" | "git">,
  names: readonly string[],
): RootFilesLoad {
  const confirmed = confirmedOriginMain(input);
  if (!confirmed.ok) return confirmed;
  const files = new Map<string, Uint8Array>();
  for (const name of names) {
    if (name.includes("/") || repoPath(name) === undefined)
      return { ok: false, message: `not a repository-root file: ${name}` };
    const listed = input.git.listBlobs(input.repo, confirmed.commit, name);
    if (!listed.ok) return { ok: false, message: `could not read ${name}` };
    const blob = listed.blobs.find((entry) => entry.path === name);
    if (blob === undefined) {
      if (listed.blobs.length > 0) return { ok: false, message: `${name} is not a file` };
      continue;
    }
    if (!regularMode(blob.mode)) return { ok: false, message: `${name} is not a file` };
    const read = input.git.readBlob(input.repo, blob.object);
    if (!read.ok) return { ok: false, message: `could not read ${name}` };
    if (read.bytes.byteLength > ROOT_FILE_MAX_BYTES)
      return { ok: false, message: `${name} is larger than ${ROOT_FILE_MAX_BYTES} bytes` };
    files.set(name, read.bytes);
  }
  return { ok: true, files };
}

/**
 * The policy committed at `commit` in `repo`, read from local objects only: no fetch, no
 * `ls-remote` and no home fallback. `null` policy means the commit has no entry.
 */
export function loadCommitPolicy(
  input: Pick<LoadPolicyInput, "repo" | "git">,
  commit: string,
): { ok: true; policy: TreePolicy | null } | { ok: false; message: string } {
  if (!isSha(commit.toLowerCase())) return { ok: false, message: "not a commit" };
  const staged = materialize(input.git, input.repo, commit.toLowerCase());
  if (!staged.ok) return staged;
  const loaded = loadMemoryPolicy(staged.files);
  if (!loaded.ok) return { ok: false, message: loaded.message };
  return { ok: true, policy: loaded.absent ? null : loaded.policy };
}

function originMainFiles(
  input: LoadPolicyInput,
): { ok: true; files: Map<string, Uint8Array> } | { ok: false; message: string } {
  const confirmed = confirmedOriginMain(input);
  if (!confirmed.ok) return confirmed;
  return materialize(input.git, input.repo, confirmed.commit);
}

/** The `origin/main` commit when the fetch and `ls-remote` name the same one. */
function confirmedOriginMain(
  input: Pick<LoadPolicyInput, "repo" | "git">,
): { ok: true; commit: string } | { ok: false; message: string } {
  const fetched = input.git.fetchOriginMain(input.repo);
  if (!fetched.ok) return { ok: false, message: unavailable(fetched.stderr) };
  const commit = fetched.commit.trim().toLowerCase();
  if (!isSha(commit)) return { ok: false, message: "origin/main is unavailable" };
  const listed = input.git.lsRemoteOriginMain(input.repo);
  if (!listed.ok) return { ok: false, message: unavailable(listed.stderr) };
  const remote = remoteSha(listed.stdout);
  if (remote === undefined || remote !== commit)
    return { ok: false, message: "origin/main is unavailable" };
  return { ok: true, commit };
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
  source: "repo" | "global" | "local",
  policy: TreePolicy,
  entryPath = policy.entryPath,
): ResolvedPolicyPresent {
  const resolved: ResolvedPolicyPresent = {
    source,
    skillFiles: policy.skillFiles,
    digest: policy.digest,
    entryPath,
    setup: policy.setup,
    items: policy.items,
    rules: policy.rules,
    files: policy.files,
  };
  if (policy.rules.length > 0) resolved.probeFiles = policy.probeFiles;
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
  } catch (caughtError1) {
    journalCaught(caughtError1, "load.isDirectory", null);
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

function blocked(source: "repo" | "global" | "local", message: string): PolicyLoadOutcome {
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
  const probes = new Set<string>();
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
    if (blob.mode === "120000" && probes.has(relative))
      return { ok: false, message: `probe is a symlink: ${relative}` };
    if (!regularMode(blob.mode))
      return { ok: false, message: `policy path is not a file: ${relative}` };
    const read = git.readBlob(repo, blob.object);
    if (!read.ok) return { ok: false, message: "could not read the policy file" };
    files.set(relative, read.bytes);
    if (relative.endsWith("/SKILL.md")) {
      const slash = relative.lastIndexOf("/");
      const copied = copyTree(git, repo, commit, files, relative.slice(0, slash));
      if (!copied.ok) return copied;
    } else if (!probes.has(relative)) {
      const text = decodeUtf8(read.bytes);
      if (text !== undefined) {
        const parsed = tryParseYamlValue(text);
        if (parsed !== undefined) enqueuePolicyPaths(parsed, pending, probes);
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
