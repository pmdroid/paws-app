import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";

export type LinearConfigMode = "comments" | "agent-session";
export type GitHubConfigAuth = "gh" | "app";

/**
 * Parsed `~/.paws/config.toml`. A missing file is empty.
 * Secret values are paths, never the secret itself.
 */
export type PawsConfigFile = {
  linearMode: LinearConfigMode | null;
  linearTeam: string | null;
  linearTeamId: string | null;
  linearViewerId: string | null;
  /** Path relative to `~/.paws`, or absolute. */
  linearSecret: string | null;
  linearClientFile: string | null;
  webhooks: boolean | null;
  githubAuth: GitHubConfigAuth | null;
  repo: string | null;
  publicUrl: string | null;
  closeoutBin: string | null;
  checkout: string | null;
  maxTurns: number | null;
  maxAwakeMs: number | null;
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

export function emptyConfigFile(): PawsConfigFile {
  return {
    linearMode: null,
    linearTeam: null,
    linearTeamId: null,
    linearViewerId: null,
    linearSecret: null,
    linearClientFile: null,
    webhooks: null,
    githubAuth: null,
    repo: null,
    publicUrl: null,
    closeoutBin: null,
    checkout: null,
    maxTurns: null,
    maxAwakeMs: null,
  };
}

/** Parse `config.toml` written by `paws setup`. A missing file is empty. */
export function loadConfigFile(path: string): PawsConfigFile {
  if (!existsSync(path)) return emptyConfigFile();
  return parseConfigToml(readFileSync(path, "utf8"));
}

/** The setup writer’s subset: sections, comments, quoted strings, integers, booleans. */
export function parseConfigToml(text: string): PawsConfigFile {
  const config = emptyConfigFile();
  let section = "";
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = stripComment(lines[index] ?? "").trim();
    if (line.length === 0) continue;
    const heading = /^\[([A-Za-z0-9_-]+)\]$/.exec(line);
    if (heading?.[1]) {
      section = heading[1].toLowerCase();
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) throw new Error(`config.toml line ${index + 1} is not a key`);
    const key = line.slice(0, eq).trim().toLowerCase();
    const raw = line.slice(eq + 1).trim();
    if (key.length === 0 || raw.length === 0) {
      throw new Error(`config.toml line ${index + 1} is not a key`);
    }
    assignConfig(config, section, key, parseValue(raw, index + 1), index + 1);
  }
  return config;
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

function stripComment(line: string): string {
  let quote = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') quote = false;
      continue;
    }
    if (char === '"') {
      quote = true;
      continue;
    }
    if (char === "#") return line.slice(0, index);
  }
  return line;
}

function parseValue(raw: string, line: number): string | number | boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (raw.startsWith('"')) return parseString(raw, line);
  throw new Error(`config.toml line ${line} has an unsupported value`);
}

function parseString(raw: string, line: number): string {
  if (!raw.endsWith('"') || raw.length < 2) {
    throw new Error(`config.toml line ${line} has an unclosed string`);
  }
  let out = "";
  for (let index = 1; index < raw.length - 1; index += 1) {
    const char = raw[index];
    if (char !== "\\") {
      out += char;
      continue;
    }
    const next = raw[index + 1];
    if (next === "\\" || next === '"') {
      out += next;
      index += 1;
      continue;
    }
    throw new Error(`config.toml line ${line} has an unknown escape`);
  }
  return out;
}

function assignConfig(
  config: PawsConfigFile,
  section: string,
  key: string,
  value: string | number | boolean,
  line: number,
): void {
  if (section === "linear") {
    if (key === "mode") config.linearMode = linearMode(value, line);
    else if (key === "team") config.linearTeam = asString(value, line);
    else if (key === "team_id") config.linearTeamId = asString(value, line);
    else if (key === "viewer_id") config.linearViewerId = asString(value, line);
    else if (key === "secret") config.linearSecret = asString(value, line);
    else if (key === "client_file") config.linearClientFile = asString(value, line);
    else if (key === "webhooks") config.webhooks = asBoolean(value, line);
    return;
  }
  if (section === "github") {
    if (key === "auth") config.githubAuth = githubAuth(value, line);
    else if (key === "repo") config.repo = asString(value, line);
    return;
  }
  if (section === "closeout") {
    if (key === "bin") config.closeoutBin = asString(value, line);
    return;
  }
  if (section === "checkout") {
    if (key === "path") config.checkout = asString(value, line);
    return;
  }
  if (section === "caps") {
    if (key === "max_turns") config.maxTurns = asInt(value, line);
    else if (key === "max_awake_ms") config.maxAwakeMs = asInt(value, line);
    return;
  }
  if (section === "" || section === "server") {
    if (key === "public_url") config.publicUrl = asString(value, line);
    else if (key === "repo") config.repo = asString(value, line);
    else if (key === "linear_team" || key === "team") config.linearTeam = asString(value, line);
  }
}

function linearMode(value: string | number | boolean, line: number): LinearConfigMode {
  const mode = asString(value, line);
  if (mode === "comments" || mode === "agent-session") return mode;
  if (mode === "agent") return "agent-session";
  throw new Error(`config.toml line ${line} linear.mode must be comments or agent-session`);
}

function githubAuth(value: string | number | boolean, line: number): GitHubConfigAuth {
  const auth = asString(value, line);
  if (auth === "gh" || auth === "app") return auth;
  throw new Error(`config.toml line ${line} github.auth must be gh or app`);
}

function asString(value: string | number | boolean, line: number): string {
  if (typeof value !== "string") throw new Error(`config.toml line ${line} must be a string`);
  return value;
}

function asBoolean(value: string | number | boolean, line: number): boolean {
  if (typeof value !== "boolean") throw new Error(`config.toml line ${line} must be true or false`);
  return value;
}

function asInt(value: string | number | boolean, line: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`config.toml line ${line} must be a non-negative integer`);
  }
  return value;
}
