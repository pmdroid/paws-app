import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  emptyConfigFile,
  exeDevTokenPath,
  loadGitHubAppCredentials,
  loadRuntime,
  readExeDevToken,
  readTailscaleAuthKey,
  tailscaleAuthKeyPath,
} from "../src/config";
import { readSecretFile } from "../src/credentials";
import type { DoctorCheck } from "../src/doctor";
import { defaultEnvFile, openEnvFile, runSecretsStep, terminalPrompter } from "../src/installer";

const PEM =
  "-----BEGIN RSA PRIVATE KEY-----\nMIIEfakeinstallerkey\n-----END RSA PRIVATE KEY-----\n";
const SECRETS = {
  appId: "app-id-4711",
  clientId: "Iv1.clientid0815",
  clientSecret: "gh-client-secret-zz9",
  installationId: "install-id-31337",
  linearClientId: "linear-client-id-qq1",
  linearClientSecret: "linear-client-secret-qq2",
  githubWebhook: "pasted-github-webhook-ww3",
  exeDev: "exe-dev-token-ee4",
  tailscale: "tskey-auth-tt5",
  slackClientId: "slack-client-id-ss6",
  slackClientSecret: "slack-client-secret-ss7",
  slackSigning: "slack-signing-secret-ss8",
  xai: "xai-api-key-xx9",
};

let home: string;
let pemPath: string;
let envPath: string;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "paws-installer-"));
  home = join(root, ".paws");
  pemPath = join(root, "app.private-key.pem");
  envPath = join(root, "config", "paws.env");
  writeFileSync(pemPath, PEM, { mode: 0o600 });
});

afterEach(() => rmSync(join(home, ".."), { recursive: true, force: true }));

type Run = { stdout: string; stderr: string; terminal: string; checks: number };

async function run(lines: readonly string[]): Promise<Run> {
  const input = new PassThrough();
  input.end(lines.map((line) => `${line}\n`).join(""));
  let stdout = "";
  let stderr = "";
  let terminal = "";
  let checks = 0;
  const writeOut = process.stdout.write;
  const writeErr = process.stderr.write;
  process.stdout.write = ((chunk: string) => ((stdout += chunk), true)) as never;
  process.stderr.write = ((chunk: string) => ((stderr += chunk), true)) as never;
  try {
    const config = emptyConfigFile();
    config.agents.grok.allowApiKey = true;
    await runSecretsStep({
      home,
      config,
      env: openEnvFile(envPath),
      prompter: terminalPrompter(input, process.stdout, { write: (text) => (terminal += text) }),
      publicUrl: "https://paws.example.ts.net",
      doctor: async (): Promise<DoctorCheck[]> => {
        checks++;
        return [
          { name: "github-app", ok: true, detail: "app configured" },
          { name: "exe-dev", ok: true, detail: "token present and readable" },
          { name: "linear", ok: false, detail: "unrelated" },
        ];
      },
    });
  } finally {
    process.stdout.write = writeOut;
    process.stderr.write = writeErr;
  }
  return { stdout, stderr, terminal, checks };
}

const FIRST_RUN = [
  SECRETS.appId,
  SECRETS.clientId,
  SECRETS.clientSecret,
  SECRETS.installationId,
  "", // private key path: not set, Enter skips first
];

function firstRun(): string[] {
  return [
    SECRETS.appId,
    SECRETS.clientId,
    SECRETS.clientSecret,
    SECRETS.installationId,
    pemPath,
    SECRETS.linearClientId,
    SECRETS.linearClientSecret,
    "g",
    "p",
    SECRETS.githubWebhook,
    SECRETS.exeDev,
    SECRETS.tailscale,
    SECRETS.slackClientId,
    SECRETS.slackClientSecret,
    SECRETS.slackSigning,
    SECRETS.xai,
  ];
}

const KEEP_ALL = Array.from({ length: 15 }, () => "");

function secretFiles(): string[] {
  const dir = join(home, "secrets");
  return [
    "github-app.json",
    "github-app.pem",
    "linear-client.json",
    "linear-webhook",
    "github-webhook",
    "exe-dev-token",
    "tailscale-authkey",
    "slack-app.json",
  ].map((name) => join(dir, name));
}

test("every secret is written as an envelope, not plaintext", async () => {
  await run(firstRun());
  expect(statSync(join(home, "secrets")).mode & 0o777).toBe(0o700);
  for (const path of secretFiles()) {
    const text = readFileSync(path, "utf8");
    expect(text.startsWith("paws-envelope-v1\n")).toBe(true);
    for (const value of [...Object.values(SECRETS), PEM]) expect(text).not.toContain(value);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  }
  expect(readExeDevToken(home)).toBe(SECRETS.exeDev);
  expect(readTailscaleAuthKey(home)).toBe(SECRETS.tailscale);
  expect(readSecretFile(join(home, "secrets", "github-webhook"))).toBe(SECRETS.githubWebhook);
  expect(JSON.parse(readSecretFile(join(home, "secrets", "slack-app.json"))!)).toEqual({
    clientId: SECRETS.slackClientId,
    clientSecret: SECRETS.slackClientSecret,
    signingSecret: SECRETS.slackSigning,
  });
  expect(openEnvFile(envPath).get("XAI_API_KEY")).toBe(SECRETS.xai);
  expect(statSync(envPath).mode & 0o777).toBe(0o600);
});

test("the GitHub App and Linear client files match what Paws reads", async () => {
  await run(firstRun());
  const app = loadGitHubAppCredentials(home, {});
  expect(app).toEqual({
    appId: SECRETS.appId,
    clientId: SECRETS.clientId,
    clientSecret: SECRETS.clientSecret,
    privateKeyPath: join(home, "secrets", "github-app.pem"),
    installationId: SECRETS.installationId,
  });
  expect(readSecretFile(app!.privateKeyPath, false)).toBe(PEM);
  const runtime = loadRuntime({ PAWS_HOME: home });
  expect(runtime.env.githubAppId).toBe(SECRETS.appId);
  expect(runtime.linearClientId).toBe(SECRETS.linearClientId);
  expect(runtime.linearClientSecret).toBe(SECRETS.linearClientSecret);
  expect(runtime.env.linearWebhookSecret).toMatch(/^[0-9a-f]{64}$/);
  expect(runtime.env.githubWebhookSecret).toBe(SECRETS.githubWebhook);
});

test("a re-run with Enter keeps every secret", async () => {
  await run(firstRun());
  const before = secretFiles().map((path) => readFileSync(path, "utf8"));
  const envBefore = readFileSync(envPath, "utf8");
  const second = await run(KEEP_ALL);
  expect(secretFiles().map((path) => readFileSync(path, "utf8"))).toEqual(before);
  expect(readFileSync(envPath, "utf8")).toBe(envBefore);
  expect(second.stdout).toContain("App ID [set, Enter keeps it]: ");
  expect(second.stdout).toContain("Private key file path [set, Enter keeps it]: ");
  expect(second.stdout).toContain("Linear webhook secret [set] g to generate");
  expect(second.stdout).toContain("XAI_API_KEY [set, Enter keeps it]: ");
  expect(second.stdout).not.toContain("not set");
});

test("a first run shows not set and stops at a missing required Tailscale key", async () => {
  const lines = [...FIRST_RUN, "", "", "", "", "", ""];
  await expect(run(lines)).rejects.toThrow("Input ended");
});

test("generated webhook secrets are 32 random bytes, shown once on the terminal only", async () => {
  const lines = firstRun();
  lines[8] = "g";
  lines.splice(9, 1);
  const first = await run(lines);
  const linear = readSecretFile(join(home, "secrets", "linear-webhook"))!;
  const github = readSecretFile(join(home, "secrets", "github-webhook"))!;
  for (const value of [linear, github]) {
    expect(value).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(value, "hex").length).toBeGreaterThanOrEqual(32);
    expect(first.terminal.split(value).length - 1).toBe(1);
    expect(first.stdout).not.toContain(value);
    expect(first.stderr).not.toContain(value);
  }
  expect(linear).not.toBe(github);
  await run(KEEP_ALL);
  expect(readSecretFile(join(home, "secrets", "linear-webhook"))).toBe(linear);
});

test("no secret value appears in stdout or stderr", async () => {
  const result = await run(firstRun());
  const output = result.stdout + result.stderr;
  for (const value of [...Object.values(SECRETS), PEM.split("\n")[1]!]) {
    expect(output).not.toContain(value);
  }
  expect(result.terminal).not.toContain(SECRETS.githubWebhook);
  expect(output).toContain("https://paws.example.ts.net/auth/github-app/callback");
  expect(output).toContain("https://paws.example.ts.net/auth/linear/install/callback");
  expect(output).toContain("tag:paws-runner");
});

test("the matching doctor checks run once and only they are shown", async () => {
  const result = await run(firstRun());
  expect(result.checks).toBe(1);
  expect(result.stdout).toContain("ok github-app: app configured");
  expect(result.stdout).toContain("ok exe-dev: token present and readable");
  expect(result.stdout).not.toContain("unrelated");
});

test("a key file that is not a PEM is refused and asked again", async () => {
  const lines = firstRun();
  lines.splice(4, 0, join(home, "..", "missing.pem"));
  const result = await run(lines);
  expect(result.stdout).toContain("That file is not a readable PEM private key.");
  expect(loadGitHubAppCredentials(home, {})?.appId).toBe(SECRETS.appId);
  expect(exeDevTokenPath(home)).toBe(join(home, "secrets", "exe-dev-token"));
  expect(tailscaleAuthKeyPath(home)).toBe(join(home, "secrets", "tailscale-authkey"));
});

test("the default env file is the one paws install wrote", () => {
  const user = join(home, "..", "user");
  expect(defaultEnvFile({ HOME: user, PAWS_HOME: home })).toBe(join(home, "https.env"));
  const unitDir = join(user, ".config", "systemd", "user");
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(join(unitDir, "paws.service"), "[Service]\nEnvironmentFile=/srv/paws/https.env\n");
  expect(defaultEnvFile({ HOME: user, PAWS_HOME: home })).toBe("/srv/paws/https.env");
});
