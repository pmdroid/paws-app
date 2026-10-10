import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export type LinearConfigMode = "comments" | "agent-session";
export type GitHubConfigAuth = "oauth" | "gh" | "app";
export type TrackerKind = "github" | "linear" | "both";

export type TrackerGithubConfig = {
  triggerLabel: string;
  mention: string;
  trusted: string[];
  repos: string[];
  statusLabels: boolean;
};

export const DEFAULT_TRACKER_GITHUB: TrackerGithubConfig = {
  triggerLabel: "paws",
  mention: "@paws",
  trusted: ["OWNER", "MEMBER", "COLLABORATOR"],
  repos: [],
  statusLabels: true,
};

/** Public OAuth client id. `PAWS_GITHUB_CLIENT_ID` overrides it. No secret. */
export const PAWS_GITHUB_OAUTH_CLIENT_ID = "Iv1.paws-oauth-placeholder";

export const IMPLEMENTERS = ["claude", "grok", "codex"] as const;

export type ImplementerName = (typeof IMPLEMENTERS)[number];

export type GrokConfig = {
  /** Set only to use a PATH or absolute `grok`. Otherwise Paws uses the pinned package. */
  path: string | null;
  allowApiKey: boolean;
};

export type AgentsConfig = {
  implementer: ImplementerName;
  grok: GrokConfig;
};

export function defaultAgents(): AgentsConfig {
  return {
    implementer: "claude",
    grok: { path: null, allowApiKey: false },
  };
}

export function isImplementer(value: string): value is ImplementerName {
  return (IMPLEMENTERS as readonly string[]).includes(value);
}

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
  oauthClientId: string | null;
  /** True when `[tracker]` or `[tracker.github]` is present. Absent means linear. */
  trackerSpecified: boolean;
  trackerKind: TrackerKind | null;
  trackerGithub: TrackerGithubConfig;
  repo: string | null;
  publicUrl: string | null;
  checkout: string | null;
  maxTurns: number | null;
  maxAwakeMs: number | null;
  agents: AgentsConfig;
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
  githubAuth: GitHubConfigAuth;
  oauthClientId?: string;
  trackerKind?: TrackerKind;
  trackerGithub?: TrackerGithubConfig;
  repo: string;
  checkout: string;
  maxTurns: number;
  maxAwakeMs: number;
  implementer: ImplementerName;
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
    oauthClientId: null,
    trackerSpecified: false,
    trackerKind: null,
    trackerGithub: {
      ...DEFAULT_TRACKER_GITHUB,
      trusted: [...DEFAULT_TRACKER_GITHUB.trusted],
      repos: [...DEFAULT_TRACKER_GITHUB.repos],
    },
    repo: null,
    publicUrl: null,
    checkout: null,
    maxTurns: null,
    maxAwakeMs: null,
    agents: defaultAgents(),
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
    const heading = /^\[([A-Za-z0-9_.-]+)\]$/.exec(line);
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
  lines.push("", "[github]", `auth = ${tomlString(config.githubAuth)}`);
  if (config.oauthClientId !== undefined && config.oauthClientId.length > 0) {
    lines.push(`oauth_client_id = ${tomlString(config.oauthClientId)}`);
  }
  lines.push(`repo = ${tomlString(config.repo)}`);
  if (config.trackerKind !== undefined) {
    const github = config.trackerGithub ?? DEFAULT_TRACKER_GITHUB;
    lines.push(
      "",
      "[tracker]",
      `kind = ${tomlString(config.trackerKind)}`,
      "",
      "[tracker.github]",
      `trigger_label = ${tomlString(github.triggerLabel)}`,
      `mention = ${tomlString(github.mention)}`,
      `trusted = ${tomlStringArray(github.trusted)}`,
      `repos = ${tomlStringArray(github.repos)}`,
      `status_labels = ${github.statusLabels ? "true" : "false"}`,
    );
  }
  lines.push(
    "",
    "[checkout]",
    `path = ${tomlString(config.checkout)}`,
    "",
    "[caps]",
    `max_turns = ${tomlInt(config.maxTurns)}`,
    `max_awake_ms = ${tomlInt(config.maxAwakeMs)}`,
    "",
    "[agents]",
    `implementer = ${tomlString(config.implementer)}`,
    "",
    "[agents.grok]",
    "allow_api_key = false",
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

function tomlStringArray(values: readonly string[]): string {
  return `[${values.map((value) => tomlString(value)).join(", ")}]`;
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

function parseValue(raw: string, line: number): string | number | boolean | string[] {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw.startsWith("[")) return parseArray(raw, line);
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (raw.startsWith('"')) return parseString(raw, line);
  throw new Error(`config.toml line ${line} has an unsupported value`);
}

function parseArray(raw: string, line: number): string[] {
  if (!raw.endsWith("]")) throw new Error(`config.toml line ${line} has an unclosed array`);
  const inner = raw.slice(1, -1).trim();
  if (inner.length === 0) return [];
  const parts: string[] = [];
  let buf = "";
  let quote = false;
  let escaped = false;
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index] ?? "";
    if (quote) {
      buf += char;
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
      buf += char;
      continue;
    }
    if (char === ",") {
      parts.push(buf.trim());
      buf = "";
      continue;
    }
    buf += char;
  }
  if (buf.trim().length > 0) parts.push(buf.trim());
  return parts.map((part) => {
    if (!part.startsWith('"')) {
      throw new Error(`config.toml line ${line} has an unsupported array value`);
    }
    return parseString(part, line);
  });
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
  value: string | number | boolean | string[],
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
    else if (key === "oauth_client_id") config.oauthClientId = asString(value, line);
    else if (key === "repo") config.repo = asString(value, line);
    return;
  }
  if (section === "tracker") {
    config.trackerSpecified = true;
    if (key === "kind") config.trackerKind = trackerKind(value, line);
    return;
  }
  if (section === "tracker.github") {
    config.trackerSpecified = true;
    if (key === "trigger_label") config.trackerGithub.triggerLabel = asString(value, line);
    else if (key === "mention") config.trackerGithub.mention = asString(value, line);
    else if (key === "trusted") config.trackerGithub.trusted = asStringArray(value, line);
    else if (key === "repos") config.trackerGithub.repos = asStringArray(value, line);
    else if (key === "status_labels") config.trackerGithub.statusLabels = asBoolean(value, line);
    return;
  }
  if (section === "closeout") {
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
  if (section === "agents") {
    if (key === "implementer") config.agents.implementer = implementerName(value, line);
    return;
  }
  if (section === "agents.grok") {
    if (key === "path") config.agents.grok.path = asString(value, line);
    else if (key === "allow_api_key") config.agents.grok.allowApiKey = asBoolean(value, line);
    return;
  }
  if (section === "" || section === "server") {
    if (key === "public_url") config.publicUrl = asString(value, line);
    else if (key === "repo") config.repo = asString(value, line);
    else if (key === "linear_team" || key === "team") config.linearTeam = asString(value, line);
  }
}

/** Write `agents.implementer`, keeping every other line. Mode is always 0600. */
export function writeImplementer(path: string, implementer: ImplementerName): void {
  if (!isImplementer(implementer)) {
    throw new Error("agents.implementer must be claude, grok, or codex");
  }
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const next = setImplementerText(current, implementer);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, next.endsWith("\n") ? next : `${next}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function implementerName(
  value: string | number | boolean | string[],
  line: number,
): ImplementerName {
  const name = asString(value, line);
  if (!isImplementer(name)) {
    throw new Error(`config.toml line ${line} agents.implementer must be claude, grok, or codex`);
  }
  return name;
}

function setImplementerText(current: string, implementer: ImplementerName): string {
  const lines = current.split(/\r?\n/);
  const assignment = `implementer = "${implementer}"`;
  let section = "";
  let header = -1;
  let replaced = false;
  const next = lines.map((line, index) => {
    const trimmed = stripComment(line).trim();
    const headerMatch = /^\[([A-Za-z0-9_.-]+)]$/.exec(trimmed);
    if (headerMatch) {
      section = headerMatch[1] ?? "";
      if (section === "agents" && header === -1) header = index;
      return line;
    }
    if (section === "agents" && /^implementer\s*=/.test(trimmed)) {
      replaced = true;
      const indent = /^(\s*)/.exec(line)?.[1] ?? "";
      return `${indent}${assignment}`;
    }
    return line;
  });
  if (replaced) return next.join("\n");
  if (header >= 0) {
    next.splice(header + 1, 0, assignment);
    return next.join("\n");
  }
  const body = current.trim().length === 0 ? "" : current.replace(/\s*$/, "\n");
  return `${body}[agents]\n${assignment}\n`;
}

function linearMode(value: string | number | boolean | string[], line: number): LinearConfigMode {
  const mode = asString(value, line);
  if (mode === "comments" || mode === "agent-session") return mode;
  if (mode === "agent") return "agent-session";
  throw new Error(`config.toml line ${line} linear.mode must be comments or agent-session`);
}

function githubAuth(value: string | number | boolean | string[], line: number): GitHubConfigAuth {
  const auth = asString(value, line);
  if (auth === "oauth" || auth === "gh" || auth === "app") return auth;
  throw new Error(`config.toml line ${line} github.auth must be oauth, gh, or app`);
}

function trackerKind(value: string | number | boolean | string[], line: number): TrackerKind {
  const kind = asString(value, line);
  if (kind === "github" || kind === "linear" || kind === "both") return kind;
  throw new Error(`config.toml line ${line} tracker.kind must be github, linear, or both`);
}

function asString(value: string | number | boolean | string[], line: number): string {
  if (typeof value !== "string") throw new Error(`config.toml line ${line} must be a string`);
  return value;
}

function asStringArray(value: string | number | boolean | string[], line: number): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`config.toml line ${line} must be an array of strings`);
  }
  return value;
}

function asBoolean(value: string | number | boolean | string[], line: number): boolean {
  if (typeof value !== "boolean") throw new Error(`config.toml line ${line} must be true or false`);
  return value;
}

function asInt(value: string | number | boolean | string[], line: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`config.toml line ${line} must be a non-negative integer`);
  }
  return value;
}
