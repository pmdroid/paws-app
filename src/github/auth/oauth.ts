import { existsSync } from "node:fs";
import path from "node:path";
import { defaultGitExec, withCredential } from "../git";
import { GitCommandError } from "../types";
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
  signal?: AbortSignal;
}): Promise<void> {
  input.signal?.throwIfAborted();
  if (/\s/.test(input.token)) throw new Error(OAUTH_REAUTH_MESSAGE);
  assertCleanRemote(input.remoteUrl, input.token);
  const gitExec = defaultGitExec(input.gitBin ?? trustedGitBin(input.env));
  await withCredential(
    input.token,
    gitExec,
    async (helper) => {
      let args: string[];
      let cwd = input.cwd;
      if (input.operation === "clone") {
        if (!input.dest) throw new Error("clone needs a destination");
        args = ["clone", "--bare", input.remoteUrl, path.resolve(input.cwd, input.dest)];
      } else if (input.operation === "fetch") {
        if (!input.dest) throw new Error("fetch needs a git dir");
        cwd = path.resolve(input.cwd, input.dest);
        args = ["fetch", input.remoteUrl, "+refs/heads/*:refs/heads/*"];
      } else {
        if (!input.refspec) throw new Error("push needs a refspec");
        args = ["push", input.remoteUrl, input.refspec];
      }
      try {
        await helper.exec([...helper.argsPrefix, ...args], {
          cwd,
          env: helper.env,
          signal: input.signal,
        });
      } catch (error) {
        const detail = error instanceof GitCommandError ? error.stderr : String(error);
        throw new Error(redact(input.token, detail), { cause: error });
      }
    },
    true,
  );
}

export async function rejectUnauthorized(
  status: number,
  invalidate: () => Promise<void>,
): Promise<void> {
  if (status !== 401) return;
  await invalidate();
  throw new Error(OAUTH_REAUTH_MESSAGE);
}

function trustedGitBin(env: NodeJS.ProcessEnv | undefined): string {
  for (const dir of (env?.PATH ?? "/usr/bin:/bin").split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const bin = path.join(dir, "git");
    if (existsSync(bin)) return bin;
  }
  return "/usr/bin/git";
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
