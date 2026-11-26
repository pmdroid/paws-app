import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentProfile } from "../config";

type AgentName = AgentProfile["agent"];

export interface AgentSandbox {
  writable: readonly { root: string; relative: string }[];
}

const SESSION_DIRECTORIES: Record<AgentName, string> = {
  claude: ".claude/projects",
  codex: ".codex/sessions",
  grok: ".grok/sessions",
  opencode: ".local/share/opencode",
};

const userEnv = () => ({
  PATH: "/usr/bin:/bin",
  LANG: "C",
  XDG_RUNTIME_DIR: `/run/user/${process.getuid?.() ?? 0}`,
});

function plainDirectory(root: string, relative: string): string {
  let path = realpathSync(root);
  for (const part of relative.split("/").filter(Boolean)) {
    path = join(path, part);
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (!info) mkdirSync(path, { mode: 0o700 });
    else if (!info.isDirectory())
      throw new Error("A sandbox writable path is not a plain directory");
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
  const writable = [
    { root: input.scratch, relative: "" },
    { root: input.home, relative: SESSION_DIRECTORIES[input.agent] },
    ...input.sandbox.writable,
  ].map(({ root, relative }) => plainDirectory(root, relative));
  const unit = `paws-helper-${randomUUID()}.service`;
  const envFile = join(writable[0]!, `${unit}.env`);
  const lines = Object.entries(input.env).map(([key, value]) => {
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
    "InaccessiblePaths=/run/user",
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
    cleanup() {
      rmSync(envFile, { force: true });
      spawnSync("/usr/bin/systemctl", ["--user", "stop", unit], {
        env: userEnv(),
        timeout: 30_000,
      });
    },
  };
}
