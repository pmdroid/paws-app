import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { accountHomeEnv, minimalAgentEnv } from "../src/acp";
import {
  markRunnerAccountSignedIn,
  openRunnerAccountHome,
  returnRunnerAgentCredentials,
  runnerAccountCache,
  runnerCredentialsLeft,
} from "../src/runner-execution";

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

test("an OpenCode turn on a tmpfs leaves no credential in opencode.db", () => {
  const memory = mkdtempSync("/dev/shm/paws-opencode-home-");
  try {
    chmodSync(memory, 0o770);
    const account = { accountId: "account-1", bindingId: "binding-1" };
    const home = openRunnerAccountHome(memory, account, "opencode", { signIn: true });
    markRunnerAccountSignedIn(home, account, "opencode");
    const path = join(home, ".local/share/opencode/opencode.db");
    mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    db.run("PRAGMA journal_mode = WAL");
    db.run(
      "CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT, active INTEGER, time_created INTEGER, time_updated INTEGER)",
    );
    db.run("INSERT INTO credential VALUES ('cred_1', 'opencode', 'OAuth', ?, 1, 1, 1)", [
      "opencode-refresh-secret-".repeat(20),
    ]);
    db.close();
    expect(runnerCredentialsLeft(memory)).toEqual(["binding-1/.local/share/opencode/opencode.db"]);

    returnRunnerAgentCredentials(home, "opencode", "01J0000000000000000000EXE1", () => {});

    expect(runnerCredentialsLeft(memory)).toEqual([]);
    for (const file of [path, `${path}-wal`])
      if (existsSync(file))
        expect(readFileSync(file).includes("opencode-refresh-secret-")).toBe(false);
  } finally {
    rmSync(memory, { recursive: true, force: true });
  }
});
