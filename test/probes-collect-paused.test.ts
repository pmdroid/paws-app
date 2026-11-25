import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROBES_COLLECT_PAUSED, PROBES_USAGE } from "../src/probe-collector";

test("paws probes collect stops before any agent turn and names the steps it waits for", () => {
  const root = mkdtempSync(join(tmpdir(), "paws-probes-paused-"));
  try {
    const home = join(root, "home");
    const run = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, "../src/index.ts"), "probes", "collect", "acme/web"],
      {
        cwd: root,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PAWS_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(run.exitCode).toBe(1);
    expect(run.stderr.toString()).toContain(PROBES_COLLECT_PAUSED);
    expect(run.stdout.toString()).toBe("");
    expect(existsSync(home)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  expect(PROBES_COLLECT_PAUSED).toContain("Settings › Agent accounts");
  expect(PROBES_COLLECT_PAUSED).toContain("Left for later parts of PAS-2432");
  expect(PROBES_USAGE.toLowerCase()).not.toContain("on this machine");
}, 20_000);
