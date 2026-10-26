import { afterEach, expect, test } from "bun:test";
import {
  closeSync,
  openSync,
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { createHash, randomBytes } from "node:crypto";
import { git } from "../src/acp";
import type { FakeScript } from "../src/acp/testing/script";
import type { RunnerJob } from "../src/runner-execution";
import {
  CLAUDE_SESSION_TOO_LARGE,
  executeRunnerCommand,
  writeClaudeSessionBundle,
} from "../src/runner-worker";

const linux = process.platform === "linux" && process.getuid!() !== 0;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fakeAgent = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;
const EXECUTION = "01J00000000000000000000001";
const SESSION = "4f1c2a3b-claude-session";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "paws-session-snapshot-"));
  roots.push(root);
  const source = join(root, "source");
  const home = join(root, "home");
  const workRoot = join(root, "work");
  const output = join(root, "output", EXECUTION);
  for (const path of [source, home, output]) mkdirSync(path, { recursive: true });
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  await git(["init", "-b", "main", source]);
  writeFileSync(join(source, "original.txt"), "original");
  await git(["-C", source, "add", "."]);
  await git(["-C", source, "commit", "-m", "initial"], { env });
  const baseSha = (await git(["-C", source, "rev-parse", "HEAD"])).trim();
  const repositoryBundle = join(root, "source.bundle");
  await git(["-C", source, "bundle", "create", repositoryBundle, "--all"]);
  chmodSync(repositoryBundle, 0o600);
  const runId = "01J0000000000000000000RUN1";
  const command: RunnerJob["command"] = {
    id: "cmd",
    type: "run",
    runnerId: "runner",
    workspaceId: "workspace",
    runId,
    itemId: "item",
    generation: 7,
    issuedAt: 1,
    expiresAt: Date.now() + 60_000,
    profile: { agent: "claude", model: "fixture-model" },
    repository: {
      owner: "acme",
      repo: "repo",
      remoteUrl: "https://github.com/acme/repo.git",
      baseSha,
    },
    prompt: "Implement the request",
    checkpoint: false,
  };
  const checkout = join(workRoot, runId);
  const projectName = checkout.replace(/[^a-zA-Z0-9]/g, "-");
  const project = join(home, ".claude", "projects", projectName);
  async function execute(
    steps: FakeScript["steps"],
    extra: { signal?: AbortSignal; sessionSnapshotMaxBytes?: number } = {},
  ) {
    writeFileSync(
      join(root, "script.json"),
      JSON.stringify({ model: "fixture-model", sessionId: SESSION, steps }),
    );
    return executeRunnerCommand({
      job: { executionId: EXECUTION, command },
      repositoryBundle,
      outputDirectory: output,
      workRoot,
      home,
      resultsGid: process.getgid!(),
      launch: {
        command: process.execPath,
        args: [fakeAgent, join(root, "trace.json"), join(root, "script.json")],
      },
      ...extra,
    });
  }
  const writeSession = (content = '{"type":"user"}\n'): FakeScript["steps"] => [
    { type: "write_file", path: join(project, `${SESSION}.jsonl`), content },
    {
      type: "write_file",
      path: join(project, SESSION, "subagents", "agent-1.jsonl"),
      content: '{"type":"assistant"}\n',
    },
  ];
  function bundle() {
    return gunzipSync(readFileSync(join(output, "session.ndjson.gz")))
      .toString("utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as { path: string; mode: number; data: string });
  }
  return {
    root,
    home,
    output,
    project,
    projectName,
    checkout,
    baseSha,
    execute,
    writeSession,
    bundle,
  };
}

test.skipIf(!linux)(
  "a finished Claude turn bundles exactly the session file and its sidecar folder",
  async () => {
    const {
      root,
      home,
      output,
      project,
      projectName,
      checkout,
      baseSha,
      execute,
      writeSession,
      bundle,
    } = await fixture();
    // Everything around the session that must never leave the runner.
    mkdirSync(join(project, SESSION, "subagents"), { recursive: true });
    writeFileSync(join(home, ".claude", ".credentials.json"), '{"token":"secret"}');
    writeFileSync(join(home, ".claude", "settings.json"), "{}");
    mkdirSync(join(home, ".claude", "skills", "skill"), { recursive: true });
    writeFileSync(join(home, ".claude", "skills", "skill", "SKILL.md"), "skill");
    writeFileSync(join(project, "other-session.jsonl"), "other");
    mkdirSync(join(project, "other-session"));
    writeFileSync(join(project, "other-session", "agent.jsonl"), "other");
    writeFileSync(join(root, "outside.txt"), "outside");
    symlinkSync(join(root, "outside.txt"), join(project, SESSION, "linked.jsonl"));
    symlinkSync(join(root), join(project, SESSION, "linked-folder"));
    writeFileSync(join(root, "hard.txt"), "hard");
    linkSync(join(root, "hard.txt"), join(project, SESSION, "subagents", "hard.jsonl"));
    writeFileSync(join(project, SESSION, ".credentials.json"), '{"token":"secret"}');

    const result = await execute([...writeSession(), { type: "end" }]);
    expect(result.run.stopReason).toBe("end_turn");
    const lines = bundle();
    const base = `.claude/projects/${projectName}`;
    expect(lines.map((line) => line.path)).toEqual([
      `${base}/${SESSION}.jsonl`,
      `${base}/${SESSION}/subagents/agent-1.jsonl`,
    ]);
    expect(Buffer.from(lines[0]!.data, "base64").toString()).toBe('{"type":"user"}\n');
    expect(Buffer.from(lines[1]!.data, "base64").toString()).toBe('{"type":"assistant"}\n');
    expect(lines[0]!.mode).toBe(0o644 & ~process.umask());
    const bytes = readFileSync(join(output, "session.ndjson.gz"));
    expect(JSON.parse(readFileSync(join(output, "session.json"), "utf8"))).toEqual({
      agent: "claude",
      sessionId: SESSION,
      workspacePath: checkout,
      commitSha: baseSha,
      turn: 7,
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(bytes.includes(Buffer.from("secret"))).toBe(false);
  },
);

test.skipIf(!linux)("a session file that is a link is never bundled", async () => {
  const { root, output, project, execute, writeSession } = await fixture();
  mkdirSync(project, { recursive: true });
  writeFileSync(join(root, "elsewhere.jsonl"), "elsewhere");
  symlinkSync(join(root, "elsewhere.jsonl"), join(project, `${SESSION}.jsonl`));
  const result = await execute([...writeSession().slice(1), { type: "end" }]);
  expect(result.run.stopReason).toBe("end_turn");
  expect(existsSync(join(output, "session.ndjson.gz"))).toBe(false);
  expect(existsSync(join(output, "session.json"))).toBe(false);
});

test.skipIf(!linux)("a bundle over the size cap is skipped with a notice", async () => {
  const { output, execute, writeSession } = await fixture();
  const result = await execute(
    [...writeSession(randomBytes(64 * 1024).toString("base64")), { type: "end" }],
    { sessionSnapshotMaxBytes: 4096 },
  );
  expect(result.run.stopReason).toBe("end_turn");
  expect(existsSync(join(output, "session.ndjson.gz"))).toBe(false);
  expect(existsSync(join(output, "session.json"))).toBe(false);
  const events = readFileSync(join(output, "events.jsonl"), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string; text?: string; notice?: boolean });
  expect(events).toContainEqual({ type: "progress", text: CLAUDE_SESSION_TOO_LARGE, notice: true });
});

test.skipIf(!linux)("a cancelled turn doesn't snapshot", async () => {
  const { output, project, execute, writeSession } = await fixture();
  const controller = new AbortController();
  const waiting = (async () => {
    while (!existsSync(join(project, SESSION, "subagents", "agent-1.jsonl"))) await Bun.sleep(10);
    controller.abort();
  })();
  const result = await execute([...writeSession(), { type: "hang" }], {
    signal: controller.signal,
  });
  await waiting;
  expect(result.run.cancelled).toBe(true);
  expect(existsSync(join(output, "session.ndjson.gz"))).toBe(false);
  expect(existsSync(join(output, "session.json"))).toBe(false);
});

test.skipIf(!linux)("a turn that ends in a cancelled stop reason doesn't snapshot", async () => {
  const { output, execute, writeSession } = await fixture();
  const result = await execute([...writeSession(), { type: "end", stopReason: "cancelled" }]);
  expect(result.run.stopReason).not.toBe("end_turn");
  expect(existsSync(join(output, "session.json"))).toBe(false);
});

test.skipIf(!linux)(
  "a bundle write that fails rejects instead of crashing the worker",
  async () => {
    const { root, home, project, checkout } = await fixture();
    mkdirSync(join(project, SESSION), { recursive: true });
    writeFileSync(join(project, `${SESSION}.jsonl`), randomBytes(256 * 1024).toString("base64"));
    writeFileSync(
      join(project, SESSION, "agent.jsonl"),
      randomBytes(256 * 1024).toString("base64"),
    );
    writeFileSync(join(root, "bundle.gz"), "");
    // A descriptor that refuses writes stands in for a full disk.
    const output = openSync(join(root, "bundle.gz"), "r");
    try {
      await expect(
        writeClaudeSessionBundle({
          home,
          cwd: checkout,
          sessionId: SESSION,
          output,
          maxBytes: 1_073_741_824,
        }),
      ).rejects.toThrow();
    } finally {
      closeSync(output);
    }
  },
);
