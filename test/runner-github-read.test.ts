import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  closeSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { git } from "../src/acp";
import type { FakeResult } from "../src/acp/testing/script";
import { publishRunnerJob, type RunnerJob } from "../src/runner-execution";
import {
  publishRunnerAnswer,
  readRunnerAnswer,
  removeRunnerGitHubRead,
  runnerGitHubReadId,
} from "../src/runner-answers";
import { executeRunnerCommand, writeCodexSessionBundle } from "../src/runner-worker";
import { redactGitHubTokens } from "../src/runner-protocol";
import { openGitHubReadConfig } from "../src/runner-worker/github-read";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const TOKEN = `ghs_${"a".repeat(36)}`;
const FRESH = `ghs_${"b".repeat(36)}`;
const fakeAgent = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;

function temporary() {
  const root = mkdtempSync(join(tmpdir(), "paws-github-read-"));
  roots.push(root);
  return root;
}

async function turn(
  githubRead: boolean,
  tokens: Record<number, string> = { 1: TOKEN },
  extra: Record<string, unknown> = {},
  launchEnv: Record<string, string> = {},
) {
  const root = temporary();
  const source = join(root, "source");
  mkdirSync(source);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  await git(["init", "-b", "main", source]);
  writeFileSync(join(source, "app.txt"), "one");
  await git(["-C", source, "add", "."]);
  await git(["-C", source, "commit", "-m", "initial"], { env });
  const baseSha = (await git(["-C", source, "rev-parse", "HEAD"])).trim();
  const repositoryBundle = join(root, "source.bundle");
  await git(["-C", source, "bundle", "create", repositoryBundle, "--all"]);
  chmodSync(repositoryBundle, 0o600);
  const executionId = "01J00000000000000000000001";
  const runId = "01J0000000000000000000RUN1";
  const command: RunnerJob["command"] = {
    id: "cmd",
    runnerId: "runner",
    workspaceId: "workspace",
    runId,
    itemId: "item",
    generation: 1,
    issuedAt: 1,
    expiresAt: Date.now() + 60_000,
    profile: { agent: "claude", model: "fixture-model" },
    repository: {
      owner: "acme",
      repo: "monorepo",
      remoteUrl: "https://github.com/acme/monorepo.git",
      baseSha,
    },
    prompt: "Implement the request",
    type: "run",
    checkpoint: false,
    ...(githubRead ? { githubRead: true as const } : {}),
  };
  const script = join(root, "script.json");
  writeFileSync(
    script,
    JSON.stringify({
      model: "fixture-model",
      steps: [
        {
          type: "update",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `gh auth token printed ${TOKEN}` },
          },
        },
        { type: "end" },
      ],
      ...extra,
    }),
  );
  const outputDirectory = join(root, "output");
  mkdirSync(outputDirectory);
  const workRoot = join(root, "work");
  const asked: number[] = [];
  const result = await executeRunnerCommand({
    job: { executionId, command },
    repositoryBundle,
    outputDirectory,
    workRoot,
    home: join(root, "home"),
    resultsGid: process.getgid!(),
    launch: {
      command: process.execPath,
      args: [fakeAgent, join(root, "trace.json"), script],
      env: launchEnv,
    },
    githubRead(sequence) {
      asked.push(sequence);
      const token = tokens[sequence];
      return token ? { token, expiresAt: Date.now() + 3_600_000 } : null;
    },
  });
  const trace = JSON.parse(readFileSync(join(root, "trace.json"), "utf8")) as FakeResult;
  return {
    result,
    trace,
    asked,
    journal: readFileSync(join(outputDirectory, "events.jsonl"), "utf8"),
    stored: readFileSync(join(outputDirectory, "result.json"), "utf8"),
    transcript: readFileSync(
      join(
        workRoot,
        ".paws",
        "runs",
        readdirSync(join(workRoot, ".paws", "runs"))[0]!,
        "acp.jsonl",
      ),
      "utf8",
    ),
    directory: join(workRoot, `.gh-${runId}`),
  };
}

test("the agent finds the turn's token in gh's config, never in its environment, and the folder goes when the turn ends", async () => {
  const { result, trace, journal, transcript, directory } = await turn(true);
  expect(result.run.stopReason).toBe("end_turn");
  expect(trace.env?.ghConfig).toEqual({
    directory,
    directoryMode: 0o700,
    hostsMode: 0o600,
    hosts: `github.com:\n    oauth_token: "${TOKEN}"\n    git_protocol: https\n    user: paws\n`,
  });
  expect(trace.env?.ghToken).toBe(false);
  expect(trace.env?.githubToken).toBe(false);
  expect(journal).not.toContain(TOKEN);
  expect(journal).toContain("gh auth token printed [redacted]");
  expect(transcript).not.toContain(TOKEN);
  expect(transcript).toContain("gh auth token printed [redacted]");
  expect(existsSync(directory)).toBe(false);
});

test("a turn without a read token gets no GH_CONFIG_DIR, not even an inherited one, and nothing is written", async () => {
  const inherited = join(temporary(), "operator-gh");
  const { trace, asked, directory } = await turn(
    false,
    { 1: TOKEN },
    {},
    { GH_CONFIG_DIR: inherited },
  );
  expect(trace.env?.ghConfig).toBeUndefined();
  expect(asked).toEqual([]);
  expect(existsSync(directory)).toBe(false);
}, 30_000);

test("a token minted after the agent started still reaches gh's config", async () => {
  const directory = join(temporary(), ".gh-run");
  const published: Record<number, string> = {};
  const config = openGitHubReadConfig(
    directory,
    (sequence) => {
      const token = published[sequence];
      return token ? { token, expiresAt: Date.now() + 3_600_000 } : null;
    },
    10,
  );
  expect(config?.directory).toBe(directory);
  expect(readdirSync(directory)).toEqual([]);
  expect(config.tokens()).toEqual([]);
  published[1] = TOKEN;
  const hosts = join(directory, "hosts.yml");
  for (let i = 0; i < 200 && !existsSync(hosts); i++) await Bun.sleep(10);
  expect(readFileSync(hosts, "utf8")).toContain(`oauth_token: "${TOKEN}"`);
  expect(config.tokens()).toEqual([TOKEN]);
  config.close();
  expect(existsSync(directory)).toBe(false);
});

test("a fresh token replaces hosts.yml atomically before the old one expires", async () => {
  const directory = join(temporary(), ".gh-run");
  const published: Record<number, string> = { 1: TOKEN };
  const config = openGitHubReadConfig(
    directory,
    (sequence) => {
      const token = published[sequence];
      return token ? { token, expiresAt: Date.now() + 3_600_000 } : null;
    },
    10,
  )!;
  const hosts = join(directory, "hosts.yml");
  const before = statSync(hosts).ino;
  published[2] = FRESH;
  for (let i = 0; i < 200 && !readFileSync(hosts, "utf8").includes(FRESH); i++) await Bun.sleep(10);
  expect(readFileSync(hosts, "utf8")).toContain(`oauth_token: "${FRESH}"`);
  expect(statSync(hosts).ino).not.toBe(before);
  expect(statSync(hosts).mode & 0o777).toBe(0o600);
  expect(readdirSync(directory)).toEqual(["hosts.yml"]);
  expect(config.tokens()).toEqual([TOKEN, FRESH]);
  config.close();
  expect(existsSync(directory)).toBe(false);
});

test("a restarted worker starts from the newest token the runner kept", async () => {
  const directory = join(temporary(), ".gh-run");
  const config = openGitHubReadConfig(directory, (sequence) =>
    sequence === 3 ? { token: FRESH, expiresAt: Date.now() + 3_600_000 } : null,
  );
  expect(readFileSync(join(directory, "hosts.yml"), "utf8")).toContain(`oauth_token: "${FRESH}"`);
  expect(config.tokens()).toEqual([FRESH]);
  config.close();
});

test("the spool keeps only the newest token, and none once the turn is gone", () => {
  const root = temporary();
  const spool = {
    root: join(root, "spool"),
    runnerUid: process.getuid!(),
    agentGid: process.getgid!(),
  };
  mkdirSync(spool.root);
  chmodSync(spool.root, 0o750);
  const executionId = "01J00000000000000000000009";
  publishRunnerJob(spool, {
    executionId,
    command: {
      id: "check",
      runnerId: "runner",
      workspaceId: "workspace",
      issuedAt: 1,
      expiresAt: Date.now() + 60_000,
      type: "login_check",
      agent: "codex",
    },
  });
  const held = () =>
    [1, 2, 3].filter((sequence) =>
      readRunnerAnswer(spool, executionId, runnerGitHubReadId(sequence)),
    );
  for (const sequence of [1, 2, 3]) {
    publishRunnerAnswer(spool, executionId, {
      requestId: runnerGitHubReadId(sequence),
      answer: JSON.stringify({ token: TOKEN, expiresAt: Date.now() + 3_600_000 }),
    });
    removeRunnerGitHubRead(spool, executionId, sequence);
  }
  expect(held()).toEqual([3]);
  removeRunnerGitHubRead(spool, executionId);
  expect(held()).toEqual([]);
});

test("an agent error that carries the token is stored redacted in the worker's result", async () => {
  const { result, stored } = await turn(
    true,
    { 1: TOKEN },
    { modelError: `model refused ${TOKEN}` },
  );
  expect(result.run.errorMessage).toBeDefined();
  expect(stored).not.toContain(TOKEN);
  expect(result.run.errorMessage).toBe("Run failed during agent: Error.");
});

test("a session snapshot leaves the token out, even where it straddles a read chunk", async () => {
  const root = temporary();
  const home = join(root, "home");
  const thread = "01a17acb-43ee-7330-b820-362fdbcbc801";
  const day = join(home, ".codex", "sessions", "2026", "10", "27");
  mkdirSync(day, { recursive: true, mode: 0o700 });
  const head = "x".repeat(196_608 - 10) + " ";
  const content = `${head}${TOKEN} and ${FRESH}\n${"é".repeat(5)} tail`;
  writeFileSync(join(day, `rollout-2026-10-27T00-38-23-${thread}.jsonl`), content, { mode: 0o600 });
  const output = join(root, "session.ndjson.gz");
  const fd = openSync(output, "w", 0o600);
  try {
    await writeCodexSessionBundle({
      home,
      sessionId: thread,
      output: fd,
      maxBytes: 64 * 1024 * 1024,
      redact: (text) => redactGitHubTokens(text, [TOKEN]),
    });
  } finally {
    closeSync(fd);
  }
  const entry = JSON.parse(gunzipSync(readFileSync(output)).toString("utf8").trim()) as {
    data: string;
  };
  const restored = Buffer.from(entry.data, "base64").toString("utf8");
  expect(restored).not.toContain(TOKEN);
  expect(restored).not.toContain(FRESH);
  expect(restored).toBe(`${head}[redacted] and [redacted]\n${"é".repeat(5)} tail`);
});
