import { git } from "../run/exec";
import { SKIPPED } from "./graph";
import type { Snapshot, TestChange } from "./types";

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
    const oldPath = /^[RC]/.test(status) ? parts[index++]! : undefined;
    changes.push({ status, path: parts[index++]!, ...(oldPath ? { oldPath } : {}) });
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

const READ = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|json|toml)$/;
const SNAPSHOT_TIMEOUT_MS = 120_000;

async function gitBytes(
  cwd: string,
  args: string[],
  env: Record<string, string>,
  input?: string,
): Promise<Buffer> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env: { ...env, GIT_TERMINAL_PROMPT: "0" },
    stdin: input === undefined ? "ignore" : Buffer.from(input),
    stdout: "pipe",
    stderr: "ignore",
    timeout: SNAPSHOT_TIMEOUT_MS,
  });
  const [stdout, code] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args[0]} failed`);
  return Buffer.from(stdout);
}

export async function snapshotAt(
  cwd: string,
  commit: string,
  env: Record<string, string>,
  read = READ,
): Promise<Snapshot> {
  const tree = await gitBytes(cwd, ["ls-tree", "-r", "-z", "--full-tree", commit], env);
  const paths = new Set<string>();
  const wanted: { oid: string; path: string }[] = [];
  for (const entry of tree.toString("utf8").split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, oid] = entry.slice(0, tab).split(" ");
    const path = entry.slice(tab + 1);
    if (type !== "blob") continue;
    paths.add(path);
    if (mode !== "120000" && oid && read.test(path) && !SKIPPED.test(path)) {
      wanted.push({ oid, path });
    }
  }
  const texts = new Map<string, string>();
  if (wanted.length > 0) {
    const input = wanted.map((entry) => entry.oid).join("\n") + "\n";
    const out = await gitBytes(cwd, ["cat-file", "--batch"], env, input);
    let offset = 0;
    for (const { path } of wanted) {
      const newline = out.indexOf(10, offset);
      if (newline < 0) throw new Error("git cat-file output ended early");
      const size = Number(out.subarray(offset, newline).toString("utf8").split(" ")[2]);
      if (!Number.isInteger(size)) throw new Error(`git cat-file could not read ${path}`);
      texts.set(path, out.subarray(newline + 1, newline + 1 + size).toString("utf8"));
      offset = newline + 1 + size + 1;
    }
  }
  return { paths, read: (path) => texts.get(path) };
}
