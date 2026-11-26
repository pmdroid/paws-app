import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { AgentProfile } from "../config";

const SESSION_DIRECTORIES: Partial<Record<AgentProfile["agent"], string>> = {
  claude: ".claude/projects",
  codex: ".codex/sessions",
  grok: ".grok/sessions",
};

const runtimeDirectory = () => `/run/user/${process.getuid!()}`;

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
  agent: AgentProfile["agent"];
  command: string;
  args: readonly string[];
  env: Record<string, string>;
  cwd: string;
  scratch: string;
  home: string;
}) {
  const session = SESSION_DIRECTORIES[input.agent];
  if (!session) throw new Error(`${input.agent} can't run in a sandboxed helper turn`);
  const scratch = plainDirectory(input.scratch, "");
  const sessions = plainDirectory(input.home, session);
  const turnSessions = plainDirectory(scratch, "sessions");
  const env = Object.fromEntries(
    Object.entries(input.env).filter(([key]) => key !== "DOCKER_HOST"),
  );
  const unit = `paws-helper-${randomUUID()}.service`;
  const properties = [
    "ProtectSystem=strict",
    "ProtectHome=read-only",
    "PrivateTmp=yes",
    "NoNewPrivileges=yes",
    "PrivateUsers=yes",
    "RestrictAddressFamilies=AF_INET AF_INET6",
    "InaccessiblePaths=/run/user -/run/paws-agent-docker -/run/paws-docker -/run/dbus",
    "RuntimeMaxSec=900",
    `ReadWritePaths=${scratch}`,
    `BindPaths=${turnSessions}:${sessions}`,
  ];
  return {
    command: "/usr/bin/systemd-run",
    args: [
      ...["--user", "--quiet", "--pipe", "--wait", "--collect", "--service-type=exec"],
      `--unit=${unit}`,
      `--working-directory=${input.cwd}`,
      ...properties.flatMap((property) => ["-p", property]),
      ...Object.keys(env).map((key) => `--setenv=${key}`),
      "--",
      input.command,
      ...input.args,
    ],
    env: { ...env, XDG_RUNTIME_DIR: runtimeDirectory() },
    cleanup() {
      spawnSync("/usr/bin/systemctl", ["--user", "stop", unit], {
        env: { PATH: "/usr/bin:/bin", XDG_RUNTIME_DIR: runtimeDirectory() },
        timeout: 30_000,
      });
    },
  };
}
