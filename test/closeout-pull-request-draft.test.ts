import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, test } from "bun:test";
import {
  createCloseoutSession,
  workspacePolicyFiles,
  type CloseoutSessionEvent,
  type PullRequestDraft,
} from "../src/closeout-spec";
import { createCommandRunner } from "../src/closeout-spec/run";
import { turnPasses } from "../src/loop/turn-passes";
import type { AgentCloseoutEvent } from "../src/db";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const SHOW_DRAFT =
  'printf "%s\\n" "$PAWS_PR_TITLE" "$(stat -c %a "$PAWS_PR_BODY_FILE")" "$PAWS_PR_BODY_FILE"; cat "$PAWS_PR_BODY_FILE"';

const DOCS_EXAMPLE = [
  "bash",
  "-c",
  'test -n "$PAWS_PR_TITLE" && .github/scripts/pr-title-type.sh "$PAWS_PR_TITLE" >/dev/null',
];

test("a command check reads the saved title and a 0600 body file that is gone after the run", async () => {
  const root = initRepo();
  writePolicy(root, [command("pr-draft", ["bash", "-c", SHOW_DRAFT])]);
  const draft = {
    title: "feat(acme): add the widget",
    body: "Adds the widget.\n\nTested with bun test.",
  };
  const events: CloseoutSessionEvent[] = [];
  const session = createCloseoutSession(root, {
    policy: async () => workspacePolicyFiles(root),
    pullRequest: async () => draft,
    onProgress: (event) => events.push(event),
  });
  await session.report();
  expect(await session.run("pr-draft")).toBe("pr-draft passed.");
  const finished = events.find((event) => event.type === "finished");
  const [title, mode, file, ...body] = (finished?.type === "finished" ? finished.stdout : "")
    .trimEnd()
    .split("\n");
  expect(title).toBe(draft.title);
  expect(mode).toBe("600");
  expect(file?.startsWith(root)).toBe(false);
  expect(body.join("\n")).toBe(draft.body);
  expect(existsSync(file!)).toBe(false);
});

test("the gate's command runner passes the draft the same way", async () => {
  const root = initRepo();
  const logFile = join(root, "..", `${root.split("/").pop()}.log`);
  roots.push(logFile);
  const head = git(root, ["rev-parse", "HEAD"]);
  const ran = await createCommandRunner().runLogged({
    cwd: root,
    argv: ["bash", "-c", SHOW_DRAFT],
    timeoutSeconds: 30,
    logFile,
    artifactPath: "pr-draft.log",
    expectedHead: head,
    pullRequest: { title: "fix: a bug", body: "Fixes it." },
  });
  expect(ran.exitCode).toBe(0);
  expect(ran.dirty).toBe(false);
  const log = await Bun.file(logFile).text();
  expect(log).toContain("fix: a bug\n600\n");
  expect(log).toContain("Fixes it.");
  expect(existsSync(log.split("\n")[3]!)).toBe(false);
});

test("without a saved draft neither variable is set", async () => {
  const root = initRepo();
  writePolicy(root, [
    command("no-draft", ["bash", "-c", 'test -z "${PAWS_PR_TITLE+x}${PAWS_PR_BODY_FILE+x}"']),
  ]);
  const inherited = { title: process.env.PAWS_PR_TITLE, body: process.env.PAWS_PR_BODY_FILE };
  delete process.env.PAWS_PR_TITLE;
  delete process.env.PAWS_PR_BODY_FILE;
  try {
    const session = createCloseoutSession(root, {
      policy: async () => workspacePolicyFiles(root),
    });
    await session.report();
    expect(await session.run("no-draft")).toBe("no-draft passed.");
  } finally {
    if (inherited.title !== undefined) process.env.PAWS_PR_TITLE = inherited.title;
    if (inherited.body !== undefined) process.env.PAWS_PR_BODY_FILE = inherited.body;
  }
});

test("a new title makes the checks that name PAWS_PR_TITLE pending; others keep their result", async () => {
  const root = initRepo();
  writePolicy(root, [
    command("pr-title", ["bash", "-c", 'test -n "$PAWS_PR_TITLE"']),
    command("unit", ["true"]),
  ]);
  let draft: PullRequestDraft | undefined = { title: "feat: one", body: "First." };
  const session = createCloseoutSession(root, {
    policy: async () => workspacePolicyFiles(root),
    pullRequest: async () => draft,
  });
  await session.report();
  expect(await session.run("pr-title")).toBe("pr-title passed.");
  expect(await session.run("unit")).toBe("unit passed.");
  expect(statuses(await session.report())).toEqual({ "pr-title": "passed", unit: "passed" });

  draft = { title: "feat: two", body: "First." };
  const recorded = await session.recorded();
  expect(statuses(recorded!)).toEqual({ "pr-title": "stale", unit: "passed" });
  const report = JSON.parse(await session.report()) as { pending: string[] };
  expect(report.pending).toEqual(["pr-title"]);
  expect(await session.run("pr-title")).toBe("pr-title passed.");
  expect(statuses(await session.report())).toEqual({ "pr-title": "passed", unit: "passed" });
});

test("the docs example passes a good title and fails a bad one with the script's output", async () => {
  const root = initRepo();
  const script = join(root, ".github", "scripts", "pr-title-type.sh");
  mkdirSync(join(root, ".github", "scripts"), { recursive: true });
  writeFileSync(
    script,
    [
      "#!/usr/bin/env bash",
      'if [[ "$1" =~ ^(feat|fix|docs|chore)(\\([a-z-]+\\))?:\\ .+ ]]; then echo ok; exit 0; fi',
      'echo "PR title must start with a type such as feat: or fix:, got: $1" >&2',
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(script, 0o755);
  git(root, ["add", ".github"]);
  git(root, ["commit", "-m", "title script"]);
  writePolicy(root, [command("pr-title", DOCS_EXAMPLE)]);
  let draft: PullRequestDraft | undefined = { title: "feat(acme): add the widget", body: "Body." };
  const session = createCloseoutSession(root, {
    policy: async () => workspacePolicyFiles(root),
    pullRequest: async () => draft,
  });
  await session.report();
  expect(await session.run("pr-title")).toBe("pr-title passed.");

  draft = { title: "Add the widget", body: "Body." };
  await session.report();
  const failed = await session.run("pr-title");
  expect(failed).toContain("pr-title failed");
  expect(failed).toContain(
    "PR title must start with a type such as feat: or fix:, got: Add the widget",
  );
});

test("a turn pass of a draft check from before the draft was saved is not reused", () => {
  const finished = (id: string, argv: string, at: number): AgentCloseoutEvent =>
    ({
      at,
      progress: {
        type: "finished",
        id,
        kind: "command",
        command: argv,
        head: "a".repeat(40),
        base: "b".repeat(40),
        policyDigest: "sha256:x",
        attempt: 1,
        maxAttempts: 3,
        state: "passed",
        exitCode: 0,
        timedOut: false,
        durationMs: 5,
        stdout: "",
        stderr: "",
        truncated: false,
        clean: true,
      },
    }) as AgentCloseoutEvent;
  const events = [
    finished("pr-title", DOCS_EXAMPLE.join(" "), 100),
    finished("unit", "bun test", 100),
  ];
  expect(turnPasses(events, 200).map((pass) => pass.id)).toEqual(["unit"]);
  expect(turnPasses(events, 50).map((pass) => pass.id)).toEqual(["pr-title", "unit"]);
  expect(turnPasses(events).map((pass) => pass.id)).toEqual(["pr-title", "unit"]);
});

test("a new title probes the rules again instead of reusing the result for the old title", async () => {
  const root = initRepo();
  mkdirSync(join(root, ".agents", "probes"), { recursive: true });
  writeFileSync(
    join(root, ".agents", "probes", "title.ts"),
    'process.exit(process.env.PAWS_PR_TITLE?.startsWith("feat") ? 0 : 1);\n',
  );
  writePolicy(
    root,
    [command("unit", ["true"])],
    [
      "rules:",
      "  - id: pr-title",
      "    summary: The title starts with a type.",
      "    probe: .agents/probes/title.ts",
      "    failOn: P1",
      "",
    ],
  );
  let draft: PullRequestDraft | undefined = { title: "Add the widget", body: "Body." };
  const session = createCloseoutSession(root, {
    policy: async () => workspacePolicyFiles(root),
    pullRequest: async () => draft,
    rulesFirst: true,
  });
  expect(ruleExit(await session.report({ probes: true }))).toBe(1);
  draft = { title: "feat: add the widget", body: "Body." };
  expect(ruleExit(await session.report({ probes: true }))).toBe(0);
});

test("a draft check that started before the draft was saved is not reused, even when it finished after", () => {
  const event = (type: "started" | "finished", at: number): AgentCloseoutEvent =>
    ({
      at,
      progress: {
        type,
        id: "pr-title",
        kind: "command",
        command: DOCS_EXAMPLE.join(" "),
        head: "a".repeat(40),
        base: "b".repeat(40),
        policyDigest: "sha256:x",
        attempt: 1,
        maxAttempts: 3,
        state: "passed",
        exitCode: 0,
        timedOut: false,
        durationMs: 200,
        stdout: "",
        stderr: "",
        truncated: false,
        clean: true,
      },
    }) as AgentCloseoutEvent;
  const events = [event("started", 100), event("finished", 300)];
  expect(turnPasses(events, 200)).toEqual([]);
  expect(turnPasses(events, 50).map((pass) => pass.id)).toEqual(["pr-title"]);
  expect(turnPasses([event("finished", 300)], 200)).toEqual([]);
});

function ruleExit(report: string): number | undefined {
  const parsed = JSON.parse(report) as {
    rules: Array<{ id: string; result?: { exitCode: number } }>;
  };
  return parsed.rules.find((rule) => rule.id === "pr-title")?.result?.exitCode;
}

function statuses(report: string): Record<string, string> {
  const parsed = JSON.parse(report) as { required: Array<{ id: string; status: string }> };
  return Object.fromEntries(parsed.required.map((item) => [item.id, item.status]));
}

function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "paws-pr-draft-"));
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

function writePolicy(root: string, items: string[], rules: string[] = []): void {
  mkdirSync(join(root, ".agents"), { recursive: true });
  writeFileSync(
    join(root, ".agents", "closeout.yaml"),
    ['specVersion: "0.1"', "items:", ...items, ...rules, ""].join("\n"),
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
