import { git } from "../run/exec";
import type { TestChange } from "./types";

export async function testChanges(
  cwd: string,
  base: string,
  head: string,
  env: Record<string, string>,
): Promise<TestChange[]> {
  const diff = await git(cwd, ["diff", "-M", "--name-status", "-z", base, head, "--"], env);
  if (!diff.ok) throw new Error(`git diff ${base} ${head} failed`);
  const parts = diff.stdout.toString("utf8").split("\0");
  const changes: TestChange[] = [];
  for (let index = 0; index < parts.length;) {
    const status = parts[index++];
    if (!status) continue;
    if (status.startsWith("R") || status.startsWith("C")) {
      changes.push({ status, oldPath: parts[index++]!, path: parts[index++]! });
    } else {
      changes.push({ status, path: parts[index++]! });
    }
  }
  return changes;
}

export async function readAt(
  cwd: string,
  commit: string,
  path: string,
  env: Record<string, string>,
): Promise<string | undefined> {
  const shown = await git(cwd, ["show", `${commit}:${path}`], env);
  return shown.ok ? shown.stdout.toString("utf8") : undefined;
}
