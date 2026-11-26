import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sandboxedLaunch } from "../src/acp/sandbox";

function starts(): boolean {
  const root = mkdtempSync(join(homedir(), ".paws-sandbox-probe-"));
  try {
    mkdirSync(join(root, "scratch"));
    const launch = sandboxedLaunch({
      agent: "codex",
      command: "/bin/echo",
      args: ["ok"],
      env: { PATH: "/usr/bin:/bin" },
      cwd: root,
      scratch: join(root, "scratch"),
      home: root,
    });
    const run = spawnSync(launch.command, launch.args, {
      env: launch.env,
      encoding: "utf8",
      timeout: 30_000,
    });
    return run.status === 0 && run.stdout.trim() === "ok";
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export const helperSandboxStarts = starts();
