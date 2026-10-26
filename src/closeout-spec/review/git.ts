import { journalCaught } from "../../journal";
export type GitResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

/** Local git only. Callers pass commit ids as argv, never through a shell. */
export async function gitRun(cwd: string, args: string[]): Promise<GitResult> {
  let proc: Bun.Subprocess;
  try {
    proc = Bun.spawn(["git", "--no-pager", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_PAGER: "cat",
        GIT_ALLOW_PROTOCOL: "file",
      },
    });
  } catch (error) {
    journalCaught(error, "git.gitRun.spawn", null);
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: "", stderr: message };
  }
  const stdoutStream = proc.stdout;
  const stderrStream = proc.stderr;
  if (typeof stdoutStream === "number" || typeof stderrStream === "number") {
    return { exitCode: 1, stdout: "", stderr: "git pipes were not captured" };
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(stdoutStream).text(),
    new Response(stderrStream).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

export async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const result = await gitRun(cwd, args);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(detail || `git exited ${result.exitCode}`);
  }
  return result.stdout;
}
