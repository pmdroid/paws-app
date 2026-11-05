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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/acp";
import type { FakeResult } from "../src/acp/testing/script";
import type { RunnerJob } from "../src/runner-execution";
import { executeRunnerCommand } from "../src/runner-worker";
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

async function turn(githubRead: boolean, tokens: Record<number, string> = { 1: TOKEN }) {
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
    launch: { command: process.execPath, args: [fakeAgent, join(root, "trace.json"), script] },
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
    directory: join(workRoot, `.gh-${runId}`),
  };
}

test("the agent finds the turn's token in gh's config, never in its environment, and the folder goes when the turn ends", async () => {
  const { result, trace, journal, directory } = await turn(true);
  expect(result.run.stopReason).toBe("end_turn");
  expect(trace.env?.ghConfig).toEqual({
    directory,
    directoryMode: 0o700,
    hostsMode: 0o600,
    hosts: `github.com:\n    oauth_token: ${TOKEN}\n    git_protocol: https\n    user: paws\n`,
  });
  expect(trace.env?.ghToken).toBe(false);
  expect(trace.env?.githubToken).toBe(false);
  expect(journal).not.toContain(TOKEN);
  expect(journal).toContain("gh auth token printed [redacted]");
  expect(existsSync(directory)).toBe(false);
});

test("a turn without a read token gets no GH_CONFIG_DIR and nothing is written", async () => {
  for (const [githubRead, tokens] of [
    [false, { 1: TOKEN }],
    [true, {}],
  ] as const) {
    const { trace, asked, directory } = await turn(githubRead, tokens);
    expect(trace.env?.ghConfig).toBeUndefined();
    expect(asked).toEqual(githubRead ? [1] : []);
    expect(existsSync(directory)).toBe(false);
  }
}, 30_000);

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
  expect(readFileSync(hosts, "utf8")).toContain(`oauth_token: ${FRESH}`);
  expect(statSync(hosts).ino).not.toBe(before);
  expect(statSync(hosts).mode & 0o777).toBe(0o600);
  expect(readdirSync(directory)).toEqual(["hosts.yml"]);
  expect(config.tokens()).toEqual([TOKEN, FRESH]);
  config.close();
  expect(existsSync(directory)).toBe(false);
});
