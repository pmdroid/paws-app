import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLocalPolicy } from "../src/closeout-spec/policy/load";
import { bunTestAdapter, type TestAdapter, type TestPlan } from "../src/closeout-spec/tests";
import { snapshotAt, testChanges } from "../src/closeout-spec/tests/git";
import { testFilesOf } from "../src/closeout-spec/tests/graph";
import type { SelectedCommand, Snapshot } from "../src/closeout-spec/tests/types";

const GROWTH = 3;

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function option(args: string[], name: string, fallback: string): string {
  const found = args.find((arg) => arg.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
}

function selectedCount(plan: TestPlan, head: Snapshot): number {
  return plan.selection.mode === "selected"
    ? plan.selection.targets.length
    : testFilesOf(head).length;
}

function grewTooMuch(current: number, main: number): boolean {
  return current > GROWTH * Math.max(main, 1);
}

async function mainAdapter(
  root: string,
  ref: string,
): Promise<{ adapter: TestAdapter; done(): void }> {
  const dir = mkdtempSync(join(tmpdir(), "paws-replay-main-"));
  git(root, "worktree", "add", "--detach", dir, ref);
  symlinkSync(join(root, "node_modules"), join(dir, "node_modules"));
  const done = () => {
    git(root, "worktree", "remove", "--force", dir);
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const module = (await import(join(dir, "src/closeout-spec/tests/index.ts"))) as {
      bunTestAdapter: TestAdapter;
    };
    return { adapter: module.bunTestAdapter, done };
  } catch (error) {
    done();
    throw error;
  }
}

async function replay(args: string[]): Promise<number> {
  const root = process.cwd();
  const count = Number(option(args, "count", "20"));
  const mainRef = option(args, "main", "origin/main");
  const outcome = loadLocalPolicy(root);
  if (!outcome.ok || outcome.policy.source === "absent") throw new Error("cannot load the policy");
  const item = outcome.policy.items.find(
    (entry): entry is SelectedCommand => entry.kind === "command" && "select" in entry,
  );
  if (!item) throw new Error("the policy has no command with select");
  const env = { PATH: process.env.PATH ?? "" };
  const snapshots = new Map<string, Promise<Snapshot>>();
  const snapshot = (commit: string) => {
    if (!snapshots.has(commit)) snapshots.set(commit, snapshotAt(root, commit, env));
    return snapshots.get(commit)!;
  };
  const plan = (adapter: TestAdapter, base: string, head: string) =>
    adapter.plan({
      item,
      cwd: root,
      base,
      head,
      reportDir: "/replay",
      env,
      deadline: Date.now() + 600_000,
      changes: () => testChanges(root, base, head, env),
      readAtBase: async () => undefined,
      readAtHead: async () => undefined,
      snapshot,
    });
  const commits = git(root, "log", "--first-parent", "--format=%H", "-n", String(count), mainRef)
    .split("\n")
    .filter(Boolean);
  const main = await mainAdapter(root, mainRef);
  const failures: string[] = [];
  try {
    for (const commit of commits) {
      const base = git(root, "rev-parse", `${commit}^`);
      const headSnapshot = await snapshot(commit);
      const current = await plan(bunTestAdapter, base, commit);
      const before = await plan(main.adapter, base, commit);
      const [now, was] = [current, before].map((entry) => selectedCount(entry, headSnapshot));
      const subject = git(root, "log", "-1", "--format=%s", commit);
      console.log(`${commit.slice(0, 10)} ${subject}`);
      console.log(
        `  ${current.selection.mode}, ${now} test files (main's selector: ${before.selection.mode}, ${was})`,
      );
      for (const reason of current.selection.reasons.slice(0, 10)) console.log(`  - ${reason}`);
      if (current.selection.reasons.length > 10)
        console.log(`  - and ${current.selection.reasons.length - 10} more reasons`);
      if (grewTooMuch(now!, was!))
        failures.push(`${commit.slice(0, 10)}: ${now} test files, main's selector picks ${was}`);
    }
  } finally {
    main.done();
  }
  for (const failure of failures) console.error(`selection grew more than ${GROWTH}x: ${failure}`);
  return failures.length > 0 ? 1 : 0;
}

if (import.meta.main) process.exit(await replay(process.argv.slice(2)));
