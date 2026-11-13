import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  closeoutPolicyRoot,
  emptyConfigFile,
  ensureLayout,
  loadConfigFile,
  loadEnv,
  loadRuntime,
  parseConfigToml,
  pawsPaths,
  readMergeSettings,
} from "../src/config";
import { DEFAULT_MAX_AWAKE_MS } from "../src/core";
import { tempHome } from "./helpers";

describe("config", () => {
  test("configured repository candidates and Closeout roots load", () => {
    const paths = pawsPaths(tempHome());
    ensureLayout(paths);
    writeFileSync(
      paths.configFile,
      '[github]\nrepo = "acme/one"\nrepos = ["acme/one", "acme/two"]\n\n[closeout.projects."acme/one"]\npolicy_root = "policies/one"\n\n[merge]\nmain_moved = "closeout"\n',
      { mode: 0o600 },
    );
    expect(loadConfigFile(paths.configFile).githubRepos).toEqual(["acme/one", "acme/two"]);
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
    writeFileSync(paths.configFile, "[caps]\nmax_awake_ms = 3600000\n");
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

  test("a retired turn cap in config.toml or the environment loads and is not configured", () => {
    const home = tempHome();
    const paths = pawsPaths(home);
    ensureLayout(paths);
    writeFileSync(paths.configFile, "[caps]\nmax_turns = 2\nmax_awake_ms = 5000\n", {
      mode: 0o600,
    });
    const parsed = loadConfigFile(paths.configFile);
    expect(parsed.maxAwakeMs).toBe(5_000);
    expect(parsed).not.toHaveProperty("maxTurns");
    const runtime = loadRuntime({ PAWS_HOME: home, PAWS_MAX_TURNS: "3" });
    expect(runtime.maxAwakeMs).toBe(DEFAULT_MAX_AWAKE_MS);
    expect(runtime).not.toHaveProperty("maxTurns");
  });

  test("missing config.toml is empty", () => {
    const home = tempHome();
    const paths = pawsPaths(home);
    expect(loadConfigFile(paths.configFile)).toEqual(emptyConfigFile());
  });

  test("config.toml is the source and env overrides one field", () => {
    const home = tempHome();
    const paths = pawsPaths(home);
    ensureLayout(paths);
    writeFileSync(
      paths.configFile,
      '[linear]\nteam = "ENG"\nteam_id = "team_eng"\nviewer_id = "viewer_1"\nsecret = "secrets/acme-linear.json"\n\n[github]\nrepo = "pmdroid/paws-demo"\n\n[caps]\nmax_awake_ms = 1000\n',
      { mode: 0o600 },
    );
    mkdirSync(paths.secretsDir, { recursive: true });
    writeFileSync(
      join(paths.secretsDir, "acme-linear.json"),
      JSON.stringify({ accessToken: "lin_oauth_from_file" }),
      { mode: 0o600 },
    );
    chmodSync(join(paths.secretsDir, "acme-linear.json"), 0o600);

    const parsed = loadConfigFile(paths.configFile);
    expect(parsed.linearTeam).toBe("ENG");
    expect(parsed.repo).toBe("pmdroid/paws-demo");
    expect(parsed.maxAwakeMs).toBe(1_000);

    const runtime = loadRuntime({
      PAWS_HOME: home,
      PAWS_GITHUB_REPOSITORY: "other/repo",
      PAWS_CHECKOUT: "/elsewhere",
    });
    expect(runtime.configured).toBe(true);
    expect(runtime.linearAccessToken).toBeNull();
    expect(runtime.linearTokenFile).toBe(join(paths.secretsDir, "acme-linear.json"));
    expect(runtime.repos).toEqual(["pmdroid/paws-demo"]);
    expect(runtime.githubAuth).toBe("app");
    expect(runtime.maxAwakeMs).toBe(DEFAULT_MAX_AWAKE_MS);
    expect(runtime.webhooks).toBe(false);

    const overridden = loadRuntime({
      PAWS_HOME: home,
      LINEAR_ACCESS_TOKEN: "lin_oauth_from_env",
    });
    expect(overridden.linearAccessToken).toBe("lin_oauth_from_env");
  });

  test("unknown keys and sections fail with plain config errors", () => {
    for (const section of ["linear", "merge"]) {
      expect(() => parseConfigToml(`[${section}]\nunknown = true\n`)).toThrow(
        `config.toml line 2 has an unknown key: ${section}.unknown`,
      );
    }
    expect(() => parseConfigToml("[unknown]\n")).toThrow(
      "config.toml line 1 has an unknown section: unknown",
    );
    const paths = pawsPaths(tempHome());
    ensureLayout(paths);
    writeFileSync(paths.configFile, "[linear]\nunknown = true\n");
    expect(loadRuntime({ PAWS_HOME: paths.home }).configError).toBe(
      "config.toml line 2 has an unknown key: linear.unknown",
    );
  });

  test("the retired [update] section from older installs is ignored, not fatal", () => {
    const config = parseConfigToml(
      '[agents]\nimplementer = "codex"\n\n[update]\nautomatic = false\n\n[merge]\norder = "queue"\n',
    );
    expect(config).toEqual(
      parseConfigToml('[agents]\nimplementer = "codex"\n\n[merge]\norder = "queue"\n'),
    );
  });

  test("missing config.toml defaults the implementer to claude", () => {
    const home = tempHome();
    const paths = pawsPaths(home);
    expect(loadConfigFile(paths.configFile).agents).toEqual({
      implementer: "claude",
      grok: { path: null, allowApiKey: false },
    });
  });

  test("parses agents.implementer and grok settings", () => {
    const home = tempHome();
    const paths = pawsPaths(home);
    ensureLayout(paths);
    writeFileSync(
      paths.configFile,
      [
        'repo = "pmdroid/paws-demo"',
        "",
        "[agents]",
        'implementer = "grok"',
        "",
        "[agents.grok]",
        'path = "/opt/grok"',
        "allow_api_key = true",
        "",
      ].join("\n"),
    );
    const parsed = loadConfigFile(paths.configFile);
    expect(parsed.repo).toBe("pmdroid/paws-demo");
    expect(parsed.agents).toEqual({
      implementer: "grok",
      grok: { path: "/opt/grok", allowApiKey: true },
    });
    writeFileSync(paths.configFile, '[agents]\nimplementer = "gpt"\n');
    expect(() => loadConfigFile(paths.configFile)).toThrow(/claude, grok, codex, or opencode/);
  });

  test("parses agents.opencode path", () => {
    const home = tempHome();
    const paths = pawsPaths(home);
    ensureLayout(paths);
    writeFileSync(
      paths.configFile,
      [
        "[agents]",
        'implementer = "opencode"',
        "",
        "[agents.opencode]",
        'path = "/opt/opencode"',
        "",
      ].join("\n"),
    );
    const parsed = loadConfigFile(paths.configFile);
    expect(parsed.agents.implementer).toBe("opencode");
    expect(parsed.agents.opencode).toEqual({ path: "/opt/opencode" });
  });

  test("old configs without github.auth or tracker load as the App and linear", () => {
    const home = tempHome();
    const paths = pawsPaths(home);
    ensureLayout(paths);
    writeFileSync(paths.configFile, 'repo = "pmdroid/paws-demo"\n', { mode: 0o600 });
    const runtime = loadRuntime({ PAWS_HOME: home });
    expect(runtime.githubAuth).toBe("app");
    expect(runtime.trackerKind).toBe("linear");
  });

  test("retired [tracker] kind, [checkout] path and github.auth load and are ignored", () => {
    const home = tempHome();
    const paths = pawsPaths(home);
    ensureLayout(paths);
    const retired =
      '[github]\nauth = "oauth"\nrepo = "pmdroid/paws-demo"\n\n[tracker]\nkind = "jira"\n\n[checkout]\npath = "/repo"\n';
    writeFileSync(paths.configFile, retired, { mode: 0o600 });
    const runtime = loadRuntime({ PAWS_HOME: home });
    expect(runtime.configError).toBeNull();
    expect(runtime.githubAuth).toBe("app");
    expect(runtime.trackerKind).toBe("linear");
    expect(parseConfigToml(retired)).toEqual(
      parseConfigToml('[github]\nrepo = "pmdroid/paws-demo"\n'),
    );
  });
});
