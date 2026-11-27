import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotAt, testChanges } from "./git";
import { bunTestAdapter, type TestPlan } from "./index";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ALWAYS = ["test/boundaries.test.ts", "test/empty-catches.test.ts"];
const OPAQUE = "test/opaque.test.ts";

const TREE: Record<string, string> = {
  "package.json": '{"name":"fixture"}',
  "bunfig.toml": '[test]\npreload = ["./test/temp-root.ts"]\n',
  "test/temp-root.ts": "export {};\n",
  "README.md": "# Fixture\n",
  "docs/guide.md": "Guide\n",
  "scripts/tool.ts": "export const tool = 1;\n",
  "src/index.ts": 'import "./loop";\nimport "./db";\n',
  "src/index.test.ts": 'import "./index";\n',
  "src/db/index.ts": 'export * from "./store";\n',
  "src/db/store.ts": "export const store = 1;\n",
  "src/db/store.test.ts": 'import { store } from "./store";\nstore;\n',
  "src/loop/index.ts": 'export * from "./turn";\nexport * from "./legacy";\nimport "../db";\n',
  "src/loop/turn.ts": 'import { name } from "./name";\nexport const turn = name;\n',
  "src/loop/name.ts": 'export const name = "the name of the turn in this fixture";\n',
  "src/loop/legacy.ts": "export const legacy = 1;\n",
  "src/loop/turn.test.ts": 'import { turn } from "./turn";\nturn;\n',
  "src/loop/loop.test.ts": 'import "./index";\n',
  "test/pglite-fixtures.ts": 'import "../src/db";\nexport const fixture = 1;\n',
  "test/alerts.test.ts": 'import "./pglite-fixtures";\n',
  "test/jobs.test.ts": 'import "./pglite-fixtures";\n',
  "test/outbox.test.ts": 'import "./pglite-fixtures";\n',
  "test/startup.test.ts": 'import "../src/index";\n',
  "test/boundaries.test.ts": "export {};\n",
  "test/empty-catches.test.ts": "export {};\n",
  [OPAQUE]: "await import(`../src/${process.env.X}`);\n",
};

function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function write(root: string, files: Record<string, string | null>): void {
  for (const [path, text] of Object.entries(files)) {
    if (text === null) rmSync(join(root, path));
    else {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    }
  }
  git(root, "add", "-A");
  git(root, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-qm", "c");
}

async function plans(edits: Record<string, string | null>): Promise<TestPlan[]> {
  const root = mkdtempSync(join(tmpdir(), "paws-worst-cases-"));
  roots.push(root);
  git(root, "init", "-qb", "main");
  write(root, TREE);
  const base = git(root, "rev-parse", "HEAD");
  write(root, edits);
  const head = git(root, "rev-parse", "HEAD");
  const env = { PATH: process.env.PATH ?? "" };
  return Promise.all(
    [120, 1].map((max_selected) =>
      bunTestAdapter.plan({
        item: {
          id: "test",
          kind: "command",
          gate: "beforePR",
          exec: ["bun", "test"],
          timeoutSeconds: 60,
          paths: ["**"],
          except: ["**/*.md", "docs/**"],
          select: {
            runner: "bun",
            always: ALWAYS,
            full_on: ["package.json", "bunfig.toml", "**/tsconfig*.json", "scripts/**"],
            max_selected,
            over_max: "direct",
          },
        },
        cwd: root,
        base,
        head,
        reportDir: "/r",
        env,
        deadline: Date.now() + 60_000,
        changes: () => testChanges(root, base, head, env),
        readAtBase: async () => undefined,
        readAtHead: async () => undefined,
        snapshot: (at) => snapshotAt(root, at, env),
      }),
    ),
  );
}

function selected(plan: TestPlan | undefined): string[] {
  expect(plan?.selection.mode).toBe("selected");
  return plan?.selection.mode === "selected" ? plan.selection.targets : [];
}

const runs = (...tests: string[]) => [...tests, ...ALWAYS, OPAQUE].sort();

const CASES: [string, Record<string, string | null>, string[], string[]][] = [
  [
    "the root src/index.ts selects its importers, not every test under src/",
    { "src/index.ts": 'import "./loop";\nimport "./db";\nexport {};\n' },
    runs("src/index.test.ts", "test/startup.test.ts"),
    runs("src/index.test.ts", "test/startup.test.ts"),
  ],
  [
    "a root-level test helper selects the tests that import it, not every test under test/",
    { "test/pglite-fixtures.ts": 'import "../src/db";\nexport const fixture = 2;\n' },
    runs("test/alerts.test.ts", "test/jobs.test.ts", "test/outbox.test.ts"),
    runs("test/alerts.test.ts", "test/jobs.test.ts", "test/outbox.test.ts"),
  ],
  [
    "a high-fanout module selects every test that reaches it, or only its direct test",
    { "src/db/store.ts": "export const store = 2;\n" },
    runs(
      "src/db/store.test.ts",
      "src/index.test.ts",
      "src/loop/loop.test.ts",
      "test/alerts.test.ts",
      "test/jobs.test.ts",
      "test/outbox.test.ts",
      "test/startup.test.ts",
    ),
    runs("src/db/store.test.ts"),
  ],
  [
    "a changed opaque test runs, and so do the always tests",
    { [OPAQUE]: "await import(`../src/${process.env.Y}`);\n" },
    runs(),
    runs(),
  ],
  [
    "a deleted file selects the tests that reached it at base and still exist",
    {
      "src/loop/legacy.ts": null,
      "src/loop/index.ts": 'export * from "./turn";\nimport "../db";\n',
    },
    runs("src/index.test.ts", "src/loop/loop.test.ts", "test/startup.test.ts"),
    runs("src/loop/loop.test.ts"),
  ],
  [
    "a renamed file selects the tests that reach the old or the new path",
    {
      "src/loop/name.ts": null,
      "src/loop/title.ts": TREE["src/loop/name.ts"]!,
      "src/loop/turn.ts": 'import { name } from "./title";\nexport const turn = name;\n',
    },
    runs(
      "src/index.test.ts",
      "src/loop/loop.test.ts",
      "src/loop/turn.test.ts",
      "test/startup.test.ts",
    ),
    runs("src/loop/turn.test.ts"),
  ],
  [
    "a docs-only change runs only the always and opaque tests",
    { "README.md": "# Changed\n", "docs/guide.md": "Changed\n" },
    runs(),
    runs(),
  ],
];

for (const [name, edits, proven, direct] of CASES) {
  test(name, async () => {
    const [atMax, overMax] = await plans(edits);
    expect(selected(atMax)).toEqual(proven);
    expect(selected(overMax)).toEqual(direct);
  });
}

test("a full_on match runs the full suite on the proven and the direct path", async () => {
  for (const plan of await plans({ "scripts/tool.ts": "export const tool = 2;\n" })) {
    expect(plan.selection.mode).toBe("full");
    expect(plan.selection.reasons[0]).toBe("scripts/tool.ts matches select.full_on");
  }
});
