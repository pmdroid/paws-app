import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountHomeEnv, minimalAgentEnv } from "../src/acp";
import { runnerAccountCache } from "../src/runner-execution";

test("an account home on a tmpfs keeps the agent caches on disk", () => {
  const agentHome = mkdtempSync(join(tmpdir(), "paws-agent-home-"));
  const memory = mkdtempSync("/dev/shm/paws-account-home-");
  try {
    const disk = join(agentHome, ".paws-accounts", "binding-1");
    mkdirSync(disk, { recursive: true });
    expect(runnerAccountCache(agentHome, disk)).toBeNull();
    expect(accountHomeEnv(disk, null).XDG_CACHE_HOME).toBe(join(disk, ".cache"));

    const home = join(memory, "binding-1");
    mkdirSync(home);
    const cache = runnerAccountCache(agentHome, home)!;
    expect(cache).toBe(join(agentHome, ".paws-account-caches", "binding-1"));
    expect(existsSync(cache)).toBe(true);
    const env = minimalAgentEnv(accountHomeEnv(home, cache));
    expect(env).toMatchObject({
      HOME: home,
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      XDG_CACHE_HOME: cache,
      BUN_INSTALL_CACHE_DIR: join(cache, "bun"),
      npm_config_cache: join(cache, "npm"),
      PIP_CACHE_DIR: join(cache, "pip"),
      GOMODCACHE: join(cache, "go-mod"),
    });
  } finally {
    rmSync(agentHome, { recursive: true, force: true });
    rmSync(memory, { recursive: true, force: true });
  }
});
