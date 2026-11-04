import { gitEnv } from "./git";

export async function patchIds(worktree: string, range: string): Promise<string[]> {
  const env = gitEnv();
  const log = Bun.spawn(
    ["git", "log", "-p", "--no-merges", "--reverse", "--no-color", "--format=commit %H", range],
    { cwd: worktree, env, stdout: "pipe", stderr: "pipe" },
  );
  const ids = Bun.spawn(["git", "patch-id", "--stable"], {
    cwd: worktree,
    env,
    stdin: log.stdout,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [listed, logCode, idCode, logError] = await Promise.all([
    new Response(ids.stdout).text(),
    log.exited,
    ids.exited,
    new Response(log.stderr).text(),
  ]);
  if (logCode !== 0 || idCode !== 0)
    throw new Error(`patch-id over ${range} failed: ${logError.trim()}`);
  return listed
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(" ")[0]!);
}
