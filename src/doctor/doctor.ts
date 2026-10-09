import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";
import { loadEnv, pawsPaths, type EnvSource } from "../config";

export type DoctorCheck = {
  name: string;
  ok: boolean;
  detail: string;
};

export type DoctorProbe = {
  which(bin: string): string | null;
  stat(path: string): { mode: number } | null;
  canWrite(dir: string): boolean;
  bunVersion: string | null;
  env: EnvSource;
};

const CLAUDE_BIN = "claude-agent-acp";
const CODEX_BIN = "codex-acp";

/** Prerequisite checks for a real local run. Missing tools are reported, not thrown. */
export function doctorChecks(probe: DoctorProbe): DoctorCheck[] {
  const env = loadEnv(probe.env);
  const paths = pawsPaths(env.home);
  const repository = env.githubRepository;
  const repoOk = repository !== null && /^[^/\s]+\/[^/\s]+$/.test(repository);
  const keyStat =
    env.githubAppPrivateKeyPath === null ? null : probe.stat(env.githubAppPrivateKeyPath);
  const keyMode = keyStat === null ? null : keyStat.mode & 0o777;
  const claude = probe.which(configuredBin(probe.env, "PAWS_CLAUDE_ACP") ?? CLAUDE_BIN);
  const codex = probe.which(configuredBin(probe.env, "PAWS_CODEX_ACP") ?? CODEX_BIN);
  const closeout = probe.which(configuredBin(probe.env, "CLOSEOUT_BIN") ?? "closeout");
  const git = probe.which("git");
  const ngrok = probe.which("ngrok");
  const linearReady =
    optional(probe.env, "LINEAR_ACCESS_TOKEN") !== null ||
    probe.stat(join(paths.secretsDir, "linear-oauth.json")) !== null;
  return [
    check("git", git !== null, git ?? "git is not on PATH"),
    check("bun", probe.bunVersion !== null, probe.bunVersion ?? "bun is not running this process"),
    check(
      "home",
      probe.canWrite(paths.home),
      probe.canWrite(paths.home) ? paths.home : `cannot write ${paths.home}`,
    ),
    check(
      "linear",
      linearReady,
      linearReady ? "token configured" : "set LINEAR_ACCESS_TOKEN or install the Linear app",
    ),
    check(
      "linear-webhook",
      env.linearWebhookSecret !== null,
      env.linearWebhookSecret !== null ? "secret configured" : "LINEAR_WEBHOOK_SECRET is empty",
    ),
    check(
      "public-url",
      env.publicUrl !== null && env.publicUrl.startsWith("https://"),
      env.publicUrl ?? "PAWS_PUBLIC_URL must be the https ngrok dev domain",
    ),
    check("ngrok", ngrok !== null, ngrok ?? "ngrok is not on PATH"),
    check("claude", claude !== null, claude ?? `${CLAUDE_BIN} is not on PATH`),
    check("codex", codex !== null, codex ?? `${CODEX_BIN} is not on PATH`),
    check("closeout", closeout !== null, closeout ?? "closeout is not on PATH"),
    check("repository", repoOk, repoOk ? repository : "PAWS_GITHUB_REPOSITORY must be owner/repo"),
    check(
      "github-app",
      env.githubAppId !== null &&
        env.githubAppInstallationId !== null &&
        keyStat !== null &&
        (keyMode === 0o600 || keyMode === 0o400),
      githubDetail(env.githubAppId, env.githubAppInstallationId, keyStat !== null, keyMode),
    ),
  ];
}

export function formatDoctor(checks: readonly DoctorCheck[]): string {
  const lines = ["paws doctor"];
  for (const item of checks) {
    lines.push(`${item.ok ? "ok" : "missing"} ${item.name}: ${item.detail}`);
  }
  return lines.join("\n");
}

export function realProbe(env: EnvSource = process.env): DoctorProbe {
  return {
    env,
    bunVersion: typeof Bun === "undefined" ? null : Bun.version,
    which(bin) {
      const command = bin.split(/\s+/)[0];
      if (command === undefined || command.length === 0) return null;
      return Bun.which(command);
    },
    stat(path) {
      try {
        return { mode: statSync(path).mode };
      } catch {
        return null;
      }
    },
    canWrite(dir) {
      try {
        accessSync(dir, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
  };
}

function check(name: string, ok: boolean, detail: string): DoctorCheck {
  return { name, ok, detail };
}

function configuredBin(env: EnvSource, key: string): string | null {
  const value = env[key];
  if (value === undefined || value.trim() === "") return null;
  return value.trim();
}

function optional(env: EnvSource, key: string): string | null {
  const value = env[key];
  if (value === undefined || value.length === 0) return null;
  return value;
}

function githubDetail(
  appId: string | null,
  installationId: string | null,
  keyExists: boolean,
  mode: number | null,
): string {
  if (appId === null || installationId === null)
    return "GITHUB_APP_ID and GITHUB_APP_INSTALLATION_ID are required";
  if (!keyExists) return "GitHub App private key file is missing";
  if (mode !== 0o600 && mode !== 0o400) return "GitHub App private key must be mode 0600";
  return "app configured";
}
