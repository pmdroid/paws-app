import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { buildDockerRun, readDockerRecords, writeRecordingDocker } from "../sandbox";
import { spawnAgent } from "./process";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const worktree = "/Users/dev/.paws/worktrees/ENG-1";

function dirtyEnv(): Record<string, string> {
  return {
    HOME: "/Users/dev",
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
    SSH_AGENT_PID: "99",
    ANTHROPIC_API_KEY: "sk-ant-secret",
    OPENAI_API_KEY: "sk-openai-secret",
    GITHUB_TOKEN: "ghp_secret",
    GH_TOKEN: "ghp_other",
  };
}

describe("spawnAgent", () => {
  test("without a docker option the host command, args, and env are unchanged", async () => {
    const root = await tempDir();
    const fake = await writeRecordingDocker(root);
    const env = dirtyEnv();
    const child = spawnAgent(fake.bin, ["--flag"], env);
    await waitExit(child);
    const [record] = await readDockerRecords(fake.record);
    expect(record?.argv).toEqual(["--flag"]);
    expect(record?.argv).not.toContain("run");
    expect(record?.argv).not.toContain("--network");
    expect(record?.env.HOME).toBe("/Users/dev");
    expect(record?.env.ANTHROPIC_API_KEY).toBe("sk-ant-secret");
    expect(record?.env.SSH_AUTH_SOCK).toBe("/tmp/ssh-agent.sock");
    expect(record?.env.PATH).toBe("/usr/bin:/bin");
    expect(child.stdin).not.toBeNull();
    expect(child.stdout).not.toBeNull();

    const again = await writeRecordingDocker(await tempDir());
    const empty = spawnAgent(again.bin, ["--flag"], env, {});
    await waitExit(empty);
    const [second] = await readDockerRecords(again.record);
    expect(second?.argv).toEqual(["--flag"]);
    expect(second?.env.HOME).toBe("/Users/dev");
    expect(second?.env.GITHUB_TOKEN).toBe("ghp_secret");
  });

  test("docker mode spawns the fake docker binary with the sandbox argv", async () => {
    const root = await tempDir();
    const fake = await writeRecordingDocker(root);
    const env = dirtyEnv();
    const docker = {
      agent: "claude" as const,
      worktree,
      proxyUrl: "http://127.0.0.1:9",
      bin: fake.bin,
      uid: 1000,
      gid: 1000,
    };
    const plan = buildDockerRun({
      ...docker,
      command: "claude-agent-acp",
      args: ["--verbose"],
      hostEnv: env,
    });
    const child = spawnAgent("claude-agent-acp", ["--verbose"], env, { docker });
    await waitExit(child);
    const [record] = await readDockerRecords(fake.record);
    if (!record) throw new Error("docker did not record an invocation");
    expect(record.argv).toEqual(plan.args);
    expect(record.argv[record.argv.indexOf("--network") + 1]).toBe("none");
    expect(record.argv).toContain("HTTPS_PROXY=http://127.0.0.1:9");
    expect(record.argv.filter((arg) => arg.startsWith("type=bind,"))).toEqual([
      `type=bind,src=${worktree},dst=${worktree}`,
    ]);
    const flat = record.argv.join("\n");
    expect(flat).not.toContain("sk-ant-secret");
    expect(flat).not.toContain("ghp_secret");
    expect(flat).not.toContain("/tmp/ssh-agent.sock");
    expect(flat).not.toContain("docker.sock");
    expect(flat).not.toContain("HOME=/Users/dev");
    expect(record.env.HOME).toBeUndefined();
    expect(record.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(record.env.OPENAI_API_KEY).toBeUndefined();
    expect(record.env.GITHUB_TOKEN).toBeUndefined();
    expect(record.env.GH_TOKEN).toBeUndefined();
    expect(record.env.SSH_AUTH_SOCK).toBeUndefined();
    expect(record.env.PATH).toBe(plan.env.PATH);
  });
});

async function waitExit(child: ChildProcess): Promise<void> {
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdout?.resume();
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out: ${stderr}`)), 5_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  if (code !== 0) throw new Error(`spawn exited ${code}: ${stderr}`);
}

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "paws-spawn-"));
  roots.push(root);
  return root;
}
