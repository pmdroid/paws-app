import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8787;

export type EnvSource = Record<string, string | undefined>;

export type PawsEnv = {
  home: string;
  host: string;
  port: number;
  publicUrl: string | null;
  linearWebhookSecret: string | null;
  githubAppId: string | null;
  githubAppInstallationId: string | null;
  githubAppPrivateKeyPath: string | null;
  githubWebhookSecret: string | null;
};

export function loadEnv(source: EnvSource = process.env): PawsEnv {
  return {
    home: optional(source, "PAWS_HOME") ?? join(homedir(), ".paws"),
    host: optional(source, "PAWS_HOST") ?? DEFAULT_HOST,
    port: readPort(source["PAWS_PORT"]),
    publicUrl: optional(source, "PAWS_PUBLIC_URL"),
    linearWebhookSecret: optional(source, "LINEAR_WEBHOOK_SECRET"),
    githubAppId: optional(source, "GITHUB_APP_ID"),
    githubAppInstallationId: optional(source, "GITHUB_APP_INSTALLATION_ID"),
    githubAppPrivateKeyPath: optional(source, "GITHUB_APP_PRIVATE_KEY_PATH"),
    githubWebhookSecret: optional(source, "GITHUB_WEBHOOK_SECRET"),
  };
}

function readPort(value: string | undefined): number {
  if (value === undefined || value.length === 0) return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PAWS_PORT must be an integer from 0 to 65535, got ${value}`);
  }
  return port;
}

function optional(source: EnvSource, key: string): string | null {
  const value = source[key];
  if (value === undefined || value.length === 0) return null;
  return value;
}
