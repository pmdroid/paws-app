import type { OwnedProcess } from "./process";
import * as fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { killTree, spawnAgent, stopChild, waitForExit } from "./process";

const roots: string[] = [];
// The descendants ignore SIGTERM, so stopping waits this long before SIGKILL
// and then up to as long again for the group to close on a loaded machine.
const STOP_GRACE_MS = 500;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("an exited ownership anchor never signals its former process group", async () => {
  const root = await tempDir();
  const child = spawnAgent(process.execPath, ["-e", "process.exit(0)"], {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: root,
  });
  await waitExit(child);
  expect(await stopChild(child, 100)).toBe(true);
  const kill = spyOn(process, "kill").mockImplementation(() => true);
  try {
    killTree(child, "SIGTERM");
    expect(await stopChild(child, 10)).toBe(true);
    expect(child.kill("SIGTERM")).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  } finally {
    kill.mockRestore();
  }
});

test.skipIf(process.platform === "win32")(
  "shutdown stops stubborn descendants even when the command exits first",
  async () => {
    const { child, descendant } = await processFamily();
    try {
      child.kill("SIGTERM");
      expect(await waitForExit(child, 10_000)).toBe(true);
      expect(running(descendant)).toBe(true);
      expect(await stopChild(child, STOP_GRACE_MS)).toBe(true);
      await waitUntilStopped(descendant);
    } finally {
      await stopChild(child, STOP_GRACE_MS);
      if (running(descendant)) process.kill(descendant, "SIGKILL");
    }
  },
);

test.skipIf(process.platform === "win32")(
  "shutdown retains group ownership when the command exits during graceful shutdown",
  async () => {
    const { child, descendant } = await processFamily();
    try {
      expect(await stopChild(child, STOP_GRACE_MS)).toBe(true);
      await waitUntilStopped(descendant);
    } finally {
      await stopChild(child, STOP_GRACE_MS);
      if (running(descendant)) process.kill(descendant, "SIGKILL");
    }
  },
);

test.skipIf(process.platform === "win32")(
  "lost ownership fails cleanup without signalling a historical group",
  async () => {
    const { child, descendant, leader } = await processFamily();
    try {
      process.kill(child.pid!, "SIGKILL");
      await Bun.sleep(30);
      const kill = spyOn(process, "kill");
      try {
        const started = performance.now();
        expect(await stopChild(child, 50)).toBe(false);
        expect(performance.now() - started).toBeLessThan(1_000);
        killTree(child, "SIGKILL");
        expect(kill).not.toHaveBeenCalled();
        expect(running(descendant)).toBe(true);
      } finally {
        kill.mockRestore();
      }
    } finally {
      if (running(leader)) process.kill(leader, "SIGKILL");
      if (running(descendant)) process.kill(descendant, "SIGKILL");
    }
  },
  // With its anchor killed, stop() waits the full 5 s kill confirmation before it reports
  // false, so this test needs more than Bun's default 5 s.
  15_000,
);

test.skipIf(process.platform === "win32")(
  "shutdown lets descendants finish their own SIGTERM handling after the command exits",
  async () => {
    const root = await tempDir();
    const pidFile = join(root, "descendant.pid");
    const saved = join(root, "saved");
    const script = `const fs = require('fs'); process.on('SIGTERM', () => setTimeout(() => { fs.writeFileSync(${JSON.stringify(saved)}, 'ok'); process.exit(0); }, 300)); fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`;
    const child = spawnAgent(
      process.execPath,
      [
        "-e",
        `process.on('SIGTERM', () => process.exit(0)); require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(script)}], { stdio: 'ignore' }); setInterval(() => {}, 1000)`,
      ],
      { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root },
    );
    for (let attempt = 0; attempt < 200 && !fs.existsSync(pidFile); attempt += 1)
      await Bun.sleep(10);
    expect(await stopChild(child, 2000)).toBe(true);
    expect(fs.readFileSync(saved, "utf8")).toBe("ok");
  },
);

async function processFamily(): Promise<{
  child: OwnedProcess;
  descendant: number;
  leader: number;
}> {
  const root = await tempDir();
  const pidFile = join(root, "descendant.pid");
  const leaderFile = join(root, "leader.pid");
  const script = `process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`;
  const child = spawnAgent(
    process.execPath,
    [
      "-e",
      `require('fs').writeFileSync(${JSON.stringify(leaderFile)}, String(process.pid)); require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(script)}], { stdio: 'ignore' }); setInterval(() => {}, 1000)`,
    ],
    { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root },
  );
  for (const deadline = performance.now() + 10_000; performance.now() < deadline;) {
    try {
      const descendant = Number(fs.readFileSync(pidFile, "utf8"));
      const leader = Number(fs.readFileSync(leaderFile, "utf8"));
      if (
        Number.isSafeInteger(descendant) &&
        descendant > 0 &&
        Number.isSafeInteger(leader) &&
        leader > 0
      )
        return { child, descendant, leader };
    } catch {}
    await Bun.sleep(10);
  }
  await stopChild(child, 100);
  throw new Error("descendant did not start");
}

function running(pid: number): boolean {
  if (process.platform !== "linux") {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  try {
    const text = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return !["Z", "X"].includes(text.slice(text.lastIndexOf(")") + 2).split(" ")[0]!);
  } catch {
    return false;
  }
}

async function waitUntilStopped(pid: number): Promise<void> {
  // The test timeout bounds a loaded machine.
  while (running(pid)) await Bun.sleep(10);
}

describe("spawnAgent", () => {
  test("starts the requested host command with its arguments, environment and stdio", async () => {
    const root = await tempDir();
    const record = join(root, "command.json");
    const env = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: root,
      PAWS_TEST_VALUE: "host-command",
    };
    const script = `require("fs").writeFileSync(process.argv[1], JSON.stringify({argv: process.argv.slice(2), home: process.env.HOME, value: process.env.PAWS_TEST_VALUE}));`;
    for (const options of [undefined, {}]) {
      const child = spawnAgent(process.execPath, ["-e", script, record, "--flag"], env, options);
      await waitExit(child);
      expect(JSON.parse(fs.readFileSync(record, "utf8"))).toEqual({
        argv: ["--flag"],
        home: root,
        value: "host-command",
      });
      expect(child.stdin).not.toBeNull();
      expect(child.stdout).not.toBeNull();
    }
  });

  test("the ownership anchor ignores worktree Bun preloads and preserves the actual command cwd", async () => {
    const root = await tempDir();
    const marker = join(root, "host-preload");
    const record = join(root, "command-cwd");
    fs.writeFileSync(join(root, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
    fs.writeFileSync(
      join(root, "preload.ts"),
      `require("fs").writeFileSync(${JSON.stringify(marker)}, "host");`,
    );
    const child = spawnAgent(
      "/bin/sh",
      ["-c", 'pwd > "$1"', "paws-cwd", record],
      { PATH: process.env.PATH! },
      { cwd: root },
    );
    await waitExit(child);
    expect(fs.readFileSync(record, "utf8").trim()).toBe(root);
    expect(fs.existsSync(marker)).toBe(false);
  });
});

async function waitExit(child: OwnedProcess): Promise<void> {
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
  expect(await stopChild(child, 100)).toBe(true);
}

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "paws-spawn-"));
  roots.push(root);
  return root;
}
