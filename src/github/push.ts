import { withCredential } from "./git";
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
      if (attempt === 1 && error instanceof GitCommandError && /\(stale info\)/.test(error.stderr))
        continue;
      throw error;
    }
  }
}

async function remoteBranchSha(input: PushInput): Promise<string | null> {
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
