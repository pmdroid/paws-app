import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { agentEnv } from "./gh";
import type { GitHubTokenProvider, TokenPurpose } from "./types";

/** Same text as `GITHUB_REAUTH_MESSAGE` in `src/auth`. GitHub does not import that module. */
export const OAUTH_REAUTH_MESSAGE = "Run `bun run paws login github`";

/**
 * Adapts a signed-in user token to the GitHub operation provider.
 * Comments and pull requests are opened as that user. `@paws` is only a text trigger.
 * Clone, fetch, and push each get a one-shot credential helper. The token is not
 * placed in the agent environment, git argv, the remote URL, or error text.
 */
export function createOAuthGitAuth(input: {
  owner: string;
  repo: string;
  token: () => Promise<string>;
}): GitHubTokenProvider {
  return {
    mode: "oauth",
    async tokenFor(purpose: TokenPurpose): Promise<string> {
      const token = await input.token();
      if (token.length === 0 || /\s/.test(token)) {
        throw new Error(`${OAUTH_REAUTH_MESSAGE} (${purpose})`);
      }
      return token;
    },
  };
}

export async function runGitHubGit(input: {
  operation: "clone" | "fetch" | "push";
  remoteUrl: string;
  token: string;
  cwd: string;
  dest?: string;
  refspec?: string;
  env?: NodeJS.ProcessEnv;
  gitBin?: string;
}): Promise<void> {
  if (/\s/.test(input.token)) throw new Error(OAUTH_REAUTH_MESSAGE);
  assertCleanRemote(input.remoteUrl, input.token);
  const dir = await mkdtemp(path.join(tmpdir(), "paws-git-"));
  const tokenFile = path.join(dir, "token");
  const helperPath = path.join(dir, "cred.sh");
  await writeFile(tokenFile, input.token, { mode: 0o600 });
  await chmod(tokenFile, 0o600);
  await writeFile(helperPath, helperScript(tokenFile), { mode: 0o700 });
  await chmod(helperPath, 0o700);
  const args = gitArgs(input, helperPath);
  const env = operationEnv(input.env);
  try {
    const bin = input.gitBin ?? "git";
    const proc = Bun.spawn([bin, ...args], {
      cwd: input.cwd,
      env: defined(env),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      const detail = redact(input.token, stderr || stdout).trim();
      throw new Error(detail.length > 0 ? detail : `git ${input.operation} failed`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function rejectUnauthorized(
  status: number,
  invalidate: () => Promise<void>,
): Promise<void> {
  if (status !== 401) return;
  await invalidate();
  throw new Error(OAUTH_REAUTH_MESSAGE);
}

function gitArgs(
  input: {
    operation: "clone" | "fetch" | "push";
    remoteUrl: string;
    dest?: string;
    refspec?: string;
  },
  helperPath: string,
): string[] {
  const prefix = ["-c", "credential.helper=", "-c", `credential.helper=${helperPath}`];
  if (input.operation === "clone") {
    if (input.dest === undefined) throw new Error("clone needs a destination");
    return [...prefix, "clone", "--bare", input.remoteUrl, input.dest];
  }
  if (input.operation === "fetch") {
    if (input.dest === undefined) throw new Error("fetch needs a git dir");
    return [...prefix, "--git-dir", input.dest, "fetch", "--prune", "origin"];
  }
  if (input.refspec === undefined) throw new Error("push needs a refspec");
  return [...prefix, "push", input.remoteUrl, input.refspec];
}

function helperScript(tokenFile: string): string {
  const quoted = `'${tokenFile.replaceAll("'", `'\\''`)}'`;
  return `#!/bin/sh
if [ "$1" = "get" ]; then
  printf 'username=x-access-token\\n'
  printf 'password=%s\\n' "$(cat ${quoted})"
fi
`;
}

function operationEnv(base: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const env = agentEnv(base ?? process.env);
  delete env.PAWS_GITHUB_TOKEN;
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.GH_ENTERPRISE_TOKEN;
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

function assertCleanRemote(remoteUrl: string, token: string): void {
  if (remoteUrl.includes(token) || /\/\/[^/\s@]+@/.test(remoteUrl)) {
    throw new Error("refusing a remote URL that contains credentials");
  }
}

function redact(token: string, text: string): string {
  if (token.length === 0) return text;
  return text.split(token).join("[redacted]");
}

function defined(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
