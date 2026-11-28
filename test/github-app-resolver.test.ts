import { afterEach, expect, test } from "bun:test";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceGitHubActivation } from "../src/auth";
import {
  gitHubWebhookSecret,
  importLegacyGitHubApp,
  loadGitHubAppCredentials,
  loadRuntime,
} from "../src/config";
import { readSecretFile, saveSecret } from "../src/credentials";
import type { Db } from "../src/db";
import { startServer } from "../src/server";

const homes: string[] = [];
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const pem = () =>
  generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
    type: "pkcs8",
    format: "pem",
  }) as string;

function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), "paws-github-app-"));
  homes.push(dir);
  mkdirSync(join(dir, "secrets"), { recursive: true, mode: 0o700 });
  return dir;
}

const record = (dir: string, value: Record<string, unknown>) =>
  saveSecret(join(dir, "secrets", "github-browser-app.json"), JSON.stringify(value));

const savedApp = (key: string, webhookSecret: string) => ({
  appId: "11",
  clientId: "settings-client",
  clientSecret: "settings-secret-marker",
  privateKeyPem: key,
  privateKeyPath: "/nowhere/github-app.pem",
  webhookSecret,
  installationId: null,
});

test("the environment wins per field and its key is read from its path", async () => {
  const dir = tempHome();
  const envKey = pem();
  writeFileSync(join(dir, "env.pem"), envKey, { mode: 0o600 });
  await record(dir, savedApp(pem(), "settings-webhook-marker"));
  const env = {
    PAWS_HOME: dir,
    GITHUB_APP_ID: "22",
    PAWS_GITHUB_CLIENT_SECRET: "env-secret-marker",
    GITHUB_APP_PRIVATE_KEY_PATH: join(dir, "env.pem"),
    GITHUB_WEBHOOK_SECRET: "env-webhook-marker",
  };
  expect(loadGitHubAppCredentials(dir, env)).toEqual({
    appId: "22",
    clientId: "settings-client",
    clientSecret: "env-secret-marker",
    privateKeyPem: envKey,
    installationId: null,
    webhookSecret: "env-webhook-marker",
  });
  expect(loadRuntime(env).env.githubWebhookSecret).toBe("env-webhook-marker");
});

test("a missing or unusable key fails closed instead of falling back to the saved one", async () => {
  const dir = tempHome();
  await record(dir, savedApp(pem(), "settings-webhook-marker"));
  const env = { GITHUB_APP_PRIVATE_KEY_PATH: join(dir, "missing.pem") };
  expect(loadGitHubAppCredentials(dir, env)?.privateKeyPem).toBeNull();
  expect(() => createWorkspaceGitHubActivation({} as Db, dir, env).template()).toThrow(
    "GitHub App key unavailable.",
  );
  writeFileSync(join(dir, "bad.pem"), "not a key", { mode: 0o600 });
  const bad = { GITHUB_APP_PRIVATE_KEY_PATH: join(dir, "bad.pem") };
  expect(loadGitHubAppCredentials(dir, bad)?.privateKeyPem).toBeNull();
});

test("the legacy names are read only by the import", async () => {
  const dir = tempHome();
  const key = pem();
  writeFileSync(join(dir, "secrets", "legacy.pem"), key, { mode: 0o600 });
  await saveSecret(
    join(dir, "secrets", "github-app.json"),
    JSON.stringify({
      appId: "33",
      clientId: "legacy-client",
      clientSecret: "legacy-secret-marker",
      privateKeyPath: join(dir, "secrets", "legacy.pem"),
    }),
  );
  await saveSecret(join(dir, "secrets", "github-webhook"), "legacy-webhook-marker");
  expect(loadGitHubAppCredentials(dir, {})).toBeNull();
  expect(gitHubWebhookSecret(dir, {})).toBeNull();
  await importLegacyGitHubApp(dir, {});
  expect(loadGitHubAppCredentials(dir, {})).toMatchObject({
    appId: "33",
    privateKeyPem: key,
    webhookSecret: "legacy-webhook-marker",
  });
  await record(dir, savedApp(key, "rotated-webhook-marker"));
  await importLegacyGitHubApp(dir, {});
  expect(gitHubWebhookSecret(dir, {})).toBe("rotated-webhook-marker");
  expect(readSecretFile(join(dir, "secrets", "github-webhook"))).toBe("legacy-webhook-marker");
});

test("webhook checks follow a Settings rotation without a restart", async () => {
  const dir = tempHome();
  const key = pem();
  await record(dir, savedApp(key, "first-webhook-marker"));
  await saveSecret(join(dir, "secrets", "github-webhook"), "standalone-webhook-marker");
  const server = startServer({
    port: 0,
    hostname: "127.0.0.1",
    webhooks: true,
    statusEnv: { PAWS_HOME: dir },
  });
  const post = (secret: string) => {
    const body = "{}";
    const signature = createHmac("sha256", secret).update(body).digest("hex");
    return fetch(`http://127.0.0.1:${server.port}/webhooks/github`, {
      method: "POST",
      headers: { "x-hub-signature-256": `sha256=${signature}` },
      body,
    }).then((response) => response.status);
  };
  try {
    expect(await post("standalone-webhook-marker")).toBe(401);
    expect(await post("first-webhook-marker")).toBe(400);
    await record(dir, savedApp(key, "second-webhook-marker"));
    expect(await post("first-webhook-marker")).toBe(401);
    expect(await post("second-webhook-marker")).toBe(400);
  } finally {
    await server.stop(true);
  }
});
