import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SkillSource } from "../db";
import {
  readSkillFolder,
  SKILL_BUNDLE_LIMIT,
  SkillError,
  skillPath,
  skillSubfolder,
  tooLarge,
  type SkillFiles,
} from "./bundle";

export type RemoteSkillSource = Exclude<SkillSource, { kind: "upload" }>;

/** What to resolve. `version` pins an npm version or dist-tag; omitted, the newest wins. */
export type SkillRequest =
  | (Extract<SkillSource, { kind: "npm" }> & { version?: string })
  | (Extract<SkillSource, { kind: "git" }> & { path?: string });

export type ResolvedSkill = {
  source: RemoteSkillSource;
  /** Exact package version or full commit. */
  version: string;
  /** Files of the skill folder, already re-rooted at the subfolder. */
  files: SkillFiles;
  /** Name to fall back on when SKILL.md does not declare one. */
  suggestedName: string;
};

/** Fetches a source once and pins it. Tests use `fakeSkillResolver`. */
export type SkillResolver = {
  resolve(request: SkillRequest, signal?: AbortSignal): Promise<ResolvedSkill>;
};

export type SkillResolverOptions = {
  fetch?: typeof fetch;
  registry?: string;
  git?: string;
  limit?: number;
};

const PACKAGE = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;

export function createSkillResolver(options: SkillResolverOptions = {}): SkillResolver {
  const fetchImpl = options.fetch ?? fetch;
  const registry = (options.registry ?? "https://registry.npmjs.org").replace(/\/+$/, "");
  const limit = options.limit ?? SKILL_BUNDLE_LIMIT;
  return {
    async resolve(request, signal) {
      return request.kind === "npm"
        ? resolveNpm(request, { fetch: fetchImpl, registry, limit, signal })
        : resolveTree(request, { git: options.git ?? "git", limit, signal });
    },
  };
}

type NpmContext = {
  fetch: typeof fetch;
  registry: string;
  limit: number;
  signal: AbortSignal | undefined;
};

async function resolveNpm(
  request: Extract<SkillRequest, { kind: "npm" }>,
  context: NpmContext,
): Promise<ResolvedSkill> {
  const name = request.package.trim().toLowerCase();
  if (!PACKAGE.test(name)) throw new SkillError("Enter an npm package name such as impeccable.");
  const response = await context.fetch(`${context.registry}/${name.replace("/", "%2f")}`, {
    headers: { Accept: "application/vnd.npm.install-v1+json" },
    ...(context.signal ? { signal: context.signal } : {}),
  });
  if (response.status === 404) throw new SkillError(`npm has no package named ${name}.`, 404);
  if (!response.ok) throw new SkillError(`npm answered ${response.status} for ${name}.`, 502);
  const packument = (await response.json()) as {
    "dist-tags"?: Record<string, string>;
    versions?: Record<string, { dist?: { tarball?: string; integrity?: string; shasum?: string } }>;
  };
  const wanted = request.version?.trim() || "latest";
  const version = packument.versions?.[wanted] ? wanted : packument["dist-tags"]?.[wanted];
  const dist = version === undefined ? undefined : packument.versions?.[version]?.dist;
  if (version === undefined || dist?.tarball === undefined)
    throw new SkillError(`npm has no version ${wanted} of ${name}.`, 404);
  if (!/^https:\/\//.test(dist.tarball) && !dist.tarball.startsWith(context.registry))
    throw new SkillError(`npm returned an unexpected tarball address for ${name}.`, 502);
  const tarball = await context.fetch(dist.tarball, {
    ...(context.signal ? { signal: context.signal } : {}),
  });
  if (!tarball.ok)
    throw new SkillError(`npm answered ${tarball.status} for ${name}@${version}.`, 502);
  if (Number(tarball.headers.get("content-length") ?? 0) > context.limit)
    throw tooLarge(context.limit);
  const bytes = new Uint8Array(await tarball.arrayBuffer());
  if (bytes.byteLength > context.limit) throw tooLarge(context.limit);
  if (!integrityMatches(bytes, dist))
    throw new SkillError(`The ${name}@${version} tarball does not match its npm checksum.`, 502);
  const files: SkillFiles = new Map();
  let size = 0;
  for (const [path, file] of await new Bun.Archive(bytes).files()) {
    size += file.size;
    if (size > context.limit) throw tooLarge(context.limit);
    // npm packs everything under one top folder, normally `package/`.
    const inner = path.replace(/^[^/]+\//, "");
    if (inner !== path) files.set(inner, new Uint8Array(await file.arrayBuffer()));
  }
  return {
    source: {
      kind: "npm",
      package: name,
      ...(request.subfolder ? { subfolder: request.subfolder } : {}),
    },
    version,
    files: skillSubfolder(files, request.subfolder),
    suggestedName: (request.subfolder ?? name).split("/").at(-1)!,
  };
}

function integrityMatches(
  bytes: Uint8Array,
  dist: { integrity?: string; shasum?: string },
): boolean {
  const sha512 = dist.integrity
    ?.split(/\s+/)
    .find((value) => value.startsWith("sha512-"))
    ?.slice(7);
  if (sha512 !== undefined) return createHash("sha512").update(bytes).digest("base64") === sha512;
  if (dist.shasum !== undefined)
    return createHash("sha1").update(bytes).digest("hex") === dist.shasum;
  return false;
}

type GitContext = { git: string; limit: number; signal: AbortSignal | undefined };

async function resolveTree(
  request: Extract<SkillRequest, { kind: "git" }>,
  context: GitContext,
): Promise<ResolvedSkill> {
  const { path, ...source } = request;
  if (path === undefined || source.ref?.trim() || !gitUrl(source.url.trim()))
    return resolveGit(source, context);
  const listed = await git(context, tmpdir(), [
    "ls-remote",
    "--heads",
    "--tags",
    "--",
    source.url.trim(),
  ]);
  const ref =
    listed
      .split("\n")
      .map((line) => (line.split("\t")[1] ?? "").replace(/^refs\/(?:heads|tags)\/|\^\{\}$/g, ""))
      .filter((name) => name && (path === name || path.startsWith(`${name}/`)))
      .sort((a, b) => b.length - a.length)[0] ?? path.split("/")[0]!;
  const subfolder = source.subfolder ?? path.slice(ref.length + 1);
  return resolveGit({ ...source, ref, ...(subfolder ? { subfolder } : {}) }, context);
}

async function resolveGit(
  request: Extract<SkillRequest, { kind: "git" }>,
  context: GitContext,
): Promise<ResolvedSkill> {
  const url = request.url.trim();
  if (!gitUrl(url))
    throw new SkillError("Enter a git URL such as https://github.com/owner/skills.git.");
  const ref = request.ref?.trim() || undefined;
  if (ref !== undefined && (ref.startsWith("-") || !/^[\w./@^~+-]{1,200}$/.test(ref)))
    throw new SkillError("That git ref is not allowed.");
  if (request.subfolder !== undefined && skillPath(request.subfolder) === null)
    throw new SkillError("The subfolder must be a relative path.");
  const dir = mkdtempSync(join(tmpdir(), "paws-skill-"));
  try {
    const run = (args: string[]) => git(context, dir, args);
    await run(["init", "--quiet"]);
    const commit =
      ref !== undefined && commitRef(ref)
        ? ref.toLowerCase()
        : await remoteCommit(context, dir, url, ref);
    await run(["fetch", "--quiet", "--depth", "1", "--", url, commit]);
    await run(["checkout", "--quiet", "--detach", "FETCH_HEAD"]);
    const head = (await run(["rev-parse", "HEAD"])).trim();
    const subfolder = request.subfolder === undefined ? "" : skillPath(request.subfolder)!;
    const files = skillSubfolder(readSkillFolder(dir, context.limit, subfolder), request.subfolder);
    const repo = url.replace(/\.git$/, "").replace(/\/+$/, "");
    return {
      source: {
        kind: "git",
        url,
        ...(ref ? { ref } : {}),
        ...(request.subfolder ? { subfolder: request.subfolder } : {}),
      },
      version: head,
      files,
      suggestedName: (request.subfolder ?? repo).split(/[/:]/).at(-1)!,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function commitRef(ref: string): boolean {
  return /^[0-9a-f]{40}$/i.test(ref);
}

export async function gitRemoteCommit(
  url: string,
  ref: string | undefined,
  options: { git?: string; signal?: AbortSignal } = {},
): Promise<string> {
  return remoteCommit(
    { git: options.git ?? "git", limit: SKILL_BUNDLE_LIMIT, signal: options.signal },
    tmpdir(),
    url,
    ref,
  );
}

async function remoteCommit(
  context: GitContext,
  cwd: string,
  url: string,
  ref: string | undefined,
): Promise<string> {
  const listed = await git(context, cwd, [
    "ls-remote",
    "--",
    url,
    ...(ref === undefined ? ["HEAD"] : [ref, `${ref}^{}`]),
  ]);
  const lines = listed.split("\n").filter(Boolean);
  const line =
    lines.find((value) => value.endsWith("^{}")) ??
    lines.find((value) => value.split("\t")[1] === ref) ??
    lines[0];
  const found = line?.split("\t")[0];
  if (found === undefined || !/^[0-9a-f]{40}$/.test(found))
    throw new SkillError(`${url} has no ${ref ?? "default branch"} to pin.`, 404);
  return found;
}

/** https, ssh, git, or a local path on this machine. Never a transport helper such as `ext::`. */
export function gitUrl(url: string): boolean {
  if (url.startsWith("-") || /\s/.test(url)) return false;
  if (/^(?:https|ssh|git|file):\/\/[^/]/.test(url)) return true;
  if (/^[\w.-]+@[\w.-]+:[^/]/.test(url)) return true;
  return url.startsWith("/");
}

async function git(context: GitContext, cwd: string, args: string[]): Promise<string> {
  const child = Bun.spawn([context.git, "-c", "protocol.ext.allow=never", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120_000,
    ...(context.signal ? { signal: context.signal } : {}),
    // Only what git needs to reach the developer's own credentials; no Paws secrets.
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
      ...(process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}),
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    const reason = stderr.trim().split("\n").at(-1) ?? `exit ${code}`;
    throw new SkillError(`git ${args[0]} failed: ${reason.slice(0, 300)}`, 502);
  }
  return stdout;
}
