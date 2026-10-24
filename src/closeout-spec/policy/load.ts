import { join, resolve } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";
import type {
  DecisionWarning,
  PolicyLoadResult,
  PublishedEvidence,
  ResolvedPolicy,
  ResolvedPolicyPresent,
} from "../types";
import { decodeUtf8, tryParseYamlValue } from "./document";
import type { GitReader } from "./git";
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

function originMainFiles(
  input: LoadPolicyInput,
): { ok: true; files: Map<string, Uint8Array> } | { ok: false; message: string } {
  const fetched = input.git.fetchOriginMain(input.repo);
  if (!fetched.ok) return { ok: false, message: unavailable(fetched.stderr) };
  const commit = fetched.commit.trim().toLowerCase();
  if (!isSha(commit)) return { ok: false, message: "origin/main is unavailable" };
  const listed = input.git.lsRemoteOriginMain(input.repo);
  if (!listed.ok) return { ok: false, message: unavailable(listed.stderr) };
  const remote = remoteSha(listed.stdout);
  if (remote === undefined || remote !== commit)
    return { ok: false, message: "origin/main is unavailable" };
  return materialize(input.git, input.repo, commit);
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

function blocked(source: "repo" | "global" | "local", message: string): PolicyLoadOutcome {
  return { ok: false, source, message };
}

function regularMode(mode: string): boolean {
  return mode === "100644" || mode === "100755";
}

const LINK_DEPTH = 16;

type Resolved =
  | { kind: "file"; bytes: Uint8Array }
  | { kind: "directory"; entries: Array<{ path: string; bytes: Uint8Array }> }
  | { kind: "missing" };

function resolveTarget(
  git: GitReader,
  repo: string,
  commit: string,
  path: string,
  depth: number,
): Resolved | { ok: false; message: string } {
  if (depth > LINK_DEPTH) return { ok: false, message: `skill link loops: ${path}` };
  const listed = git.listBlobs(repo, commit, path);
  if (!listed.ok) return { ok: false, message: "could not read the policy file" };
  const exact = listed.blobs.find((entry) => entry.path === path);
  if (exact !== undefined) {
    if (exact.mode === "120000") {
      const read = git.readBlob(repo, exact.object);
      if (!read.ok) return { ok: false, message: "could not read the policy file" };
      return followLink(git, repo, commit, path, decodeUtf8(read.bytes) ?? "", depth + 1);
    }
    if (!regularMode(exact.mode))
      return { ok: false, message: `skill path is not a file: ${path}` };
    const read = git.readBlob(repo, exact.object);
    if (!read.ok) return { ok: false, message: "could not read the policy file" };
    return { kind: "file", bytes: read.bytes };
  }
  const below = listed.blobs.filter((entry) => entry.path.startsWith(`${path}/`));
  if (below.length === 0) return throughAncestors(git, repo, commit, path, depth);
  const entries: Array<{ path: string; bytes: Uint8Array }> = [];
  for (const blob of below) {
    const resolved = resolveTarget(git, repo, commit, blob.path, depth + 1);
    if ("ok" in resolved) return resolved;
    if (resolved.kind === "file")
      entries.push({ path: blob.path.slice(path.length + 1), bytes: resolved.bytes });
    else if (resolved.kind === "directory")
      for (const entry of resolved.entries)
        entries.push({
          path: `${blob.path.slice(path.length + 1)}/${entry.path}`,
          bytes: entry.bytes,
        });
  }
  return { kind: "directory", entries };
}

function followLink(
  git: GitReader,
  repo: string,
  commit: string,
  linkPath: string,
  target: string,
  depth: number,
): Resolved | { ok: false; message: string } {
  if (target.length === 0 || target.includes("\0"))
    return { ok: false, message: `skill link is broken: ${linkPath}` };
  if (!target.startsWith("/")) {
    const joined = normalizeJoin(parentOf(linkPath), target);
    if (joined === "") return { ok: false, message: `skill path is not a file: ${linkPath}` };
    if (joined !== undefined && repoPath(joined) !== undefined) {
      const inTree = resolveTarget(git, repo, commit, joined, depth);
      if (!("ok" in inTree) && inTree.kind === "missing")
        return { ok: false, message: `skill link is broken: ${linkPath}` };
      return inTree;
    }
  }
  const onDisk = target.startsWith("/") ? target : join(repo, parentOf(linkPath), target);
  return readDisk(onDisk, linkPath, depth);
}

function throughAncestors(
  git: GitReader,
  repo: string,
  commit: string,
  path: string,
  depth: number,
): Resolved | { ok: false; message: string } {
  const parts = path.split("/");
  for (let cut = parts.length - 1; cut >= 1; cut -= 1) {
    const prefix = parts.slice(0, cut).join("/");
    const remainder = parts.slice(cut).join("/");
    const listed = git.listBlobs(repo, commit, prefix);
    if (!listed.ok) return { ok: false, message: "could not read the policy file" };
    const exact = listed.blobs.find((entry) => entry.path === prefix);
    if (exact === undefined) continue;
    if (exact.mode !== "120000") return { kind: "missing" };
    const read = git.readBlob(repo, exact.object);
    if (!read.ok) return { ok: false, message: "could not read the policy file" };
    const target = decodeUtf8(read.bytes) ?? "";
    if (target.length === 0 || target.includes("\0"))
      return { ok: false, message: `skill link is broken: ${prefix}` };
    if (!target.startsWith("/")) {
      const joined = normalizeJoin(parentOf(prefix), target);
      if (joined !== undefined && (joined === "" || repoPath(joined) !== undefined)) {
        const inTree = resolveTarget(
          git,
          repo,
          commit,
          joined === "" ? remainder : `${joined}/${remainder}`,
          depth + 1,
        );
        if (!("ok" in inTree) && inTree.kind === "missing")
          return { ok: false, message: `skill link is broken: ${prefix}` };
        return inTree;
      }
    }
    const onDisk = target.startsWith("/")
      ? join(target, ...remainder.split("/"))
      : join(repo, parentOf(prefix), target, ...remainder.split("/"));
    return readDisk(onDisk, path, depth + 1);
  }
  return { kind: "missing" };
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

function normalizeJoin(dir: string, target: string): string | undefined {
  const segments: string[] = dir.length ? dir.split("/") : [];
  for (const part of target.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segments.length === 0) return undefined;
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  return segments.join("/");
}

function readDisk(
  absolute: string,
  linkPath: string,
  depth: number,
): Resolved | { ok: false; message: string } {
  let info;
  try {
    info = statSync(absolute);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ELOOP") return { ok: false, message: `skill link loops: ${linkPath}` };
    return { ok: false, message: `skill link is broken: ${linkPath}` };
  }
  if (info.isFile()) {
    try {
      return { kind: "file", bytes: new Uint8Array(readFileSync(absolute)) };
    } catch {
      return { ok: false, message: "could not read the policy file" };
    }
  }
  if (!info.isDirectory()) return { ok: false, message: `skill path is not a file: ${linkPath}` };
  if (depth > LINK_DEPTH) return { ok: false, message: `skill link loops: ${linkPath}` };
  const entries: Array<{ path: string; bytes: Uint8Array }> = [];
  let names: string[];
  try {
    names = readdirSync(absolute);
  } catch {
    return { ok: false, message: "could not read the skill directory" };
  }
  for (const name of names.sort()) {
    const child = readDisk(join(absolute, name), `${linkPath}/${name}`, depth + 1);
    if ("ok" in child) return child;
    if (child.kind === "file") entries.push({ path: name, bytes: child.bytes });
    else if (child.kind === "directory")
      for (const entry of child.entries)
        entries.push({ path: `${name}/${entry.path}`, bytes: entry.bytes });
  }
  return { kind: "directory", entries };
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
    const resolved = resolveTarget(git, repo, commit, relative, 0);
    if ("ok" in resolved) return resolved;
    if (resolved.kind === "missing") continue;
    if (resolved.kind === "directory")
      return { ok: false, message: `policy path is not a file: ${relative}` };
    files.set(relative, resolved.bytes);
    if (relative.endsWith("/SKILL.md")) {
      const slash = relative.lastIndexOf("/");
      const copied = copyTree(git, repo, commit, files, relative.slice(0, slash));
      if (!copied.ok) return copied;
    } else {
      const text = decodeUtf8(resolved.bytes);
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
  const resolved = resolveTarget(git, repo, commit, dir, 0);
  if ("ok" in resolved) return resolved;
  if (resolved.kind !== "directory")
    return { ok: false, message: `skill is missing: ${dir}/SKILL.md` };
  for (const entry of resolved.entries) {
    const path = `${dir}/${entry.path}`;
    if (repoPath(path) === undefined)
      return { ok: false, message: `import path is not repository-relative: ${path}` };
    files.set(path, entry.bytes);
  }
  return { ok: true };
}
