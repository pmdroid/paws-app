import { journalCaught } from "../journal";
import { withCredential } from "./git";
import { isPushOutage, PushOutageError } from "./transport";
import { GitCommandError, type GitExec } from "./types";

type PushInput = {
  worktree: string;
  url: string;
  branch: string;
  token: string;
  gitExec: GitExec;
  sleep?: (ms: number) => Promise<void>;
};

export async function pushWithLease(input: PushInput): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const remote = await remoteBranchSha(input);
    try {
      await withCredential(
        input.token,
        input.gitExec,
        async (helper) => {
          const args = [...helper.argsPrefix, "push"];
          if (remote) args.push(`--force-with-lease=refs/heads/${input.branch}:${remote}`);
          args.push(input.url, `HEAD:refs/heads/${input.branch}`);
          await helper.exec(args, { cwd: input.worktree, env: helper.env });
        },
        { sleep: input.sleep },
      );
      return;
    } catch (error) {
      if (
        attempt === 1 &&
        error instanceof GitCommandError &&
        /\(stale info\)/.test(error.stderr)
      ) {
        const message = input.token
          ? error.message.replaceAll(input.token, "[redacted]")
          : error.message;
        journalCaught(message, "push.pushWithLease", null, "remote lease changed; retrying once");
        continue;
      }
      if (error instanceof PushOutageError) throw error;
      if (error instanceof GitCommandError && isPushOutage(error.stderr))
        throw new PushOutageError(error.args, error.stderr);
      throw error;
    }
  }
}

/** The token a push used, as a denial names it. Never the token itself. */
export type PushTokenLabel = {
  owner: string;
  repo: string;
  /** Empty when an injected provider supplied the token. */
  installationId?: string;
};

/**
 * Explain a push GitHub refused with HTTP 403 or a workflow refusal: which token pushed and the
 * permission it lacked. Null when the push failed for another reason.
 */
export function pushDenial(stderr: string, token: PushTokenLabel): string | null {
  const scope = `${token.owner}/${token.repo}`;
  const installation = token.installationId ? ` (installation ${token.installationId})` : "";
  const name = `the GitHub App push token for ${scope}${installation}`;
  const workflow = /refusing to allow a GitHub App to create or update workflow `([^`]+)`/.exec(
    stderr,
  );
  if (workflow)
    return `GitHub denied ${name}: it lacks the "workflows" permission needed to push a change to ${workflow[1]}`;
  const denied = /Permission to (\S+?)(?:\.git)? denied to (\S+?)\.?\s*$/m.exec(stderr);
  if (!denied && !/returned error: 403\b/.test(stderr)) return null;
  const target = denied?.[1];
  const actor = denied?.[2] ? ` acting as ${denied[2]}` : "";
  if (target && target.toLowerCase() !== scope.toLowerCase())
    return `GitHub denied ${name}${actor} with HTTP 403: the token is scoped to ${scope}, not ${target}`;
  return `GitHub denied ${name}${actor} with HTTP 403: it lacks "contents: write" on ${scope}`;
}

export async function remoteBranchSha(input: PushInput): Promise<string | null> {
  return withCredential(
    input.token,
    input.gitExec,
    async (helper) => {
      const result = await helper.exec(
        [...helper.argsPrefix, "ls-remote", input.url, `refs/heads/${input.branch}`],
        { cwd: input.worktree, env: helper.env },
      );
      const lines = result.stdout
        .trim()
        .split("\n")
        .filter((entry) => entry !== "");
      if (lines.length === 0) return null;
      if (lines.length !== 1) throw new Error("ls-remote returned more than one branch");
      const sha = lines[0]?.split("\t")[0];
      if (!sha) throw new Error("ls-remote returned an empty sha");
      return sha;
    },
    { sleep: input.sleep },
  );
}
