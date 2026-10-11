import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { buildDockerRun, readDockerRecords, writeRecordingDocker } from "../sandbox";
import { killTree, spawnAgent, stopChild, waitForExit } from "./process";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("an exited historical child never signals its former process group", async () => {
  const child = { pid: 987654, exitCode: 0, signalCode: null } as ChildProcess;
  const kill = spyOn(process, "kill").mockImplementation(() => true);
  try {
    killTree(child, "SIGTERM");
    expect(await stopChild(child, 10)).toBe(true);
    expect(kill).not.toHaveBeenCalled();
  } finally {
    kill.mockRestore();
  }
});

test.skipIf(process.platform !== "linux")(
  "shutdown stops a captured stubborn descendant after its leader exits",
  async () => {
    const { child, descendant } = await processFamily();
    const kill = spyOn(process, "kill");
    try {
      expect(await stopChild(child, 100)).toBe(true);
      expect(kill).toHaveBeenCalledWith(-child.pid!, "SIGTERM");
      expect(kill).toHaveBeenCalledWith(descendant, "SIGKILL");
      expect(kill).not.toHaveBeenCalledWith(-child.pid!, "SIGKILL");
      await waitUntilStopped(descendant);
    } finally {
      kill.mockRestore();
      killTree(child, "SIGKILL");
      await waitForExit(child, 100);
      if (running(descendant)) process.kill(descendant, "SIGKILL");
    }
  },
);

test.skipIf(process.platform !== "linux")(
  "post-exit cleanup skips a captured PID whose start-time identity changed",
  async () => {
    const { child, descendant } = await processFamily();
    killTree(child, "SIGCONT");
    child.kill("SIGTERM");
    expect(await waitForExit(child, 1000)).toBe(true);
    const originalRead = fs.readFileSync;
    const read = spyOn(fs, "readFileSync").mockImplementation(((
      ...args: Parameters<typeof fs.readFileSync>
    ) => {
      const value = originalRead(...args);
      if (String(args[0]) !== `/proc/${descendant}/stat`) return value;
      const text = String(value);
      const end = text.lastIndexOf(")") + 2;
      const fields = text.slice(end).split(" ");
      fields[19] = String(BigInt(fields[19]!) + 1n);
      return text.slice(0, end) + fields.join(" ");
    }) as typeof fs.readFileSync);
    const kill = spyOn(process, "kill");
    try {
      expect(await stopChild(child, 100)).toBe(true);
      expect(kill).not.toHaveBeenCalled();
      expect(running(descendant)).toBe(true);
    } finally {
      read.mockRestore();
      kill.mockRestore();
      if (running(descendant)) process.kill(descendant, "SIGKILL");
    }
  },
);

test.skipIf(process.platform !== "linux")(
  "shutdown retries captured descendants when group signalling observes leader exit",
  async () => {
    const { child, descendant } = await processFamily();
    const originalKill = process.kill;
    const kill = spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === -child.pid! && signal === "SIGTERM") {
        child.kill("SIGKILL");
        Object.defineProperty(child, "exitCode", { value: 0, configurable: true });
        throw Object.assign(new Error("group disappeared"), { code: "ESRCH" });
      }
      return originalKill(pid, signal);
    });
    try {
      expect(await stopChild(child, 100)).toBe(true);
      expect(kill).toHaveBeenCalledWith(descendant, "SIGKILL");
      await waitUntilStopped(descendant);
    } finally {
      kill.mockRestore();
      if (running(child.pid!)) originalKill(child.pid!, "SIGKILL");
      if (running(descendant)) originalKill(descendant, "SIGKILL");
    }
  },
);

async function processFamily(): Promise<{ child: ChildProcess; descendant: number }> {
  const root = await tempDir();
  const pidFile = join(root, "descendant.pid");
  const script = `process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`;
  const child = spawnAgent(
    process.execPath,
    [
      "-e",
      `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(script)}], { stdio: 'ignore' }); setInterval(() => {}, 1000)`,
    ],
    { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root },
  );
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      return { child, descendant: Number(fs.readFileSync(pidFile, "utf8")) };
    } catch {
      await Bun.sleep(10);
    }
  }
  await stopChild(child, 100);
  throw new Error("descendant did not start");
}

function running(pid: number): boolean {
  try {
    const text = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return !["Z", "X"].includes(text.slice(text.lastIndexOf(")") + 2).split(" ")[0]!);
  } catch {
    return false;
  }
}

async function waitUntilStopped(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100 && running(pid); attempt += 1) await Bun.sleep(10);
  expect(running(pid)).toBe(false);
}

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
