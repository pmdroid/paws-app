import { describe, expect, test } from "bun:test";
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  closeoutPolicyRoot,
  databaseUrlOf,
  emptyConfigFile,
  ensureLayout,
  loadConfigFile,
  loadEnv,
  loadRuntime,
  parseConfigToml,
  pawsPaths,
  readMergeSettings,
  startupSettings,
  useMemorySettings,
} from "../src/config";
import { DEFAULT_MAX_AWAKE_MS } from "../src/core";
import { tempHome } from "./helpers";

describe("config", () => {
  test("Closeout roots load", () => {
    const paths = pawsPaths(tempHome());
    ensureLayout(paths);
    useMemorySettings(
      paths.configFile,
      '[closeout.projects."acme/one"]\npolicy_root = "policies/one"\n\n[merge]\nmain_moved = "closeout"\n',
    );
    expect(readMergeSettings(loadConfigFile(paths.configFile)).default.mainMoved).toBe("closeout");
    expect(closeoutPolicyRoot(loadConfigFile(paths.configFile), paths.home, "Acme/One")).toBe(
      join(paths.home, "policies/one"),
    );
    expect(
      closeoutPolicyRoot(loadConfigFile(paths.configFile), paths.home, "acme/two"),
    ).toBeUndefined();
  });
  test("local Closeout settings reject malformed project roots", () => {
    for (const text of [
      '[closeout.projects."acme/repo"]\npolicy_root = ""',
      '[closeout.projects."acme/repo"]\npolicy_root = false',
      '[closeout.projects."acme/repo"]\npolicy_rot = "foo"',
      '[closeout.projects.acme]\npolicy_root = "foo"',
    ])
      expect(() => parseConfigToml(text)).toThrow();
    const config = parseConfigToml(
      '[closeout.projects."Acme/Repo"]\npolicy_root = "/tmp/policies"',
    );
    expect(closeoutPolicyRoot(config, "/tmp/paws", "acme/repo")).toBe("/tmp/policies");
  });
  test("defaults to localhost and ~/.paws", () => {
    const env = loadEnv({});
    expect(env.host).toBe("127.0.0.1");
    expect(env.port).toBe(8787);
    expect(env.home.endsWith(".paws")).toBe(true);
    expect(env.linearWebhookSecret).toBeNull();
    expect(env.githubAppId).toBeNull();
  });

  test("tasks default to three hours and retain explicit time limits", () => {
    const paths = pawsPaths(tempHome());
    ensureLayout(paths);
    expect(loadRuntime({ PAWS_HOME: paths.home }).maxAwakeMs).toBe(3 * 60 * 60 * 1000);
    expect(loadRuntime({ PAWS_HOME: paths.home, PAWS_MAX_AWAKE_MS: "7200000" }).maxAwakeMs).toBe(
      2 * 60 * 60 * 1000,
    );
  });

  test("loads the operator's Linear organization binding from the environment", () => {
    const home = tempHome();
    expect(loadRuntime({ PAWS_HOME: home }).linearOrganizationId).toBeNull();
    expect(
      loadRuntime({ PAWS_HOME: home, LINEAR_ORGANIZATION_ID: "  org-operator  " })
        .linearOrganizationId,
    ).toBe("org-operator");
    expect(
      loadRuntime({ PAWS_HOME: home, LINEAR_ORGANIZATION_ID: "  " }).linearOrganizationId,
    ).toBeNull();
  });

  test("reads overrides and rejects a bad port", () => {
    const env = loadEnv({
      PAWS_HOME: "/tmp/paws-home",
      PAWS_HOST: "127.0.0.1",
      PAWS_PORT: "0",
      PAWS_PUBLIC_URL: "https://example.ngrok-free.app",
      LINEAR_WEBHOOK_SECRET: "secret",
      GITHUB_APP_ID: "1",
      GITHUB_APP_INSTALLATION_ID: "2",
      GITHUB_APP_PRIVATE_KEY_PATH: "/tmp/key.pem",
      GITHUB_WEBHOOK_SECRET: "gh",
    });
    expect(env).toMatchObject({
      home: "/tmp/paws-home",
      port: 0,
      publicUrl: "https://example.ngrok-free.app",
      linearWebhookSecret: "secret",
      githubAppId: "1",
      githubAppInstallationId: "2",
      githubAppPrivateKeyPath: "/tmp/key.pem",
      githubWebhookSecret: "gh",
    });
    expect(() => loadEnv({ PAWS_PORT: "nope" })).toThrow(/PAWS_PORT/);
  });

  test("layout paths and secret directory mode", () => {
    const home = tempHome();
    const paths = pawsPaths(home);
    expect(paths.db).toBe(join(home, "paws.db"));
    expect(paths.configFile).toBe(join(home, "config.toml"));
    expect(paths.secretsDir).toBe(join(home, "secrets"));
    expect(paths.worktreesDir).toBe(join(home, "worktrees"));
    ensureLayout(paths);
    ensureLayout(paths);
    expect(statSync(paths.secretsDir).mode & 0o777).toBe(0o700);
    expect(statSync(paths.home).mode & 0o777).toBe(0o700);
  });

  test("missing config.toml is empty", () => {
    const home = tempHome();
    const paths = pawsPaths(home);
    expect(loadConfigFile(paths.configFile)).toEqual(emptyConfigFile());
  });

  test("a config.toml on disk is not read: startup values come from their variables", () => {
    const home = tempHome();
    const paths = pawsPaths(home);
    ensureLayout(paths);
    writeFileSync(
      paths.configFile,
      '[linear]\nteam = "ENG"\nteam_id = "team_eng"\nviewer_id = "viewer_1"\nwebhooks = true\n\n[github]\nrepo = "acme/file"\n\n[database]\nurl = "postgres://file@localhost/paws"\n\n[server]\npublic_url = "https://file.example"\n',
    );
    expect(databaseUrlOf({ PAWS_HOME: home })).toBeNull();
    expect(startupSettings({ PAWS_HOME: home }).publicUrl).toBeNull();
    const runtime = loadRuntime({ PAWS_HOME: home });
    expect(runtime.configError).toBeNull();
    expect(runtime.databaseUrl).toBeNull();
    expect(runtime.linearTeam).toBeNull();
    expect(runtime.linearTeamId).toBeNull();
    expect(runtime.linearViewerId).toBeNull();
    expect(runtime.repos).toEqual([]);
    expect(runtime.publicUrl).toBeNull();
    expect(runtime.webhooks).toBe(false);
    expect(runtime.githubAuth).toBe("app");
    expect(runtime.maxAwakeMs).toBe(DEFAULT_MAX_AWAKE_MS);

    const set = loadRuntime({
      PAWS_HOME: home,
      PAWS_DATABASE_URL: "postgres://env@localhost/paws",
      LINEAR_TEAM: "OPS",
      LINEAR_TEAM_ID: "team_ops",
      LINEAR_APP_USER_ID: "viewer_2",
      LINEAR_WEBHOOKS: "1",
      PAWS_GITHUB_REPOS: "acme/env",
      PAWS_PUBLIC_URL: "https://env.example",
      LINEAR_ACCESS_TOKEN: "lin_oauth_from_env",
    });
    expect(set).toMatchObject({
      databaseUrl: "postgres://env@localhost/paws",
      linearTeam: "OPS",
      linearTeamId: "team_ops",
      linearViewerId: "viewer_2",
      webhooks: true,
      repos: ["acme/env"],
      publicUrl: "https://env.example",
      linearAccessToken: "lin_oauth_from_env",
    });
  });

  test("PAWS_GITHUB_REPOS names the startup repositories", () => {
    const paths = pawsPaths(tempHome());
    ensureLayout(paths);
    const set = loadRuntime({ PAWS_HOME: paths.home, PAWS_GITHUB_REPOS: "acme/a, acme/b,acme/a" });
    expect(set.repos).toEqual(["acme/a", "acme/b"]);
    expect(set.configError).toBeNull();
    const invalid = loadRuntime({ PAWS_HOME: paths.home, PAWS_GITHUB_REPOS: "acme" });
    expect(invalid.configError).toContain("PAWS_GITHUB_REPOS");
    expect(invalid.configError).toContain("acme");
    expect(loadRuntime({ PAWS_HOME: paths.home }).repos).toEqual([]);
  });

  test("unknown keys and sections fail with plain config errors", () => {
    for (const section of ["merge", "project_memory"]) {
      expect(() => parseConfigToml(`[${section}]\nunknown = true\n`)).toThrow(
        `Saved settings line 2 has an unknown key: ${section}.unknown`,
      );
    }
    expect(() => parseConfigToml("[unknown]\n")).toThrow(
      "Saved settings line 1 has an unknown section: unknown",
    );
    const paths = pawsPaths(tempHome());
    ensureLayout(paths);
    useMemorySettings(paths.configFile, "[merge]\nunknown = true\n");
    expect(loadRuntime({ PAWS_HOME: paths.home }).configError).toBe(
      "Saved settings line 2 has an unknown key: merge.unknown",
    );
  });

  test("an [update] section is an unknown section", () => {
    expect(() =>
      parseConfigToml('[agents]\nimplementer = "codex"\n\n[update]\nautomatic = false\n'),
    ).toThrow("Saved settings line 4 has an unknown section: update");
  });

  test("missing config.toml defaults the implementer to claude", () => {
    const home = tempHome();
    const paths = pawsPaths(home);
    expect(loadConfigFile(paths.configFile).agents).toEqual({ implementer: "claude" });
  });

  test("parses agents.implementer", () => {
    const home = tempHome();
    const paths = pawsPaths(home);
    ensureLayout(paths);
    useMemorySettings(paths.configFile, '[agents]\nimplementer = "grok"\n');
    expect(loadConfigFile(paths.configFile).agents).toEqual({ implementer: "grok" });
    useMemorySettings(paths.configFile, '[agents]\nimplementer = "gpt"\n');
    expect(() => loadConfigFile(paths.configFile)).toThrow(/claude, grok, codex, or opencode/);
  });

  test("agents.grok and agents.opencode are unknown sections", () => {
    expect(() =>
      parseConfigToml('[agents]\nimplementer = "grok"\n\n[agents.grok]\npath = "/opt/grok"\n'),
    ).toThrow("Saved settings line 4 has an unknown section: agents.grok");
    expect(() => parseConfigToml('[agents.opencode]\npath = "/opt/opencode"\n')).toThrow(
      "Saved settings line 1 has an unknown section: agents.opencode",
    );
  });

  test("saved settings with a startup or retired section fail with the unknown-section error", () => {
    for (const section of ["database", "linear", "github", "tracker", "checkout", "caps", "server"])
      expect(() => parseConfigToml(`[${section}]\nurl = "x"\n`)).toThrow(
        `Saved settings line 1 has an unknown section: ${section}`,
      );
  });
});
