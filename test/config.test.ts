import { describe, expect, test } from "bun:test";
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NotImplementedError } from "../src/core";
import {
  doctorReport,
  ensureLayout,
  formatDoctor,
  isHostedSource,
  loadConfigFile,
  loadEnv,
  normalizePrivateKey,
  pawsPaths,
} from "../src/config";
import { tempHome } from "./helpers";

describe("config", () => {
  test("defaults to localhost and ~/.paws", () => {
    const env = loadEnv({});
    expect(env.host).toBe("127.0.0.1");
    expect(env.port).toBe(8787);
    expect(env.home.endsWith(".paws")).toBe(true);
    expect(env.linearWebhookSecret).toBeNull();
    expect(env.githubAppId).toBeNull();
    expect(env.hosted).toBe(false);
    expect(env.mode).toBe("local");
    expect(env.githubAppPrivateKey).toBeNull();
  });

  test("local mode ignores Railway PORT", () => {
    expect(loadEnv({ PORT: "4000" }).port).toBe(8787);
    expect(isHostedSource({ RAILWAY_ENVIRONMENT: "production", PAWS_MODE: "local" })).toBe(false);
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

  test("missing config.toml is empty and a present file is not parsed yet", () => {
    const home = tempHome();
    const paths = pawsPaths(home);
    expect(loadConfigFile(paths.configFile)).toEqual({
      linearTeam: null,
      repo: null,
      publicUrl: null,
    });
    ensureLayout(paths);
    writeFileSync(paths.configFile, 'repo = "pmdroid/paws-demo"\n');
    expect(() => loadConfigFile(paths.configFile)).toThrow(NotImplementedError);
  });
});

const PEM = "-----BEGIN PRIVATE KEY-----\\nline\\n-----END PRIVATE KEY-----";

describe("hosted config", () => {
  test("Railway implies hosted mode, 0.0.0.0, PORT, and the public domain", () => {
    const env = loadEnv({
      RAILWAY_ENVIRONMENT: "production",
      RAILWAY_PUBLIC_DOMAIN: "paws.up.railway.app",
      PORT: "8080",
      PAWS_PORT: "8787",
      RAILWAY_VOLUME_MOUNT_PATH: "/data",
      GITHUB_APP_PRIVATE_KEY: PEM,
    });
    expect(env.hosted).toBe(true);
    expect(env.mode).toBe("hosted");
    expect(env.host).toBe("0.0.0.0");
    expect(env.port).toBe(8080);
    expect(env.home).toBe("/data");
    expect(env.publicUrl).toBe("https://paws.up.railway.app");
    expect(env.githubAppPrivateKey).toBe(
      "-----BEGIN PRIVATE KEY-----\nline\n-----END PRIVATE KEY-----\n",
    );
    expect(normalizePrivateKey("already\nwrapped\n")).toBe("already\nwrapped\n");
  });

  test("explicit hosted mode prefers PAWS_PUBLIC_URL and PAWS_HOME", () => {
    const env = loadEnv({
      PAWS_MODE: "hosted",
      PAWS_HOME: "/var/paws",
      PAWS_PUBLIC_URL: "https://paws.example/",
      PAWS_PORT: "9090",
      RAILWAY_PUBLIC_DOMAIN: "ignored.up.railway.app",
    });
    expect(env.home).toBe("/var/paws");
    expect(env.port).toBe(9090);
    expect(env.publicUrl).toBe("https://paws.example");
    expect(() => loadEnv({ PAWS_MODE: "cloud" })).toThrow(/PAWS_MODE/);
    expect(() => loadEnv({ PAWS_MODE: "hosted", PORT: "nope" })).toThrow(/PORT/);
  });

  test("doctor accepts a complete hosted environment and rejects a partial one", () => {
    const ready = doctorReport(hostedEnv());
    expect(ready.ok).toBe(true);
    expect(ready.mode).toBe("hosted");
    expect(formatDoctor(ready)).toContain("ready");
    expect(formatDoctor(ready)).not.toContain("BEGIN PRIVATE KEY");
    expect(formatDoctor(ready)).toContain("ngrok");
    expect(formatDoctor(ready)).toContain("sleep");

    const missing = doctorReport({ PAWS_MODE: "hosted" });
    expect(missing.ok).toBe(false);
    const failed = missing.checks.filter((check) => !check.ok).map((check) => check.name);
    expect(failed).toContain("PAWS_HOME");
    expect(failed).toContain("PORT");
    expect(failed).toContain("public url");
    expect(failed).toContain("GITHUB_APP_PRIVATE_KEY");
    expect(failed).toContain("PAWS_DASHBOARD_TOKEN");
    expect(failed).toContain("Anthropic auth");
    expect(failed).toContain("OpenAI auth");
    expect(formatDoctor(missing)).toContain("not ready");

    const fileKey = doctorReport({
      ...hostedEnv(),
      GITHUB_APP_PRIVATE_KEY: "",
      GITHUB_APP_PRIVATE_KEY_PATH: "/data/secrets/github.pem",
    });
    expect(fileKey.checks.find((check) => check.name === "GITHUB_APP_PRIVATE_KEY")?.ok).toBe(false);

    const loopback = doctorReport({ ...hostedEnv(), PAWS_HOST: "127.0.0.1" });
    expect(loopback.checks.find((check) => check.name === "PAWS_HOST")?.ok).toBe(false);

    const proxy = doctorReport({
      ...hostedEnv(),
      ANTHROPIC_API_KEY: "",
      OPENAI_API_KEY: "",
      PAWS_MODEL_PROXY_URL: "https://models.example",
    });
    expect(proxy.ok).toBe(true);

    const local = doctorReport({});
    expect(local.ok).toBe(true);
    expect(local.mode).toBe("local");
  });
});

function hostedEnv(): Record<string, string> {
  return {
    PAWS_MODE: "hosted",
    PAWS_HOME: "/data",
    PORT: "8080",
    RAILWAY_PUBLIC_DOMAIN: "paws.up.railway.app",
    LINEAR_CLIENT_ID: "client",
    LINEAR_CLIENT_SECRET: "secret",
    LINEAR_WEBHOOK_SECRET: "hook",
    LINEAR_ACCESS_TOKEN: "token",
    GITHUB_APP_ID: "11",
    GITHUB_APP_INSTALLATION_ID: "22",
    GITHUB_APP_PRIVATE_KEY: PEM,
    GITHUB_WEBHOOK_SECRET: "gh-hook",
    ANTHROPIC_API_KEY: "anthropic",
    OPENAI_API_KEY: "openai",
    PAWS_DASHBOARD_TOKEN: "dashboard-token-value",
  };
}
