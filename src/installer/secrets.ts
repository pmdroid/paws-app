import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { readSecretFile, writeSecretFile } from "../credentials";
import {
  EXE_DEV_TOKEN_FILE,
  isTailnetUrl,
  pawsPaths,
  saveGitHubAppCredentials,
  TAILSCALE_AUTHKEY_FILE,
  type GitHubAppCredentials,
  type PawsConfigFile,
} from "../config";
import { formatDoctor, type DoctorCheck } from "../doctor";
import type { EnvFile } from "./env-file";
import type { Prompter } from "./prompt";

/** Bytes in a generated webhook secret. */
export const WEBHOOK_SECRET_BYTES = 32;

/** Doctor checks that read what this step writes. */
export const SECRETS_DOCTOR_CHECKS = [
  "github-app",
  "github-app-installation",
  "github-app-push",
  "github-rate",
  "github-app-events",
  "exe-dev",
  "tailscale-authkey",
  "linear-webhook",
  "github-webhook",
] as const;

export type SecretsStepInput = {
  home: string;
  config: PawsConfigFile;
  env: EnvFile;
  prompter: Prompter;
  publicUrl: string | null;
  /** Runs doctor with what was just written. */
  doctor: () => Promise<DoctorCheck[]>;
  random?: (bytes: number) => Buffer;
};

/** Asks for every Paws secret. Enter keeps a value that is set. Values are never printed. */
export async function runSecretsStep(input: SecretsStepInput): Promise<void> {
  const { prompter: io } = input;
  const origin = input.publicUrl?.replace(/\/+$/, "") ?? "https://YOUR-PAWS-HOST";
  const dir = pawsPaths(input.home).secretsDir;
  const random = input.random ?? randomBytes;

  await githubApp(input, origin, dir);
  await linearClient(input, origin);
  for (const [name, label, where] of [
    ["linear-webhook", "Linear webhook secret", `${origin}/webhooks/linear`],
    ["github-webhook", "GitHub webhook secret", `${origin}/webhooks/github`],
  ] as const) {
    io.say(`\n${label}: paste it into the webhook for ${where}.`);
    await webhookSecret(io, join(dir, name), label, random);
  }

  io.say("\nexe.dev API token (optional). It enables Create VM and needs new, ls, ssh and rm.");
  await textSecret(io, join(dir, EXE_DEV_TOKEN_FILE), "exe.dev API token", false);

  const tailnet = isTailnetUrl(input.publicUrl);
  io.say(
    `\nTailscale auth key${tailnet ? ", required because the public URL is on a tailnet" : " (optional)"}.`,
  );
  io.say("  Make it reusable and pre-authorized, tagged tag:paws-runner (docs/create-vm.md).");
  io.say('  Tailnet policy: "tagOwners": { "tag:paws-runner": ["autogroup:admin"] } and');
  io.say('  { "action": "accept", "src": ["tag:paws-runner"], "dst": ["paws:8787,8788"] }.');
  await textSecret(io, join(dir, TAILSCALE_AUTHKEY_FILE), "Tailscale auth key", tailnet);

  await slackApp(io, join(dir, "slack-app.json"));
  if (input.config.agents.grok.allowApiKey) {
    io.say("\nxAI API key for Grok ([agents.grok] allow_api_key is set).");
    const value = await io.secret(prompt("XAI_API_KEY", input.env.get("XAI_API_KEY") !== null));
    if (value) input.env.set("XAI_API_KEY", value);
  }

  const names: readonly string[] = SECRETS_DOCTOR_CHECKS;
  const checks = (await input.doctor()).filter((check) => names.includes(check.name));
  io.say(`\n${formatDoctor(checks)}`);
}

async function githubApp(input: SecretsStepInput, origin: string, dir: string): Promise<void> {
  const { prompter: io } = input;
  io.say("GitHub App (docs/github-app.md)");
  io.say(`  Callback URLs: ${origin}/auth/github-app/callback`);
  io.say(`                 ${origin}/auth/github-attribution/callback`);
  io.say(`  Webhook URL:   ${origin}/webhooks/github`);
  io.say(
    "  Read and write: Contents, Pull requests, Checks, Issues, Workflows. Read-only: Commit statuses, Merge queues.",
  );
  io.say(
    "  Events: Check runs, Check suites, Statuses, Pull requests, Pull request reviews, Pull request review comments, Issue comments, Merge groups, Pushes, Installations, Installation repositories.",
  );
  const saved = readJson(join(dir, "github-app.json"));
  const pemPath = join(dir, "github-app.pem");
  const fields = [
    ["appId", "App ID"],
    ["clientId", "Client ID"],
    ["clientSecret", "Client secret"],
    ["installationId", "Installation ID (optional)"],
  ] as const;
  const app: Record<string, string | null> = {};
  let changed = false;
  for (const [key, label] of fields) {
    const value = await io.secret(prompt(label, Boolean(saved[key])));
    changed ||= value.length > 0;
    app[key] = value || saved[key] || null;
  }
  const keySet = existsSync(pemPath);
  let privateKeyPath = keySet ? pemPath : null;
  for (;;) {
    const path = await io.ask(
      `Private key file path [${keySet ? "set" : "not set"}${keySet ? ", Enter keeps it" : ""}]: `,
    );
    if (!path) break;
    if (isPrivateKey(path)) {
      privateKeyPath = path;
      changed = true;
      break;
    }
    io.say("  That file is not a readable PEM private key.");
  }
  const missing = [
    app.appId ? null : "App ID",
    app.clientId ? null : "client ID",
    app.clientSecret ? null : "client secret",
    privateKeyPath ? null : "private key",
  ].filter((item) => item !== null);
  if (missing.length > 0) {
    io.say(`  GitHub App not saved: ${missing.join(", ")} not set.`);
    return;
  }
  if (!changed) return;
  const credentials: GitHubAppCredentials = {
    appId: app.appId!,
    clientId: app.clientId!,
    clientSecret: app.clientSecret!,
    privateKeyPath: privateKeyPath!,
    installationId: app.installationId ?? null,
  };
  saveGitHubAppCredentials(input.home, credentials);
  io.say("  GitHub App saved.");
}

async function linearClient(input: SecretsStepInput, origin: string): Promise<void> {
  const { prompter: io } = input;
  io.say("\nLinear OAuth app");
  io.say(`  Callback URLs: ${origin}/auth/linear/callback`);
  io.say(`                 ${origin}/auth/linear/install/callback`);
  const relative = input.config.linearClientFile?.trim() || "secrets/linear-client.json";
  const path = isAbsolute(relative) ? relative : join(input.home, relative);
  const saved = readJson(path);
  const clientId = await io.secret(prompt("Client ID", Boolean(saved.clientId)));
  const clientSecret = await io.secret(prompt("Client secret", Boolean(saved.clientSecret)));
  if (!clientId && !clientSecret) return;
  const next = {
    clientId: clientId || saved.clientId,
    clientSecret: clientSecret || saved.clientSecret,
  };
  writeSecretFile(path, `${JSON.stringify(next)}\n`);
  io.say("  Linear OAuth app saved.");
}

async function webhookSecret(
  io: Prompter,
  path: string,
  label: string,
  random: (bytes: number) => Buffer,
): Promise<void> {
  const set = isSet(path);
  for (;;) {
    const choice = (
      await io.ask(
        `${label} [${set ? "set" : "not set"}] g to generate, p to paste, Enter to ${set ? "keep" : "skip"}: `,
      )
    ).toLowerCase();
    if (choice === "") return;
    if (choice === "p") {
      const value = await io.secret(`${label}: `);
      if (!value) continue;
      writeSecretFile(path, value);
      io.say(`  ${label} saved.`);
      return;
    }
    if (choice === "g") {
      const value = random(WEBHOOK_SECRET_BYTES).toString("hex");
      if (!io.reveal(`${label} (shown once, copy it now): ${value}`)) {
        io.say("  There is no terminal to show a generated secret on. Paste one instead.");
        continue;
      }
      writeSecretFile(path, value);
      io.say(`  ${label} saved.`);
      return;
    }
  }
}

async function textSecret(
  io: Prompter,
  path: string,
  label: string,
  required: boolean,
): Promise<void> {
  for (;;) {
    const set = isSet(path);
    const value = await io.secret(prompt(label, set));
    if (value) {
      writeSecretFile(path, value);
      io.say(`  ${label} saved.`);
      return;
    }
    if (set || !required) return;
    io.say(`  ${label} is required.`);
  }
}

async function slackApp(io: Prompter, path: string): Promise<void> {
  io.say("\nSlack (optional). Leave these empty to skip Slack.");
  const saved = readJson(path);
  const fields = [
    ["clientId", "Slack client ID"],
    ["clientSecret", "Slack client secret"],
    ["signingSecret", "Slack signing secret"],
  ] as const;
  const app: Record<string, string> = {};
  let changed = false;
  for (const [key, label] of fields) {
    const value = await io.secret(prompt(label, Boolean(saved[key])));
    changed ||= value.length > 0;
    app[key] = value || saved[key] || "";
  }
  if (!changed) return;
  if (!app.clientId || !app.clientSecret || !app.signingSecret) {
    io.say("  Slack not saved: client ID, client secret and signing secret are all required.");
    return;
  }
  writeSecretFile(path, JSON.stringify(app));
  io.say("  Slack saved. Run paws login slack to connect it.");
}

function prompt(label: string, set: boolean): string {
  return `${label} [${set ? "set, Enter keeps it" : "not set"}]: `;
}

function isSet(path: string): boolean {
  try {
    return (readSecretFile(path, false)?.trim() ?? "").length > 0;
  } catch {
    return false;
  }
}

function readJson(path: string): Record<string, string | undefined> {
  try {
    const parsed: unknown = JSON.parse(readSecretFile(path, false) ?? "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

function isPrivateKey(path: string): boolean {
  try {
    return /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
}
