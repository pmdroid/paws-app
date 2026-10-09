import { spawn } from "node:child_process";

export class GitError extends Error {
  readonly args: string[];
  readonly code: number | null;
  readonly stderr: string;

  constructor(args: string[], code: number | null, stderr: string) {
    super(`git ${args.join(" ")} failed (${code ?? "signal"}): ${stderr.trim() || "no stderr"}`);
    this.name = "GitError";
    this.args = args;
    this.code = code;
    this.stderr = stderr;
  }
}

export async function git(
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: options?.cwd,
      env: options?.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new GitError(args, code, stderr));
    });
  });
}
