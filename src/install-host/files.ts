import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseConfigToml, setConfigKeys } from "../config";
import type { InstallAnswers } from "./answers";

export const ENV_FILE = "https.env";
export const UNIT_NAME = "paws.service";
export const DROP_IN_FILE = "working-directory.conf";

/** Restarts for a public TLS renewal (`PUBLIC_TLS_RESTART_EXIT`). */
const TLS_RESTART_EXIT = 75;

export type UnitPaths = { unit: string; dropIn: string };

export function unitPaths(userHome: string, configHome?: string): UnitPaths {
  const dir = join(configHome || join(userHome, ".config"), "systemd", "user");
  return { unit: join(dir, UNIT_NAME), dropIn: join(dir, `${UNIT_NAME}.d`, DROP_IN_FILE) };
}

const MANAGED_ENV = [
  "PAWS_HOME",
  "PAWS_HOST",
  "PAWS_PORT",
  "PAWS_PUBLIC_URL",
  "PAWS_PUBLIC_DASHBOARD",
  "PAWS_RUNNER_HOST",
  "PAWS_RUNNER_PORT",
] as const;

/** `KEY=value` pairs from an env file. Values are never printed. */
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match) continue;
    const raw = match[2]!.trim();
    values[match[1]!] = /^(["']).*\1$/.test(raw) ? raw.slice(1, -1) : raw;
  }
  return values;
}

/** The env file with the installer's keys set, keeping every other line in place. */
export function renderEnvFile(current: string, answers: InstallAnswers): string {
  const next: Record<string, string | null> = {
    PAWS_HOME: answers.home,
    PAWS_HOST: answers.host,
    PAWS_PORT: String(answers.port),
    PAWS_PUBLIC_URL: answers.publicUrl || null,
    PAWS_PUBLIC_DASHBOARD: answers.publicDashboard ? "1" : "0",
    PAWS_RUNNER_HOST: answers.runnerHost || null,
    PAWS_RUNNER_PORT: answers.runnerHost ? String(answers.runnerPort) : null,
  };
  const written = new Set<string>();
  const lines: string[] = [];
  for (const line of current.length === 0 ? [] : current.replace(/\n$/, "").split(/\r?\n/)) {
    const key = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
    if (key === undefined || !(MANAGED_ENV as readonly string[]).includes(key)) {
      lines.push(line);
      continue;
    }
    if (written.has(key)) continue;
    written.add(key);
    const value = next[key];
    if (value !== null && value !== undefined) lines.push(`${key}=${value}`);
  }
  for (const key of MANAGED_ENV) {
    const value = next[key];
    if (!written.has(key) && value !== null) lines.push(`${key}=${value}`);
  }
  return `${lines.join("\n")}\n`;
}

/** `config.toml` with the Linear team, repositories and VM size set, keeping every other key. */
export function renderConfig(current: string, answers: InstallAnswers): string {
  const [repo, ...repos] = answers.githubRepos;
  let text = setConfigKeys(current, "linear", { team: answers.linearTeam || null });
  text = setConfigKeys(text, "github", {
    repo: repo ?? null,
    repos: repos.length > 0 ? repos : null,
  });
  const size = answers.memberVm;
  text = setConfigKeys(text, "member_vm", {
    cpu: size.cpu ?? null,
    memory_gb: size.memoryGb ?? null,
    disk_gb: size.diskGb ?? null,
    image: size.image ?? null,
  });
  parseConfigToml(text);
  return text;
}

export function renderUnit(input: { envFile: string; bun: string }): string {
  return [
    "[Unit]",
    "Description=Paws control plane",
    "Wants=network-online.target",
    "After=network-online.target",
    "StartLimitIntervalSec=60",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=exec",
    `EnvironmentFile=${input.envFile}`,
    "Environment=NODE_ENV=production",
    `ExecStart=${input.bun} --no-env-file src/index.ts --no-tunnel`,
    `ExecReload=${input.bun} --no-env-file src/index.ts public-tls validate`,
    "ExecReload=/bin/kill -HUP $MAINPID",
    "Restart=on-failure",
    `RestartForceExitStatus=${TLS_RESTART_EXIT}`,
    "RestartSec=5",
    "KillMode=control-group",
    "TimeoutStopSec=30",
    "UMask=0077",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function renderDropIn(checkout: string): string {
  return `[Service]\nWorkingDirectory=${checkout}\n`;
}

/** What an earlier install wrote, read back from the unit and its drop-in. */
export function installedUnit(paths: UnitPaths): { envFile?: string; checkout?: string } {
  const unit = readText(paths.unit);
  const dropIn = readText(paths.dropIn);
  return {
    envFile: /^EnvironmentFile=-?(.+)$/m.exec(unit)?.[1]?.trim(),
    checkout: /^WorkingDirectory=(.+)$/m.exec(dropIn)?.[1]?.trim(),
  };
}

export function readText(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** Atomically write when the bytes differ. Returns whether the file changed. */
export function writeIfChanged(path: string, text: string, mode: number): boolean {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path) && readFileSync(path, "utf8") === text) {
    chmodSync(path, mode);
    return false;
  }
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
  return true;
}
