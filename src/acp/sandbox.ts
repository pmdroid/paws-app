import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentProfile } from "../config";

type AgentName = AgentProfile["agent"];

export interface AgentSandbox {
  probes?: string;
}

const SESSION_DIRECTORIES: Record<AgentName, string> = {
  claude: ".claude/projects",
  codex: ".codex/sessions",
  grok: ".grok/sessions",
  opencode: ".local/share/opencode",
};

const userEnv = () => ({
  PATH: "/usr/bin:/bin",
  XDG_RUNTIME_DIR: `/run/user/${process.getuid!()}`,
});

function plainDirectory(root: string, relative: string): string {
  let path = realpathSync(root);
  for (const part of relative.split("/").filter(Boolean)) {
    path = join(path, part);
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (!info) mkdirSync(path, { mode: 0o700 });
    else if (!info.isDirectory()) throw new Error("A sandbox path is not a plain directory");
  }
  if (!/^\/[A-Za-z0-9._/@+-]*$/.test(path)) throw new Error("Unsafe sandbox path");
  return path;
}

export function sandboxedLaunch(input: {
  agent: AgentName;
  command: string;
  args: readonly string[];
  env: Record<string, string>;
  cwd: string;
  scratch: string;
  home: string;
  sandbox: AgentSandbox;
}) {
  const { probes } = input.sandbox;
  const writable = [plainDirectory(input.scratch, "")];
  if (probes) writable.push(plainDirectory(probes, ".agents/probes"));
  const sessions = plainDirectory(input.home, SESSION_DIRECTORIES[input.agent]);
  const turnSessions = plainDirectory(input.scratch, "sessions");
  const unit = `paws-helper-${randomUUID()}.service`;
  const envFile = join(userEnv().XDG_RUNTIME_DIR, `${unit}.env`);
  const passed = Object.entries(input.env).filter(([key]) => key !== "DOCKER_HOST");
  const lines = passed.map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /[\0\n\r]/.test(value))
      throw new Error("Agent environment is not safe for a sandbox");
    return `${key}="${value.replace(/[\\"]/g, "\\$&")}"\n`;
  });
  writeFileSync(envFile, lines.join(""), { mode: 0o600, flag: "wx" });
  const properties = [
    "ProtectSystem=strict",
    "ProtectHome=read-only",
    "PrivateTmp=yes",
    "NoNewPrivileges=yes",
    "InaccessiblePaths=/run/user -/run/paws-docker -/run/paws-agent-docker -/run/docker.sock",
    `BindPaths=${turnSessions}:${sessions}`,
    "RuntimeMaxSec=900",
    `EnvironmentFile=${envFile}`,
    ...writable.map((path) => `ReadWritePaths=${path}`),
  ];
  return {
    command: "/usr/bin/systemd-run",
    args: [
      ...["--user", "--quiet", "--pipe", "--wait", "--collect", "--service-type=exec"],
      `--unit=${unit}`,
      `--working-directory=${input.cwd}`,
      ...properties.flatMap((property) => ["-p", property]),
      "--",
      input.command,
      ...input.args,
    ],
    env: userEnv(),
    started: () => rmSync(envFile, { force: true }),
    cleanup() {
      rmSync(envFile, { force: true });
      spawnSync("/usr/bin/systemctl", ["--user", "stop", unit], {
        env: userEnv(),
        timeout: 30_000,
      });
    },
  };
}
