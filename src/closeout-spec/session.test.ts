import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspacePolicyFiles } from "./facade";
import { createCloseoutSession, type CloseoutFocus } from "./session";

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

function lintPolicy(root: string): void {
  write(
    root,
    ".agents/closeout.yaml",
    [
      'specVersion: "0.1"',
      "setup:",
      "  - id: install",
      '    exec: ["sh", "-c", "test ! -e setup-broken"]',
      "    timeoutSeconds: 30",
      "items:",
      "  - id: lint",
      "    kind: command",
      "    gate: beforePR",
      '    exec: ["sh", "-c", "echo lint says no; test ! -e broken"]',
      "    timeoutSeconds: 30",
      check("test"),
    ].join("\n") + "\n",
  );
}

async function attempts(session: ReturnType<typeof createCloseoutSession>, id: string) {
  const report = JSON.parse(await session.report()) as {
    required: { id: string; failed_attempts: number }[];
  };
  return report.required.find((item) => item.id === id)?.failed_attempts;
}

function failingLint() {
  const root = repo();
  lintPolicy(root);
  write(root, "broken", "1\n");
  const session = createCloseoutSession(root, { policy: async () => workspacePolicyFiles(root) });
  return { root, session };
}

test("a check that failed on the unchanged workspace is not run again for another check", async () => {
  const { session } = failingLint();
  expect(await session.run("lint")).toStartWith("lint failed (exit 1).");
  for (let index = 0; index < 3; index += 1) {
    const answer = await session.run("test");
    expect(answer).toStartWith("test not run: fix lint first.\nlint failed (exit 1).");
    expect(answer).toContain("lint says no");
  }
  expect(await attempts(session, "lint")).toBe(1);
  expect(await attempts(session, "test")).toBe(0);
});

test("checks asked for at the same time do not count another failed attempt", async () => {
  const { session } = failingLint();
  await session.run("lint");
  const answers = await Promise.all([session.run("test"), session.run("test")]);
  for (const answer of answers) expect(answer).toStartWith("test not run: fix lint first.");
  expect(await attempts(session, "lint")).toBe(1);
});

test("an edit that changes the fingerprint runs the failed check again", async () => {
  const { root, session } = failingLint();
  await session.run("lint");
  write(root, "broken", "2\n");
  expect(await session.run("test")).toStartWith("test not run: fix lint first.");
  expect(await attempts(session, "lint")).toBe(2);
  rmSync(join(root, "broken"));
  expect(await session.run("test")).toBe("test passed.");
});

test("asking for the failed check itself counts each attempt", async () => {
  const { session } = failingLint();
  for (let index = 0; index < 3; index += 1) await session.run("lint");
  expect(await attempts(session, "lint")).toBe(3);
  expect(await session.run("lint")).toBe(
    "Check lint is exhausted. Stop retrying and report the blocker.",
  );
});

test("a setup check that failed on the unchanged workspace is not run again", async () => {
  const root = repo();
  lintPolicy(root);
  write(root, "setup-broken", "1\n");
  const session = createCloseoutSession(root, { policy: async () => workspacePolicyFiles(root) });
  expect(await session.run("install")).toStartWith("install failed (exit 1).");
  expect(await session.run("test")).toStartWith("test not run: fix install first.\ninstall failed");
  expect(await session.run("lint")).toStartWith("lint not run: fix install first.");
  expect(await attempts(session, "install")).toBe(1);
  write(root, "setup-broken", "2\n");
  expect(await session.run("test")).toStartWith("install failed (exit 1).");
  expect(await attempts(session, "install")).toBe(2);
});

function sincePolicy(root: string): string {
  write(
    root,
    ".agents/closeout.yaml",
    [
      'specVersion: "0.1"',
      "items:",
      "  - id: test",
      "    kind: command",
      "    gate: beforePR",
      '    exec: ["true", "all"]',
      '    since: ["true", "--since", "{since}"]',
      "    timeoutSeconds: 30",
      check("lint"),
    ].join("\n") + "\n",
  );
  const files = workspacePolicyFiles(root);
  if (!files.ok || files.absent) throw new Error("policy did not load");
  return files.digest;
}

async function ranArgv(root: string, focus: CloseoutFocus): Promise<Record<string, string[]>> {
  const ran: string[][] = [];
  const session = createCloseoutSession(root, {
    policy: async () => workspacePolicyFiles(root),
    allowCommand: (argv) => void ran.push([...argv]),
    focus,
  });
  expect(await session.run("test")).toBe("test passed.");
  expect(await session.run("lint")).toBe("lint passed.");
  return { test: ran[0]!, lint: ran[1]! };
}

test("a focus with since runs the listed check's since argv when the digest matches", async () => {
  const root = repo();
  const digest = sincePolicy(root);
  const head = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).stdout.trim();
  const focus = { scope: "failed" as const, head, policyDigest: digest, passed: [] };
  expect(await ranArgv(root, { ...focus, since: ["test", "lint"] })).toEqual({
    test: ["true", "--since", head],
    lint: ["true"],
  });
  expect(await ranArgv(root, { ...focus, policyDigest: "other", since: ["test"] })).toEqual({
    test: ["true", "all"],
    lint: ["true"],
  });
  expect(await ranArgv(root, { ...focus, head: "main", since: ["test"] })).toEqual({
    test: ["true", "all"],
    lint: ["true"],
  });
  expect(await ranArgv(root, focus)).toEqual({ test: ["true", "all"], lint: ["true"] });
});
