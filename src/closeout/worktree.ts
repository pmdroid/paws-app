import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isSha } from "./parse";

const exec = promisify(execFile);

export async function readHead(worktree: string): Promise<string> {
  const { stdout } = await exec("git", ["rev-parse", "HEAD"], {
    cwd: worktree,
    encoding: "utf8",
  });
  const sha = stdout.trim();
  if (!isSha(sha)) throw new Error(`worktree HEAD is not a commit id`);
  return sha;
}
