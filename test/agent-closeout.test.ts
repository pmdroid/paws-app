import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runAgent } from "../src/acp";
import type { FakeScript } from "../src/acp/testing/script";
import {
  beginImplementRun,
  insertQueuedItem,
  listAgentCloseout,
  recordAgentCloseout,
} from "../src/db";
import { tempHome } from "./helpers";
import { tempStore } from "./pglite";

const openStores: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of openStores.splice(0)) await close();
});

async function openStore() {
  const { db, close } = await tempStore();
  openStores.push(close);
  return db;
}

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const TOKEN = `ghp_${"x".repeat(36)}`;

test("the agent's get_closeout, failed run_closeout, fix and passing run_closeout are recorded in order", async () => {
  const home = tempHome();
  homes.push(home);
  const workspace = join(home, "workspace");
  mkdirSync(join(workspace, ".agents"), { recursive: true });
  mkdirSync(join(workspace, "src"));
  git(workspace, ["init", "-b", "main"]);
  git(workspace, ["config", "user.email", "test@example.com"]);
  git(workspace, ["config", "user.name", "Test"]);
  mkdirSync(join(workspace, "scripts"));
  writeFileSync(
    join(workspace, "scripts", "verify.js"),
    `const text = require("node:fs").readFileSync("src/main.ts", "utf8");
console.log("checking main.ts ${TOKEN}");
if (!text.includes("fixed")) {
  console.error("expected fixed, received broken");
  process.exit(1);
}
`,
  );
  writeFileSync(
    join(workspace, ".agents", "closeout.yaml"),
    [
      'specVersion: "0.1"',
      "retry:",
      "  maxFailedAttemptsPerItem: 3",
      "  scope: task",
      "setup:",
      "  - id: install",
      `    exec: ["bun", "--version"]`,
      "    timeoutSeconds: 30",
      "items:",
      "  - id: test",
      "    kind: command",
      "    gate: beforePR",
      `    exec: ["bun", "scripts/verify.js"]`,
      "    timeoutSeconds: 30",
      "",
    ].join("\n"),
  );
  writeFileSync(join(workspace, "README.md"), "hello\n");
  git(workspace, ["add", "."]);
  git(workspace, ["commit", "-m", "init"]);
  git(workspace, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

  const db = await openStore();
  await insertQueuedItem(db, { id: "ENG-7", title: "Escape quotes", now: 1 });
  const { run } = await beginImplementRun(db, "ENG-7", 2);
  const main = join(workspace, "src", "main.ts");
  const steps: FakeScript["steps"] = [
    { type: "fs_write", path: main, content: "export const state = 'broken';\n" },
    { type: "get_closeout" },
    { type: "run_closeout", id: "test" },
    { type: "fs_write", path: main, content: "export const state = 'fixed';\n" },
    { type: "run_closeout", id: "test" },
    { type: "get_closeout" },
    { type: "end" },
  ];
  const script = join(home, "script.json");
  const trace = join(home, "trace.json");
  writeFileSync(script, JSON.stringify({ steps }));
  let clock = 1_000;
  await runAgent({
    role: "implementer",
    itemId: "ENG-7",
    runId: run.id,
    prompt: "Fix the quotes.",
    worktreePath: workspace,
    pawsRoot: home,
    home,
    checkpoint: false,
    command: process.execPath,
    args: [resolve(import.meta.dir, "../src/acp/testing/fake-agent.ts"), trace, script],
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
    postUpdate: { post: async () => ({ posted: true }) },
    closeoutProgress: {
      async record(progress) {
        clock += 1_000;
        await recordAgentCloseout(db, run.id, "ENG-7", progress, clock);
      },
    },
  });
  const recorded = JSON.parse(readFileSync(trace, "utf8")) as { closeouts: string[] };
  expect(recorded.closeouts).toHaveLength(4);
  expect(recorded.closeouts[1]).toStartWith("test failed (exit 1).");
  expect(recorded.closeouts[2]).toBe("test passed.");
  expect((await listAgentCloseout(db, [run.id])).map((event) => event.sequence)).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8,
  ]);
}, 30_000);

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
