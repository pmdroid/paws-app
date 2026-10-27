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
import { gunzipSync, gzipSync } from "node:zlib";
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
const EXECUTION = "01J00000000000000000000003";
const RUN = "01J0000000000000000000RUN3";
/** Codex names an ACP session by its thread id. */
const THREAD = "01a17acb-43ee-7330-b820-362fdbcbc801";
const DAY = "sessions/2026/10/27";
const ROLLOUT = `rollout-2026-10-27T00-38-23-${THREAD}.jsonl`;
const ROLLOUT_PATH = `.codex/${DAY}/${ROLLOUT}`;

type Entry = { path: string; data: string };

/** A bundle in the shape `writeCodexSessionBundle` writes. */
function bundleOf(entries: Entry[]): Buffer {
  return gzipSync(
    entries
      .map(
        (entry) =>
          `{"path":${JSON.stringify(entry.path)},"mode":384,"data":"${Buffer.from(entry.data).toString("base64")}"}\n`,
      )
      .join(""),
  );
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "paws-codex-session-"));
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
  const codex = join(home, ".codex");
  mkdirSync(codex, { mode: 0o700 });
  const rollout = join(home, ROLLOUT_PATH);
  const sessionBundle = join(root, "session.ndjson.gz");
  function command(restore?: Buffer): RunnerJob["command"] {
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
      profile: { agent: "codex", model: "fixture-model" },
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
            resumeSessionId: THREAD,
            restoreSession: {
              generation: 4,
              agent: "codex" as const,
              agentVersion: "2.1.1",
              sessionId: THREAD,
              sha256: createHash("sha256").update(restore).digest("hex"),
              sizeBytes: restore.length,
            },
          }
        : {}),
    };
  }
  async function execute(options: { restore?: Buffer; script?: Partial<FakeScript> }) {
    writeFileSync(
      join(root, "script.json"),
      JSON.stringify({
        model: "fixture-model",
        sessionId: THREAD,
        loadSession: true,
        loadFile: rollout,
        steps: [{ type: "end" }],
        ...options.script,
      }),
    );
    if (options.restore) writeFileSync(sessionBundle, options.restore);
    const result = await executeRunnerCommand({
      job: { executionId: EXECUTION, command: command(options.restore) },
      repositoryBundle,
      ...(options.restore ? { sessionBundle } : {}),
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
  function bundle() {
    return gunzipSync(readFileSync(join(output, "session.ndjson.gz")))
      .toString("utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as { path: string; mode: number; data: string });
  }
  /** Files under the agent's Codex sessions folder, relative to the home. */
  function rollouts(): string[] {
    const found: string[] = [];
    const walk = (directory: string, relative: string) => {
      if (!existsSync(directory)) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(directory, entry.name), `${relative}/${entry.name}`);
        else found.push(`${relative}/${entry.name}`);
      }
    };
    walk(join(codex, "sessions"), ".codex/sessions");
    return found.sort();
  }
  return { root, home, codex, rollout, output, baseSha, execute, bundle, rollouts };
}

test.skipIf(!linux)(
  "a finished Codex turn bundles exactly the session's rollout and never auth.json",
  async () => {
    const { root, codex, rollout, output, baseSha, execute, bundle } = await fixture();
    // Everything in the Codex home that must never leave the runner.
    writeFileSync(join(codex, "auth.json"), '{"tokens":{"access_token":"secret"}}');
    writeFileSync(join(codex, "config.toml"), 'model = "secret-config"\n');
    writeFileSync(join(codex, "session_index.jsonl"), `{"id":"${THREAD}"}\n`);
    writeFileSync(join(codex, "state_5.sqlite"), "secret-state");
    mkdirSync(join(codex, DAY), { recursive: true });
    writeFileSync(
      join(codex, DAY, "rollout-2026-10-27T00-10-00-01a17acb-0000-7000-8000-000000000000.jsonl"),
      "secret-other-rollout",
    );

    const result = await execute({
      script: {
        steps: [
          { type: "write_file", path: rollout, content: '{"type":"session_meta"}\n' },
          { type: "end" },
        ],
      },
    });
    expect(result.result.run.stopReason).toBe("end_turn");
    const lines = bundle();
    expect(lines.map((line) => line.path)).toEqual([ROLLOUT_PATH]);
    expect(Buffer.from(lines[0]!.data, "base64").toString()).toBe('{"type":"session_meta"}\n');
    const bytes = readFileSync(join(output, "session.ndjson.gz"));
    expect(gunzipSync(bytes).includes(Buffer.from("secret"))).toBe(false);
    expect(JSON.parse(readFileSync(join(output, "session.json"), "utf8"))).toEqual({
      agent: "codex",
      sessionId: THREAD,
      workspacePath: join(root, "work", RUN),
      commitSha: baseSha,
      turn: 5,
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  },
);

test.skipIf(!linux)("a rollout that is a link is never bundled", async () => {
  const { root, codex, output, execute } = await fixture();
  mkdirSync(join(codex, DAY), { recursive: true });
  writeFileSync(join(root, "elsewhere.jsonl"), "elsewhere");
  symlinkSync(join(root, "elsewhere.jsonl"), join(codex, DAY, ROLLOUT));
  const { result } = await execute({});
  expect(result.run.stopReason).toBe("end_turn");
  expect(existsSync(join(output, "session.ndjson.gz"))).toBe(false);
  expect(existsSync(join(output, "session.json"))).toBe(false);
});

test.skipIf(!linux)("a Codex turn without a rollout leaves no snapshot", async () => {
  const { output, execute } = await fixture();
  const { result } = await execute({});
  expect(result.run.stopReason).toBe("end_turn");
  expect(existsSync(join(output, "session.ndjson.gz"))).toBe(false);
  expect(existsSync(join(output, "session.json"))).toBe(false);
});

test.skipIf(!linux)(
  "a moved Codex run writes the rollout in the same date folder, then loads it",
  async () => {
    const { rollout, execute, rollouts } = await fixture();
    const { result, trace, restores } = await execute({
      restore: bundleOf([{ path: ROLLOUT_PATH, data: '{"type":"session_meta","turn":4}\n' }]),
    });
    expect(result.run.stopReason).toBe("end_turn");
    expect(trace.methods).toContain("session/load");
    expect(trace.methods).not.toContain("session/new");
    expect((trace.loaded as { sessionId: string }).sessionId).toBe(THREAD);
    expect(trace.loadedFile).toBe('{"type":"session_meta","turn":4}\n');
    expect(rollouts()).toEqual([ROLLOUT_PATH]);
    expect(statSync(rollout).mode & 0o777).toBe(0o600);
    expect(restores).toEqual([{ type: "session_restore", restored: true }]);
  },
);

test.skipIf(!linux)(
  "a rollout another Codex version can't load is dropped and the run starts anew",
  async () => {
    const { execute, rollouts } = await fixture();
    const { result, trace, restores } = await execute({
      restore: bundleOf([{ path: ROLLOUT_PATH, data: '{"type":"session_meta"}\n' }]),
      script: { loadError: "unsupported rollout format version 9", sessionId: "new-thread" },
    });
    expect(result.run.stopReason).toBe("end_turn");
    expect(trace.methods.indexOf("session/load")).toBeLessThan(
      trace.methods.indexOf("session/new"),
    );
    expect(rollouts()).toEqual([]);
    expect(restores).toEqual([{ type: "session_restore", restored: false, reason: "load" }]);
  },
);

test.skipIf(!linux)(
  "an agent without loadSession drops the restored rollout and starts anew",
  async () => {
    const { execute, rollouts } = await fixture();
    const { result, trace, restores } = await execute({
      restore: bundleOf([{ path: ROLLOUT_PATH, data: '{"type":"session_meta"}\n' }]),
      script: { loadSession: false, sessionId: "new-thread" },
    });
    expect(result.run.stopReason).toBe("end_turn");
    expect(trace.methods).not.toContain("session/load");
    expect(trace.methods).toContain("session/new");
    expect(rollouts()).toEqual([]);
    expect(restores).toEqual([{ type: "session_restore", restored: false, reason: "load" }]);
  },
);

test.skipIf(!linux)(
  "a Codex bundle with anything but the session's rollout is refused",
  async () => {
    const rolloutEntry = { path: ROLLOUT_PATH, data: '{"type":"session_meta"}\n' };
    for (const extra of [
      { path: ".codex/auth.json", data: '{"tokens":"stolen"}' },
      { path: ".codex/config.toml", data: 'model = "other"' },
      {
        path: `.codex/${DAY}/rollout-2026-10-27T00-10-00-01a17acb-0000-7000-8000-000000000000.jsonl`,
        data: "other",
      },
      { path: `.codex/sessions/2026/10/${ROLLOUT}`, data: "shallow" },
      { path: `.codex/${DAY}/../../../../auth.json`, data: "escaped" },
      rolloutEntry,
    ]) {
      const { codex, execute, rollouts } = await fixture();
      const { trace, restores } = await execute({ restore: bundleOf([rolloutEntry, extra]) });
      expect(trace.methods).not.toContain("session/load");
      expect(restores).toEqual([{ type: "session_restore", restored: false, reason: "unpack" }]);
      expect(rollouts()).toEqual([]);
      expect(existsSync(join(codex, "auth.json"))).toBe(false);
      expect(existsSync(join(codex, "config.toml"))).toBe(false);
    }
  },
);
