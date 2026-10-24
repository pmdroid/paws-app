import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  closeoutPolicyRoot,
  emptyConfigFile,
  ensureLayout,
  loadConfigFile,
  loadEnv,
  loadRuntime,
  parseConfigToml,
  PAWS_GITHUB_OAUTH_CLIENT_ID,
  pawsPaths,
  renderConfigToml,
  writeConfigFile,
  writeImplementer,
  readMergeSettings,
} from "../src/config";
import { tempHome } from "./helpers";

describe("config", () => {
  test("configured repository candidates survive setup rewrites", () => {
    const paths = pawsPaths(tempHome());
    ensureLayout(paths);
    const setup = {
      linearTeam: "ENG",
      linearTeamId: "team",
      linearViewerId: "human",
      linearSecret: "secrets/linear-api-key",
      linearClientFile: null,
      githubAuth: "gh" as const,
      repo: "acme/one",
      checkout: paths.home,
      maxTurns: 40,
      maxAwakeMs: 1_000,
      implementer: "claude" as const,
    };
    const text = renderConfigToml({
      ...setup,
      githubRepos: ["acme/one", "acme/two"],
      closeoutProjects: { "acme/one": "policies/one" },
    });
    expect(parseConfigToml(text).githubRepos).toEqual(["acme/one", "acme/two"]);
    writeFileSync(paths.configFile, `${text}\n[merge]\ncloseout_after_update = true\n`, {
      mode: 0o600,
    });
    writeConfigFile(paths.configFile, { ...setup, maxTurns: 50 });
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
    expect(loadRuntime({ PAWS_HOME: paths.home }).maxAwakeMs).toBe(60 * 60 * 1000);
    expect(loadRuntime({ PAWS_HOME: paths.home, PAWS_MAX_AWAKE_MS: "7200000" }).maxAwakeMs).toBe(
      2 * 60 * 60 * 1000,
    );
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

  test("setup config.toml is the source and env overrides one field", () => {
    const home = tempHome();
    const paths = pawsPaths(home);
    ensureLayout(paths);
    writeConfigFile(paths.configFile, {
      linearTeam: "ENG",
      linearTeamId: "team_eng",
      linearViewerId: "viewer_1",
      linearSecret: "secrets/linear-oauth.json",
      linearClientFile: null,
      githubAuth: "gh",
      repo: "pmdroid/paws-demo",
      checkout: home,
      maxTurns: 40,
      maxAwakeMs: 1_000,
      implementer: "claude",
    });
    mkdirSync(paths.secretsDir, { recursive: true });
    writeFileSync(
      join(paths.secretsDir, "linear-oauth.json"),
      JSON.stringify({ accessToken: "lin_oauth_from_file" }),
      { mode: 0o600 },
    );
    chmodSync(join(paths.secretsDir, "linear-oauth.json"), 0o600);

    const parsed = loadConfigFile(paths.configFile);
    expect(parsed.linearCommentMode).toBe(false);
    expect(parsed.linearTeam).toBe("ENG");
    expect(parsed.repo).toBe("pmdroid/paws-demo");
    expect(parsed.maxTurns).toBe(40);

    const runtime = loadRuntime({
      PAWS_HOME: home,
      PAWS_GITHUB_REPOSITORY: "other/repo",
    });
    expect(runtime.configured).toBe(true);
    expect(runtime.linearCommentMode).toBe(false);
    expect(runtime.linearAccessToken).toBe("lin_oauth_from_file");
    expect(runtime.repo).toBe("other/repo");
    expect(runtime.githubAuth).toBe("gh");
    expect(runtime.maxTurns).toBe(40);
    expect(runtime.webhooks).toBe(false);

    const overridden = loadRuntime({
      PAWS_HOME: home,
      LINEAR_ACCESS_TOKEN: "lin_oauth_from_env",
    });
    expect(overridden.linearAccessToken).toBe("lin_oauth_from_env");
  });

  test("a configured comment mode is reported and selects nothing", () => {
    const home = tempHome();
    const paths = pawsPaths(home);
    ensureLayout(paths);
    expect(loadRuntime({ PAWS_HOME: home }).linearCommentMode).toBe(false);
    expect(loadRuntime({ PAWS_HOME: home, LINEAR_MODE: "comments" }).linearCommentMode).toBe(true);
    expect(loadRuntime({ PAWS_HOME: home, PAWS_LINEAR_MODE: "comments" }).linearCommentMode).toBe(
      true,
    );
    writeFileSync(paths.configFile, '[linear]\nmode = "comments"\n', { mode: 0o600 });
    const runtime = loadRuntime({ PAWS_HOME: home });
    expect(runtime.configError).toBeNull();
    expect(runtime.linearCommentMode).toBe(true);
    writeFileSync(paths.configFile, '[linear]\nmode = "agent-session"\n', { mode: 0o600 });
    expect(loadRuntime({ PAWS_HOME: home }).linearCommentMode).toBe(false);
    writeFileSync(paths.configFile, '[linear]\nmode = "email"\n', { mode: 0o600 });
    expect(loadRuntime({ PAWS_HOME: home }).configError).toContain(
      "linear.mode must be agent-session",
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
    expect(() => loadConfigFile(paths.configFile)).toThrow(/claude, grok, or codex/);
  });

  test("writeImplementer keeps grok path and other keys", () => {
    const home = tempHome();
    const paths = pawsPaths(home);
    ensureLayout(paths);
    writeFileSync(
      paths.configFile,
      '# team\nrepo = "pmdroid/paws-demo"\n\n[agents.grok]\npath = "/opt/grok"\nallow_api_key = false\n',
    );
    writeImplementer(paths.configFile, "grok");
    const parsed = loadConfigFile(paths.configFile);
    expect(parsed.repo).toBe("pmdroid/paws-demo");
    expect(parsed.agents.implementer).toBe("grok");
    expect(parsed.agents.grok).toEqual({ path: "/opt/grok", allowApiKey: false });
    expect(statSync(paths.configFile).mode & 0o777).toBe(0o600);
  });

  test("old configs without github.auth or tracker load as gh and linear", () => {
    const home = tempHome();
    const paths = pawsPaths(home);
    ensureLayout(paths);
    writeFileSync(
      paths.configFile,
      ['repo = "pmdroid/paws-demo"', "", "[linear]", 'mode = "comments"', ""].join("\n"),
      { mode: 0o600 },
    );
    const runtime = loadRuntime({ PAWS_HOME: home });
    expect(runtime.githubAuth).toBe("gh");
    expect(runtime.trackerKind).toBe("linear");
    expect(runtime.oauthClientId).toBeNull();
    expect(runtime.file.githubAuth).toBeNull();
    expect(runtime.file.trackerSpecified).toBe(false);
  });

  test("Linear tracker config keeps GitHub OAuth authentication", () => {
    const home = tempHome();
    const paths = pawsPaths(home);
    ensureLayout(paths);
    writeConfigFile(paths.configFile, {
      linearTeam: "ENG",
      linearTeamId: "team_eng",
      linearViewerId: "viewer_1",
      linearSecret: "secrets/linear-api-key",
      linearClientFile: null,
      githubAuth: "oauth",
      oauthClientId: PAWS_GITHUB_OAUTH_CLIENT_ID,
      trackerKind: "linear",
      repo: "pmdroid/paws-demo",
      checkout: home,
      maxTurns: 40,
      maxAwakeMs: 1_000,
      implementer: "claude",
    });
    const runtime = loadRuntime({
      PAWS_HOME: home,
      PAWS_GITHUB_CLIENT_ID: "Iv1.from-env",
    });
    expect(runtime.githubAuth).toBe("oauth");
    expect(runtime.oauthClientId).toBe("Iv1.from-env");
    expect(runtime.trackerKind).toBe("linear");
    const text = readFileSync(paths.configFile, "utf8");
    expect(text).toContain('auth = "oauth"');
    expect(text).toContain('kind = "linear"');
    expect(text).not.toContain("[tracker.github]");
  });
});
