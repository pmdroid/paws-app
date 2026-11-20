import { journalCaught } from "../journal";
import { gitFailureReason, withCredential } from "./git";
import { isPushOutage, PushOutageError } from "./transport";
import { BranchMovedError, GitCommandError, type GitExec } from "./types";

type PushInput = {
  worktree: string;
  /** The ref that names the pushed commit in `worktree`; `HEAD` when unset. */
  ref?: string;
  url: string;
  branch: string;
  token: string;
  gitExec: GitExec;
  sleep?: (ms: number) => Promise<void>;
};

export async function pushWithLease(
  input: PushInput & { head?: string; expected: string | null },
): Promise<void> {
  const known = await currentRemote(input);
  if (input.head !== undefined && known === input.head) return;
  if (known !== undefined && known !== input.expected)
    throw new BranchMovedError(input.branch, known);
  try {
    await withCredential(
      input.token,
      input.gitExec,
      async (helper) => {
        const args = [...helper.argsPrefix, "push"];
        args.push(`--force-with-lease=refs/heads/${input.branch}:${input.expected ?? ""}`);
        args.push(input.url, `${input.ref ?? "HEAD"}:refs/heads/${input.branch}`);
        await helper.exec(args, { cwd: input.worktree, env: helper.env });
      },
      { sleep: input.sleep },
    );
  } catch (error) {
    if (error instanceof GitCommandError && /\(stale info\)/.test(error.stderr)) {
      const tip = await currentRemote(input);
      if (input.head !== undefined && tip === input.head) return;
      throw new BranchMovedError(input.branch, tip ?? null);
    }
    if (error instanceof PushOutageError) throw error;
    if (error instanceof GitCommandError && isPushOutage(error.stderr))
      throw new PushOutageError(error.args, error.stderr);
    throw error;
  }
}

async function currentRemote(input: PushInput): Promise<string | null | undefined> {
  try {
    return await remoteBranchSha(input);
  } catch (error) {
    journalCaught(
      gitFailureReason(input.token, error),
      "push.currentRemote",
      null,
      "remote branch unread; pushing",
    );
    return undefined;
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
