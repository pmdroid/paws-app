import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCloseoutSession, workspacePolicyFiles } from "../src/closeout-spec";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("eight run_closeout calls issued together take about the slowest; setup runs once", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-closeout-parallel-"));
  roots.push(root);
  const repo = join(root, "repo");
  const ran = join(root, "ran");
  mkdirSync(repo);
  git(repo, ["init", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "acme\n");
  commit(repo);
  git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  const ids = Array.from({ length: 8 }, (_, index) => `check-${index}`);
  const step = (id: string, seconds: number) =>
    JSON.stringify(["sh", "-c", `sleep ${seconds}; echo ${id} >> ${ran}`]);
  mkdirSync(join(repo, ".agents"));
  writeFileSync(
    join(repo, ".agents", "closeout.yaml"),
    [
      'specVersion: "0.1"',
      "setup:",
      "  - id: install",
      `    exec: ${step("install", 0.3)}`,
      "    timeoutSeconds: 30",
      "items:",
      ...ids.flatMap((id, index) => [
        `  - id: ${id}`,
        "    kind: command",
        "    gate: beforePR",
        `    exec: ${step(id, index === 7 ? 1 : 0.5)}`,
        "    timeoutSeconds: 30",
      ]),
      "",
    ].join("\n"),
  );
  writeFileSync(join(repo, "widget.ts"), "export const acme = 1;\n");
  commit(repo);
  const session = createCloseoutSession(repo, { policy: async () => workspacePolicyFiles(repo) });
  await session.report();

  const started = Date.now();
  const answers = await Promise.all(ids.map((id) => session.run(id)));
  const elapsed = Date.now() - started;

  expect(answers).toEqual(ids.map((id) => `${id} passed.`));
  const lines = readFileSync(ran, "utf8").trim().split("\n");
  expect(lines.filter((line) => line === "install")).toHaveLength(1);
  expect(lines[0]).toBe("install");
  expect(lines.toSorted()).toEqual(["install", ...ids].toSorted());
  expect(elapsed).toBeLessThan(3_000);
  expect(JSON.parse(await session.report()).pending).toEqual([]);
}, 30_000);

function commit(repo: string): void {
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "user.name=Acme", "-c", "user.email=dev@acme.test", "commit", "-qm", "acme"]);
}

function git(repo: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
}
