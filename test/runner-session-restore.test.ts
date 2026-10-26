import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { git } from "../src/acp";
import type { FakeResult, FakeScript } from "../src/acp/testing/script";
import type { RunnerJob } from "../src/runner-execution";
import { executeRunnerCommand } from "../src/runner-worker";

const linux = process.platform === "linux" && process.getuid!() !== 0;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fakeAgent = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;
const EXECUTION = "01J00000000000000000000002";
const SESSION = "4f1c2a3b-claude-session";
const RUN = "01J0000000000000000000RUN2";

type Entry = { path: string; data: string };

/** A bundle in the shape `writeClaudeSessionBundle` writes. */
function bundleOf(entries: Entry[]): Buffer {
  return gzipSync(
    entries
      .map(
        (entry) =>
          `{"path":${JSON.stringify(entry.path)},"mode":420,"data":"${Buffer.from(entry.data).toString("base64")}"}\n`,
      )
      .join(""),
  );
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "paws-session-restore-"));
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
  // The run checks out at the same path on every runner, so the project folder matches.
  const checkout = join(workRoot, RUN);
  const projectName = checkout.replace(/[^a-zA-Z0-9]/g, "-");
  const base = `.claude/projects/${projectName}`;
  const project = join(home, base);
  const sessionFile = join(project, `${SESSION}.jsonl`);
  const saved: Entry[] = [
    { path: `${base}/${SESSION}.jsonl`, data: '{"type":"user","turn":4}\n' },
    { path: `${base}/${SESSION}/subagents/agent-1.jsonl`, data: '{"type":"assistant"}\n' },
  ];
  const sessionBundle = join(root, "session.ndjson.gz");
  function command(bundle: Buffer, restore = true): RunnerJob["command"] {
    return {
      id: "cmd",
      type: "run",
      runnerId: "runner-b",
      workspaceId: "workspace",
      runId: RUN,
      itemId: "item",
      generation: 5,
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
      ...(restore
        ? {
            resumeSessionId: SESSION,
            restoreSession: {
              generation: 4,
              agent: "claude" as const,
              agentVersion: "2.1.7",
              sessionId: SESSION,
              sha256: createHash("sha256").update(bundle).digest("hex"),
              sizeBytes: bundle.length,
            },
          }
        : {}),
    };
  }
  async function execute(options: {
    bundle: Buffer;
    /** The bytes on disk, when they differ from what the command names. */
    stored?: Buffer | null;
    restore?: boolean;
    script?: Partial<FakeScript>;
  }) {
    writeFileSync(
      join(root, "script.json"),
      JSON.stringify({
        model: "fixture-model",
        sessionId: "new-session",
        loadSession: true,
        loadFile: sessionFile,
        steps: [{ type: "end" }],
        ...options.script,
      }),
    );
    const stored = options.stored === undefined ? options.bundle : options.stored;
    if (stored) writeFileSync(sessionBundle, stored);
    const result = await executeRunnerCommand({
      job: { executionId: EXECUTION, command: command(options.bundle, options.restore ?? true) },
      repositoryBundle,
      ...(stored ? { sessionBundle } : {}),
      outputDirectory: output,
      workRoot,
      home,
      resultsGid: process.getgid!(),
      launch: {
        command: process.execPath,
        args: [fakeAgent, join(root, "trace.json"), join(root, "script.json")],
      },
    });
    const trace = JSON.parse(readFileSync(join(root, "trace.json"), "utf8")) as FakeResult;
    const events = readFileSync(join(output, "events.jsonl"), "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; restored?: boolean; reason?: string });
    return {
      result,
      trace,
      restores: events.filter((event) => event.type === "session_restore"),
    };
  }
  /** Files under the agent's Claude projects folder, relative to the home. */
  function restoredFiles(): string[] {
    const found: string[] = [];
    const walk = (directory: string, relative: string) => {
      if (!existsSync(directory)) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(directory, entry.name), `${relative}/${entry.name}`);
        else found.push(`${relative}/${entry.name}`);
      }
    };
    walk(join(home, ".claude", "projects"), ".claude/projects");
    return found.sort();
  }
  return { root, home, base, project, sessionFile, saved, execute, restoredFiles };
}

test.skipIf(!linux)(
  "a moved run writes the saved session at the same path, loads it and says so",
  async () => {
    const { base, sessionFile, saved, execute, restoredFiles } = await fixture();
    const { result, trace, restores } = await execute({ bundle: bundleOf(saved) });
    expect(result.run.stopReason).toBe("end_turn");
    expect(trace.methods).toContain("session/load");
    expect(trace.methods).not.toContain("session/new");
    expect((trace.loaded as { sessionId: string }).sessionId).toBe(SESSION);
    expect(trace.loadedFile).toBe('{"type":"user","turn":4}\n');
    expect(restoredFiles()).toEqual([
      `${base}/${SESSION}.jsonl`,
      `${base}/${SESSION}/subagents/agent-1.jsonl`,
    ]);
    expect(statSync(sessionFile).mode & 0o777).toBe(0o600);
    expect(String(trace.prompts?.[0] && JSON.stringify(trace.prompts[0]))).toContain(
      "This continues your earlier session",
    );
    expect(restores).toEqual([{ type: "session_restore", restored: true }]);
  },
);

test.skipIf(!linux)(
  "a bundle that does not match its checksum starts a new session and writes nothing",
  async () => {
    const { saved, execute, restoredFiles } = await fixture();
    const bundle = bundleOf(saved);
    const corrupt = Buffer.from(bundle);
    corrupt[corrupt.length - 5]! ^= 0xff;
    const { trace, restores } = await execute({ bundle, stored: corrupt });
    expect(trace.methods).toContain("session/new");
    expect(trace.methods).not.toContain("session/load");
    expect(restoredFiles()).toEqual([]);
    expect(restores).toEqual([{ type: "session_restore", restored: false, reason: "integrity" }]);
  },
);

test.skipIf(!linux)("a session/load error drops the restored files and starts anew", async () => {
  const { saved, execute, restoredFiles } = await fixture();
  const { result, trace, restores } = await execute({
    bundle: bundleOf(saved),
    script: { loadError: "Session format is not supported" },
  });
  expect(result.run.stopReason).toBe("end_turn");
  expect(trace.methods.indexOf("session/load")).toBeLessThan(trace.methods.indexOf("session/new"));
  expect(restoredFiles()).toEqual([]);
  expect(restores).toEqual([{ type: "session_restore", restored: false, reason: "load" }]);
});

test.skipIf(!linux)("a snapshot the runner could not download starts a new session", async () => {
  const { saved, execute, restoredFiles } = await fixture();
  const { trace, restores } = await execute({ bundle: bundleOf(saved), stored: null });
  expect(trace.methods).toContain("session/new");
  expect(trace.methods).not.toContain("session/load");
  expect(restoredFiles()).toEqual([]);
  expect(restores).toEqual([{ type: "session_restore", restored: false, reason: "download" }]);
});

test.skipIf(!linux)(
  "paths outside the session folder are refused and nothing is left behind",
  async () => {
    const { root, home, base, saved, execute, restoredFiles } = await fixture();
    for (const path of [
      `${base}/${SESSION}/../../../../escaped.txt`,
      "../escaped.txt",
      `/${root}/escaped.txt`,
      `.claude/.credentials.json`,
      `.claude/projects/other-project/${SESSION}.jsonl`,
      `${base}/${SESSION}/.credentials.json`,
      `${base}/other-session.jsonl`,
    ]) {
      const { trace, restores } = await execute({
        bundle: bundleOf([...saved, { path, data: "escaped" }]),
      });
      expect(trace.methods).not.toContain("session/load");
      expect(restores).toEqual([{ type: "session_restore", restored: false, reason: "unpack" }]);
      expect(restoredFiles()).toEqual([]);
      expect(existsSync(join(root, "escaped.txt"))).toBe(false);
      expect(existsSync(join(home, "escaped.txt"))).toBe(false);
      expect(existsSync(join(home, ".claude", ".credentials.json"))).toBe(false);
      rmSync(join(root, "output", EXECUTION), { recursive: true, force: true });
      mkdirSync(join(root, "output", EXECUTION), { recursive: true });
    }
  },
);

test.skipIf(!linux)("an existing link at a session path is refused, not followed", async () => {
  const { root, project, sessionFile, saved, execute } = await fixture();
  mkdirSync(project, { recursive: true });
  writeFileSync(join(root, "target.txt"), "untouched");
  symlinkSync(join(root, "target.txt"), sessionFile);
  const { trace, restores } = await execute({ bundle: bundleOf(saved) });
  expect(trace.methods).not.toContain("session/load");
  expect(restores).toEqual([{ type: "session_restore", restored: false, reason: "unpack" }]);
  expect(readFileSync(join(root, "target.txt"), "utf8")).toBe("untouched");
});

test.skipIf(!linux)("a run that did not move never restores or reports", async () => {
  const { saved, execute, restoredFiles } = await fixture();
  const { trace, restores } = await execute({ bundle: bundleOf(saved), restore: false });
  expect(trace.methods).toContain("session/new");
  expect(restoredFiles()).toEqual([]);
  expect(restores).toEqual([]);
});
