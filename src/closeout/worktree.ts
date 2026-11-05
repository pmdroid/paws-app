import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function isSha(value: unknown): value is string {
  return typeof value === "string" && SHA.test(value);
}

export async function readHead(worktree: string): Promise<string> {
  const { stdout } = await exec("git", ["rev-parse", "HEAD"], {
    cwd: worktree,
    encoding: "utf8",
  });
  const sha = stdout.trim();
  if (!isSha(sha)) throw new Error("worktree HEAD is not a commit id");
  return sha;
}

export async function readRef(mirror: string, ref: string): Promise<string> {
  const { stdout } = await exec(
    "git",
    ["--git-dir", mirror, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
    { encoding: "utf8" },
  );
  const sha = stdout.trim();
  if (!isSha(sha)) throw new Error(`${ref} is not a commit id`);
  return sha;
}
