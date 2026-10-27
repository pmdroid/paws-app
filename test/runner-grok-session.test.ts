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
const EXECUTION = "01J00000000000000000000004";
const RUN = "01J0000000000000000000RUN4";
/** Grok names a session with a UUIDv7. */
const SESSION = "01a17b95-40da-7871-aaa6-8c7e99b03e41";

type Entry = { path: string; data: string };

/** A bundle in the shape `writeGrokSessionBundle` writes. */
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
  const root = mkdtempSync(join(tmpdir(), "paws-grok-session-"));
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
  const grok = join(home, ".grok");
  mkdirSync(grok, { mode: 0o700 });
  const workspace = join(workRoot, RUN);
  // As Grok 1.0.50 names it: the cwd with every `/` as `%2F`.
  const encoded = workspace.replaceAll("/", "%2F");
  const group = `.grok/sessions/${encoded}`;
  const base = `${group}/${SESSION}`;
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
      profile: { agent: "grok", model: "fixture-model" },
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
              agent: "grok" as const,
              agentVersion: "1.0.50",
              sessionId: SESSION,
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
        sessionId: SESSION,
        // A runner's Grok signs in with its cached `grok login` token.
        authMethods: [{ id: "cached_token", name: "Grok login" }],
        loadSession: true,
        loadFile: join(home, base, "updates.jsonl"),
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
  /** Files under the agent's Grok sessions folder, relative to the home. */
  function sessions(): string[] {
    const found: string[] = [];
    const walk = (directory: string, relative: string) => {
      if (!existsSync(directory)) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(directory, entry.name), `${relative}/${entry.name}`);
        else found.push(`${relative}/${entry.name}`);
      }
    };
    walk(join(grok, "sessions"), ".grok/sessions");
    return found.sort();
  }
  return { root, home, grok, workspace, group, base, output, baseSha, execute, bundle, sessions };
}

test.skipIf(!linux)(
  "a finished Grok turn bundles exactly the session folder and never credentials",
  async () => {
    const { home, grok, workspace, group, base, output, baseSha, execute, bundle } =
      await fixture();
    // Everything in the Grok home that must never leave the runner.
    writeFileSync(join(grok, "auth.json"), '{"access_token":"secret"}');
    writeFileSync(join(grok, "config.toml"), 'model = "secret-config"\n');
    writeFileSync(join(grok, "mcp_credentials.json"), '{"token":"secret"}');
    mkdirSync(join(home, group), { recursive: true });
    writeFileSync(join(grok, "sessions", "session_search.sqlite"), "secret-index");
    writeFileSync(join(home, group, "permission.toml"), "secret-grants");
    mkdirSync(join(home, group, "01a17b95-0000-7000-8000-000000000000"));
    writeFileSync(
      join(home, group, "01a17b95-0000-7000-8000-000000000000", "updates.jsonl"),
      "secret-other-session",
    );

    const write = (path: string, content: string) => ({
      type: "write_file" as const,
      path: join(home, base, path),
      content,
    });
    const result = await execute({
      script: {
        steps: [
          write("updates.jsonl", '{"update":"user_message"}\n'),
          write("chat_history.jsonl", '{"role":"user"}\n'),
          write("summary.json", '{"title":"Fixture"}'),
          write("plan.md", "# Plan\n"),
          write("compaction_checkpoints/1.json", '{"checkpoint":1}'),
          // A credential file inside the session folder is still never bundled.
          write("auth.json", '{"access_token":"secret"}'),
          { type: "end" },
        ],
      },
    });
    expect(result.result.run.stopReason).toBe("end_turn");
    const lines = bundle();
    expect(lines.map((line) => line.path)).toEqual([
      `${base}/chat_history.jsonl`,
      `${base}/compaction_checkpoints/1.json`,
      `${base}/plan.md`,
      `${base}/summary.json`,
      `${base}/updates.jsonl`,
    ]);
    expect(base.startsWith(".grok/sessions/%2F")).toBe(true);
    expect(
      Buffer.from(
        lines.find((line) => line.path.endsWith("/updates.jsonl"))!.data,
        "base64",
      ).toString(),
    ).toBe('{"update":"user_message"}\n');
    const bytes = readFileSync(join(output, "session.ndjson.gz"));
    expect(gunzipSync(bytes).includes(Buffer.from("secret"))).toBe(false);
    expect(JSON.parse(readFileSync(join(output, "session.json"), "utf8"))).toEqual({
      agent: "grok",
      sessionId: SESSION,
      workspacePath: workspace,
      commitSha: baseSha,
      turn: 5,
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  },
);

test.skipIf(!linux)("a link in the Grok session folder is never bundled", async () => {
  const { root, home, base, execute, bundle } = await fixture();
  mkdirSync(join(home, base), { recursive: true });
  writeFileSync(join(home, base, "updates.jsonl"), "{}\n");
  writeFileSync(join(root, "elsewhere.json"), "secret-elsewhere");
  symlinkSync(join(root, "elsewhere.json"), join(home, base, "summary.json"));
  const { result } = await execute({});
  expect(result.run.stopReason).toBe("end_turn");
  expect(bundle().map((line) => line.path)).toEqual([`${base}/updates.jsonl`]);
});

test.skipIf(!linux)("a session log that is a link leaves no snapshot", async () => {
  const { root, home, base, output, execute } = await fixture();
  mkdirSync(join(home, base), { recursive: true });
  writeFileSync(join(root, "elsewhere.jsonl"), "elsewhere");
  symlinkSync(join(root, "elsewhere.jsonl"), join(home, base, "updates.jsonl"));
  const { result } = await execute({});
  expect(result.run.stopReason).toBe("end_turn");
  expect(existsSync(join(output, "session.ndjson.gz"))).toBe(false);
  expect(existsSync(join(output, "session.json"))).toBe(false);
});

test.skipIf(!linux)("a Grok turn without a session folder leaves no snapshot", async () => {
  const { output, execute } = await fixture();
  const { result } = await execute({});
  expect(result.run.stopReason).toBe("end_turn");
  expect(existsSync(join(output, "session.ndjson.gz"))).toBe(false);
  expect(existsSync(join(output, "session.json"))).toBe(false);
});

test.skipIf(!linux)(
  "a moved Grok run writes the session folder under the same encoded cwd, then loads it",
  async () => {
    const { home, base, execute, sessions } = await fixture();
    const { result, trace, restores } = await execute({
      restore: bundleOf([
        { path: `${base}/updates.jsonl`, data: '{"turn":4}\n' },
        { path: `${base}/summary.json`, data: '{"title":"Fixture"}' },
        { path: `${base}/compaction_checkpoints/1.json`, data: "{}" },
      ]),
    });
    expect(result.run.stopReason).toBe("end_turn");
    expect(trace.methods).toContain("session/load");
    expect(trace.methods).not.toContain("session/new");
    expect((trace.loaded as { sessionId: string }).sessionId).toBe(SESSION);
    expect(trace.loadedFile).toBe('{"turn":4}\n');
    expect(sessions()).toEqual([
      `${base}/compaction_checkpoints/1.json`,
      `${base}/summary.json`,
      `${base}/updates.jsonl`,
    ]);
    expect(statSync(join(home, base, "updates.jsonl")).mode & 0o777).toBe(0o600);
    expect(restores).toEqual([{ type: "session_restore", restored: true }]);
  },
);

test.skipIf(!linux)(
  "a session another Grok version can't load is dropped and the run starts anew",
  async () => {
    const { base, execute, sessions } = await fixture();
    const { result, trace, restores } = await execute({
      restore: bundleOf([{ path: `${base}/updates.jsonl`, data: "{}\n" }]),
      script: { loadError: "unsupported session format", sessionId: "new-session" },
    });
    expect(result.run.stopReason).toBe("end_turn");
    expect(trace.methods.indexOf("session/load")).toBeLessThan(
      trace.methods.indexOf("session/new"),
    );
    expect(sessions()).toEqual([]);
    expect(restores).toEqual([{ type: "session_restore", restored: false, reason: "load" }]);
  },
);

test.skipIf(!linux)(
  "a Grok agent without loadSession drops the restored session and starts anew",
  async () => {
    const { base, execute, sessions } = await fixture();
    const { result, trace, restores } = await execute({
      restore: bundleOf([{ path: `${base}/updates.jsonl`, data: "{}\n" }]),
      script: { loadSession: false, sessionId: "new-session" },
    });
    expect(result.run.stopReason).toBe("end_turn");
    expect(trace.methods).not.toContain("session/load");
    expect(trace.methods).toContain("session/new");
    expect(sessions()).toEqual([]);
    expect(restores).toEqual([{ type: "session_restore", restored: false, reason: "load" }]);
  },
);

test.skipIf(!linux)("a Grok bundle without the session log is refused", async () => {
  const { base, execute, sessions } = await fixture();
  const { trace, restores } = await execute({
    restore: bundleOf([{ path: `${base}/summary.json`, data: "{}" }]),
  });
  expect(trace.methods).not.toContain("session/load");
  expect(restores).toEqual([{ type: "session_restore", restored: false, reason: "unpack" }]);
  expect(sessions()).toEqual([]);
});

// One test per entry, so each restore gets its own time budget.
for (const [name, extra] of [
  ["auth.json", (_: string, __: string) => ({ path: ".grok/auth.json", data: "stolen" })],
  ["config.toml", () => ({ path: ".grok/config.toml", data: 'model = "other"' })],
  ["mcp_credentials.json", () => ({ path: ".grok/mcp_credentials.json", data: "stolen" })],
  [
    "auth.json inside the session folder",
    (base: string) => ({ path: `${base}/auth.json`, data: "stolen" }),
  ],
  [
    "the cwd folder's permission.toml",
    (_: string, group: string) => ({ path: `${group}/permission.toml`, data: "allow-all" }),
  ],
  [
    "another session",
    (_: string, group: string) => ({
      path: `${group}/01a17b95-0000-7000-8000-000000000000/updates.jsonl`,
      data: "other",
    }),
  ],
  [
    "a session under another cwd",
    () => ({ path: `.grok/sessions/%2Felsewhere/${SESSION}/updates.jsonl`, data: "other" }),
  ],
  [
    "a path that escapes",
    (base: string) => ({ path: `${base}/../../../auth.json`, data: "escaped" }),
  ],
] as const)
  test.skipIf(!linux)(`a Grok bundle that also holds ${name} is refused`, async () => {
    const { grok, base, group, execute, sessions } = await fixture();
    const { trace, restores } = await execute({
      restore: bundleOf([{ path: `${base}/updates.jsonl`, data: "{}\n" }, extra(base, group)]),
    });
    expect(trace.methods).not.toContain("session/load");
    expect(restores).toEqual([{ type: "session_restore", restored: false, reason: "unpack" }]);
    expect(sessions()).toEqual([]);
    for (const file of ["auth.json", "config.toml", "mcp_credentials.json"])
      expect(existsSync(join(grok, file))).toBe(false);
  });
