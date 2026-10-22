import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { controlledGit } from "./controlled-git";
import { publicationExec } from "./publication";
import { retryGitTransport } from "./transport";
import { GitCommandError, type GitExec } from "./types";

const exec = promisify(execFile);

const HELPER = `#!/bin/sh
if [ "$1" = "get" ]; then
  printf 'username=x-access-token\\n'
  printf 'password=%s\\n' "$PAWS_GITHUB_TOKEN"
fi
`;

export function defaultGitExec(bin = "/usr/bin/git"): GitExec {
  return async (args, options) => {
    if (options.signal) return controlledGit(bin, args, options);
    try {
      const { stdout, stderr } = await exec(bin, args, {
        cwd: options.cwd,
        env: options.env,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      });
      return { stdout: stdout ?? "", stderr: stderr ?? "" };
    } catch (error) {
      const stderr =
        typeof error === "object" && error !== null && "stderr" in error
          ? String((error as { stderr?: string }).stderr ?? "")
          : "";
      throw new GitCommandError(args, stderr);
    }
  };
}

export function gitEnv(token?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.GH_ENTERPRISE_TOKEN;
  delete env.SSH_AUTH_SOCK;
  delete env.PAWS_GITHUB_TOKEN;
  env.GIT_TERMINAL_PROMPT = "0";
  if (token !== undefined) env.PAWS_GITHUB_TOKEN = token;
  return env;
}

/**
 * Run git with a one-shot credential helper. The token stays in the child
 * environment. It is not written into the helper file or git config.
 */
export async function withCredential<T>(
  token: string,
  gitExec: GitExec,
  fn: (helper: { argsPrefix: string[]; env: NodeJS.ProcessEnv; exec: GitExec }) => Promise<T>,
  options: { tokenInFile?: boolean; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const tokenInFile = options.tokenInFile === true;
  if (/\s/.test(token)) throw new Error("refusing to pass a token that contains whitespace");
  const dir = await mkdtemp(path.join(tmpdir(), "paws-git-"));
  const helperPath = path.join(dir, "cred.sh");
  const tokenPath = path.join(dir, "token");
  const script = tokenInFile
    ? HELPER.replace('"$PAWS_GITHUB_TOKEN"', `"$(cat '${tokenPath.replaceAll("'", "'\\''")}')"`)
    : HELPER;
  await writeFile(helperPath, script, { mode: 0o700 });
  await chmod(helperPath, 0o700);
  try {
    return await fn({
      argsPrefix: [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "credential.helper=",
        "-c",
        `credential.helper=${helperPath}`,
      ],
      env: gitEnv(tokenInFile ? undefined : token),
      exec: retryGitTransport(
        publicationExec(gitExec, tokenInFile ? { path: tokenPath, token } : undefined),
        options.sleep,
      ),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function git(
  cwd: string,
  args: string[],
  gitExec: GitExec = defaultGitExec(),
): Promise<string> {
  const result = await gitExec(args, { cwd, env: gitEnv() });
  return result.stdout.trim();
}

export function redact(token: string, text: string): string {
  const scrubbed = token.length === 0 ? text : text.split(token).join("[redacted]");
  return scrubbed.replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, "[redacted]");
}

export function gitFailureReason(token: string, error: unknown): string {
  const stderr = error instanceof GitCommandError ? error.stderr.trim() : "";
  const message = error instanceof Error ? error.message : String(error);
  return redact(token, stderr === "" ? message : stderr);
}
