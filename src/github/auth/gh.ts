import { execFile } from "node:child_process";
import path from "node:path";
import type { DoctorCheck, GitHubTokenProvider, TokenPurpose } from "./types";
import { GhAuthError } from "./types";

const GH_AUTH_STATUS_CHECK = "gh-auth-status";
const GH_PUSH_PERMISSION_CHECK = "gh-push-permission";

const TOKEN_ENV_KEYS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_PAT",
  "PAWS_GITHUB_TOKEN",
] as const;

const NAME = /^[A-Za-z0-9._-]+$/;

export type GhCliOptions = {
  owner: string;
  repo: string;
  access?: "read" | "write";
  /** Prepended to PATH so tests can place a fake `gh` ahead of any real binary. */
  pathPrefix?: string;
  /** Absolute path or name of the gh binary. Defaults to `gh`. */
  ghBin?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

type GhResult = { code: number; stdout: string; stderr: string };

/**
 * Environment for a spawned coding agent.
 * The gh token is never copied here. Git receives it only inside the one-shot
 * credential helper, and that helper env must not be reused for an agent.
 */
export function agentEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value == null) continue;
    if (isSecretEnv(key)) continue;
    env[key] = value;
  }
  return env;
}

/**
 * Token from `gh auth token` for a single push, pull request, or merge.
 * The token is not stored and is not placed in the agent environment.
 * A developer's gh token can reach every repo they can; the ACP permission
 * guard and the agent env scrub are what keep that token out of the agent.
 */
export function createGhCliAuth(options: GhCliOptions): GitHubTokenProvider {
  return {
    mode: "gh",
    async tokenFor(purpose: TokenPurpose): Promise<string> {
      assertRepo(options.owner, options.repo);
      const status = await checkGhAuthStatus(options);
      if (!status.ok) throw new GhAuthError(status.message);
      const permission = await checkGhPermission(
        options,
        options.access === "read" ? "pull" : "push",
      );
      if (!permission.ok) throw new GhAuthError(permission.message);
      return readGhAuthToken(options, purpose);
    },
  };
}

export async function readGhUserToken(options: GhCliOptions): Promise<string> {
  const status = await checkGhAuthStatus(options);
  if (!status.ok) throw new GhAuthError(status.message);
  return readGhAuthToken(options, "pr");
}

/** Doctor check: `gh auth status` shows a login. Does not print or keep a token. */
export async function checkGhAuthStatus(options: GhCliOptions): Promise<DoctorCheck> {
  assertRepo(options.owner, options.repo);
  const result = await runGh(["auth", "status"], options);
  if (result.code === 127) {
    return {
      name: GH_AUTH_STATUS_CHECK,
      ok: false,
      message: "gh auth status failed: gh is not on PATH",
    };
  }
  if (result.code !== 0) {
    return {
      name: GH_AUTH_STATUS_CHECK,
      ok: false,
      message: "gh auth status failed: not logged in to GitHub. Run gh auth login.",
    };
  }
  return { name: GH_AUTH_STATUS_CHECK, ok: true, message: "gh is logged in" };
}

/** Doctor check: the gh login can push to the configured repository. */
export async function checkGhPushPermission(options: GhCliOptions): Promise<DoctorCheck> {
  return checkGhPermission(options, "push");
}

async function checkGhPermission(
  options: GhCliOptions,
  access: "pull" | "push",
): Promise<DoctorCheck> {
  const name = access === "push" ? GH_PUSH_PERMISSION_CHECK : "gh-read-permission";
  assertRepo(options.owner, options.repo);
  const result = await runGh(["api", `repos/${options.owner}/${options.repo}`], options);
  if (result.code === 127) {
    return {
      name,
      ok: false,
      message: `gh ${access} permission check failed: gh is not on PATH`,
    };
  }
  if (result.code !== 0) {
    const detail = safeLine(result.stderr);
    return {
      name,
      ok: false,
      message:
        detail.length > 0
          ? `gh ${access} permission check failed for ${options.owner}/${options.repo}: ${detail}`
          : `gh ${access} permission check failed for ${options.owner}/${options.repo}`,
    };
  }
  const allowed = permissionAllowed(result.stdout, access);
  if (allowed === null) {
    return {
      name,
      ok: false,
      message: `gh ${access} permission check failed for ${options.owner}/${options.repo}: response did not include permissions.${access}`,
    };
  }
  if (!allowed) {
    return {
      name,
      ok: false,
      message: `gh login does not have ${access} permission on ${options.owner}/${options.repo}`,
    };
  }
  return {
    name,
    ok: true,
    message: `gh login has ${access} permission on ${options.owner}/${options.repo}`,
  };
}

/** Both gh doctor checks. Wiring into the process doctor is QM-20. */
export async function ghDoctorChecks(options: GhCliOptions): Promise<DoctorCheck[]> {
  return [await checkGhAuthStatus(options), await checkGhPushPermission(options)];
}

function assertRepo(owner: string, repo: string): void {
  if (!NAME.test(owner) || !NAME.test(repo)) {
    throw new GhAuthError("owner and repo must be GitHub names");
  }
}

async function readGhAuthToken(options: GhCliOptions, purpose: TokenPurpose): Promise<string> {
  const result = await runGh(["auth", "token"], options);
  if (result.code !== 0) {
    const detail = safeLine(result.stderr);
    throw new GhAuthError(
      detail.length > 0
        ? `gh auth token failed during ${purpose}: ${detail}`
        : `gh auth token failed during ${purpose}`,
    );
  }
  const token = result.stdout.trim();
  if (token.length === 0 || /\s/.test(token)) {
    throw new GhAuthError(`gh auth token returned an unusable token during ${purpose}`);
  }
  return token;
}

async function runGh(args: string[], options: GhCliOptions): Promise<GhResult> {
  const bin = options.ghBin ?? "gh";
  const env = ghCommandEnv(options.env ?? process.env, options.pathPrefix);
  return runFile(bin, args, { ...(options.cwd ? { cwd: options.cwd } : {}), env });
}

/** `gh` reads the stored login. Token variables are removed so a fetched token cannot be reused. */
function ghCommandEnv(base: NodeJS.ProcessEnv, pathPrefix?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of TOKEN_ENV_KEYS) delete env[key];
  env.GIT_TERMINAL_PROMPT = "0";
  env.GH_PROMPT_DISABLED = "1";
  if (pathPrefix !== undefined && pathPrefix.length > 0) {
    const current = env.PATH;
    env.PATH = current ? `${pathPrefix}${path.delimiter}${current}` : pathPrefix;
  }
  return env;
}

function isSecretEnv(key: string): boolean {
  if ((TOKEN_ENV_KEYS as readonly string[]).includes(key)) return true;
  if (key === "NODE_AUTH_TOKEN") return true;
  return key.startsWith("GH_") || key.startsWith("GITHUB_");
}

function permissionAllowed(stdout: string, access: "pull" | "push"): boolean | null {
  const text = stdout.trim();
  if (access === "push" && text === "true") return true;
  if (access === "push" && text === "false") return false;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return null;
    const permissions = parsed.permissions;
    if (!isRecord(permissions) || typeof permissions[access] !== "boolean") return null;
    return permissions[access];
  } catch {
    return null;
  }
}

function safeLine(text: string): string {
  const line = text
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  if (line === undefined) return "";
  return line
    .replace(/\b(?:gho|ghs|ghp|ghu|ghr)_[A-Za-z0-9_]+\b/g, "[redacted]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]+\b/g, "[redacted]")
    .slice(0, 300);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ExecError = Error & {
  code?: number | string;
  status?: number;
  killed?: boolean;
  signal?: string | null;
};

function runFile(
  bin: string,
  args: string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv },
): Promise<GhResult> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        env: options.env,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: 15_000,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
          return;
        }
        const err = error as ExecError;
        if (err.code === "ENOENT" || err.code === "EACCES") {
          resolve({ code: 127, stdout: "", stderr: "gh is not on PATH" });
          return;
        }
        if (err.killed || err.signal === "SIGTERM") {
          resolve({ code: 124, stdout: "", stderr: "gh timed out" });
          return;
        }
        const code = typeof err.code === "number" ? err.code : err.status;
        if (typeof code === "number") {
          resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
          return;
        }
        reject(error);
      },
    );
  });
}
