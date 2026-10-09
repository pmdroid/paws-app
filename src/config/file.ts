import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { NotImplementedError } from "../core";

/** Fields `config.toml` will hold. Parsing is a later change; a missing file is the default. */
export type PawsConfigFile = {
  linearTeam: string | null;
  repo: string | null;
  publicUrl: string | null;
};

/**
 * What `paws setup` writes. Secret values stay out of this file.
 * `linearSecret` and `linearClientFile` are paths relative to `~/.paws`.
 */
export type PawsSetupConfig = {
  linearMode: "comments" | "agent-session";
  linearTeam: string;
  linearTeamId: string;
  linearViewerId: string;
  linearSecret: string;
  linearClientFile: string | null;
  githubAuth: "gh";
  repo: string;
  closeoutBin: string;
  checkout: string;
  maxTurns: number;
  maxAwakeMs: number;
};

const emptyConfig: PawsConfigFile = {
  linearTeam: null,
  repo: null,
  publicUrl: null,
};

export function loadConfigFile(path: string): PawsConfigFile {
  if (!existsSync(path)) return emptyConfig;
  throw new NotImplementedError("config.toml parsing");
}

/** Canonical `config.toml` text. The same input always renders the same bytes. */
export function renderConfigToml(config: PawsSetupConfig): string {
  const lines = [
    "# Written by paws setup. Secret values stay in secrets/ at mode 0600.",
    "",
    "[linear]",
    `mode = ${tomlString(config.linearMode)}`,
    `team = ${tomlString(config.linearTeam)}`,
    `team_id = ${tomlString(config.linearTeamId)}`,
    `viewer_id = ${tomlString(config.linearViewerId)}`,
    `secret = ${tomlString(config.linearSecret)}`,
  ];
  if (config.linearClientFile !== null) {
    lines.push(`client_file = ${tomlString(config.linearClientFile)}`);
  }
  lines.push(
    "",
    "[github]",
    `auth = ${tomlString(config.githubAuth)}`,
    `repo = ${tomlString(config.repo)}`,
    "",
    "[closeout]",
    `bin = ${tomlString(config.closeoutBin)}`,
    "",
    "[checkout]",
    `path = ${tomlString(config.checkout)}`,
    "",
    "[caps]",
    `max_turns = ${tomlInt(config.maxTurns)}`,
    `max_awake_ms = ${tomlInt(config.maxAwakeMs)}`,
    "",
  );
  return lines.join("\n");
}

/**
 * Write `config.toml`. Returns false when the file already has these bytes
 * so a second setup does not touch it.
 */
export function writeConfigFile(path: string, config: PawsSetupConfig): boolean {
  const next = renderConfigToml(config);
  if (existsSync(path) && readFileSync(path, "utf8") === next) {
    if ((statSync(path).mode & 0o777) !== 0o600) chmodSync(path, 0o600);
    return false;
  }
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, next, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
  return true;
}

function tomlString(value: string): string {
  if (value.includes("\n") || value.includes("\r")) {
    throw new Error("config value cannot contain a newline");
  }
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function tomlInt(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("config integer is invalid");
  return String(value);
}
