import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspacePolicyFiles } from "./facade";
import { createCloseoutSession } from "./session";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Report = { required: { id: string; status: string }[]; pending: string[] };

function git(root: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
}

function write(root: string, path: string, text: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
}

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "paws-session-paths-"));
  roots.push(root);
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  write(root, "package.json", "{}\n");
  write(root, "services/a/main.ts", "a\n");
  write(root, "services/b/main.ts", "b\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "init"]);
  git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  return root;
}

function policy(root: string, extra: string[] = []): void {
  write(
    root,
    ".agents/closeout.yaml",
    [
      'specVersion: "0.1"',
      "setup:",
      "  - id: install",
      '    exec: ["true"]',
      "    timeoutSeconds: 30",
      '    paths: ["bun.lock", "package.json"]',
      "items:",
      check("a-test", "services/a/**"),
      check("b-test", "services/b/**"),
      check("all"),
      ...extra,
    ].join("\n") + "\n",
  );
}

function check(id: string, pattern?: string): string {
  return [
    `  - id: ${id}`,
    "    kind: command",
    "    gate: beforePR",
    '    exec: ["true"]',
    "    timeoutSeconds: 30",
    ...(pattern === undefined ? [] : [`    paths: [${JSON.stringify(pattern)}]`]),
  ].join("\n");
}

async function statuses(session: ReturnType<typeof createCloseoutSession>) {
  const report = JSON.parse(await session.report()) as Report;
  return Object.fromEntries(report.required.map((item) => [item.id, item.status]));
}

async function passedSession(root: string) {
  const session = createCloseoutSession(root, { policy: async () => workspacePolicyFiles(root) });
  write(root, "package.json", '{"name":"x"}\n');
  write(root, "services/a/main.ts", "a1\n");
  write(root, "services/b/main.ts", "b1\n");
  for (const id of ["install", "a-test", "b-test", "all"]) {
    expect(await session.run(id)).toBe(`${id} passed.`);
  }
  expect(await statuses(session)).toEqual({
    install: "passed",
    "a-test": "passed",
    "b-test": "passed",
    all: "passed",
  });
  return session;
}

test("an edit keeps a passed check whose paths cover none of the edited files", async () => {
  const root = repo();
  policy(root);
  const session = await passedSession(root);

  write(root, "services/b/main.ts", "b2\n");
  expect(await statuses(session)).toEqual({
    install: "passed",
    "a-test": "passed",
    "b-test": "stale",
    all: "stale",
  });

  write(root, "services/a/main.ts", "a2\n");
  expect((await statuses(session))["a-test"]).toBe("stale");
});

test("a commit that keeps the covered files keeps the check passed", async () => {
  const root = repo();
  policy(root);
  const session = await passedSession(root);

  git(root, ["add", "."]);
  git(root, ["commit", "-m", "work"]);
  expect(await statuses(session)).toEqual({
    install: "passed",
    "a-test": "passed",
    "b-test": "passed",
    all: "stale",
  });
});

test("install goes stale when package.json changes", async () => {
  const root = repo();
  policy(root);
  const session = await passedSession(root);

  write(root, "package.json", '{"name":"y"}\n');
  expect(await statuses(session)).toEqual({
    install: "stale",
    "a-test": "passed",
    "b-test": "passed",
    all: "stale",
  });
});

test("a new policy digest makes every check stale", async () => {
  const root = repo();
  policy(root);
  const session = await passedSession(root);

  policy(root, [check("docs", "docs/**")]);
  expect(await statuses(session)).toEqual({
    install: "stale",
    "a-test": "stale",
    "b-test": "stale",
    all: "stale",
  });
});

test("reverting an edit to the passed content leaves the check passed", async () => {
  const root = repo();
  policy(root);
  const session = await passedSession(root);

  write(root, "services/a/main.ts", "a2\n");
  expect((await statuses(session))["a-test"]).toBe("stale");
  write(root, "services/a/main.ts", "a1\n");
  expect((await statuses(session))["a-test"]).toBe("passed");
});

test("deleting a covered file makes the check stale", async () => {
  const root = repo();
  policy(root);
  const session = await passedSession(root);

  rmSync(join(root, "services/a/main.ts"));
  const now = await statuses(session);
  expect(now["a-test"]).toBe("stale");
  expect(now["b-test"]).toBe("passed");
});
