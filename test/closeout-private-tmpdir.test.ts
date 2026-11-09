import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, test } from "bun:test";
import {
  createCloseoutSession,
  workspacePolicyFiles,
  type CloseoutSessionEvent,
} from "../src/closeout-spec";
import { createCommandRunner } from "../src/closeout-spec/run";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const SHOW_TEMP = 'printf "%s\\n" "$TMPDIR" "$TMP" "$TEMP"; test -d "$TMPDIR"';

test("each command check runs with its own temp folder, removed after the run", async () => {
  const root = initRepo();
  writePolicy(root, [
    command("first", ["bash", "-c", SHOW_TEMP]),
    command("second", ["bash", "-c", SHOW_TEMP]),
  ]);
  const events: CloseoutSessionEvent[] = [];
  const session = createCloseoutSession(root, {
    policy: async () => workspacePolicyFiles(root),
    onProgress: (event) => events.push(event),
  });
  await session.report();
  expect(await session.run("first")).toBe("first passed.");
  expect(await session.run("second")).toBe("second passed.");
  const temps = events.flatMap((event) =>
    event.type === "finished" ? [event.stdout.trimEnd().split("\n")] : [],
  );
  expect(temps).toHaveLength(2);
  const parent = process.env.TMPDIR || tmpdir();
  for (const [own, tmp, temp] of temps) {
    expect(own).not.toBe(parent);
    expect(own!.startsWith(join(parent, "paws-check-"))).toBe(true);
    expect(tmp).toBe(own);
    expect(temp).toBe(own);
    expect(existsSync(own!)).toBe(false);
  }
  expect(temps[0]![0]).not.toBe(temps[1]![0]);
});

test("the gate's command runner gives each check its own temp folder too", async () => {
  const root = initRepo();
  const logFile = join(root, "..", `${root.split("/").pop()}.log`);
  roots.push(logFile);
  const runner = createCommandRunner();
  await runner.runLogged({
    cwd: root,
    argv: ["bash", "-c", SHOW_TEMP],
    timeoutSeconds: 30,
    logFile,
    artifactPath: "check.log",
    expectedHead: git(root, ["rev-parse", "HEAD"]),
  });
  const [own, tmp, temp] = readFileSync(logFile, "utf8").split("\n").slice(1, 4);
  expect(own!.startsWith(join(process.env.TMPDIR || tmpdir(), "paws-check-"))).toBe(true);
  expect(tmp).toBe(own);
  expect(temp).toBe(own);
  expect(existsSync(own!)).toBe(false);
});

function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "paws-private-tmp-"));
  roots.push(root);
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  writeFileSync(join(root, "README.md"), "acme monorepo\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "init"]);
  git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  return root;
}

function writePolicy(root: string, items: string[]): void {
  mkdirSync(join(root, ".agents"), { recursive: true });
  writeFileSync(
    join(root, ".agents", "closeout.yaml"),
    ['specVersion: "0.1"', "items:", ...items, ""].join("\n"),
  );
}

function command(id: string, exec: string[]): string {
  return `  - id: ${id}\n    kind: command\n    gate: beforePR\n    exec: ${JSON.stringify(exec)}\n    timeoutSeconds: 30`;
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
