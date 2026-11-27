import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentProfile } from "../config";

const SESSION_DIRECTORIES: Partial<Record<AgentProfile["agent"], string>> = {
  claude: ".claude/projects",
  codex: ".codex/sessions",
  grok: ".grok/sessions",
};

const OPENCODE_CREDENTIAL = ".paws/opencode-credential.json";
const OPENCODE_TURN = fileURLToPath(new URL("./opencode-turn.ts", import.meta.url));

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
  writable?: string;
}) {
  const scratch = plainDirectory(input.scratch, "");
  const writable = input.writable ? [plainDirectory(input.cwd, input.writable)] : [];
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(input.env).filter(([key]) => key !== "DOCKER_HOST" && key !== "OPENCODE_DB"),
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
    `ReadWritePaths=${[scratch, ...writable].join(" ")}`,
  ];
  let command = [input.command, ...input.args];
  let cwd = input.cwd;
  if (input.agent === "opencode") {
    const data = plainDirectory(scratch, "opencode");
    plainDirectory(input.home, ".config/opencode");
    properties.push(`TemporaryFileSystem=${data}:mode=0700`);
    Object.assign(env, {
      XDG_DATA_HOME: join(data, "share"),
      XDG_STATE_HOME: join(data, "state"),
      XDG_CACHE_HOME: join(data, "cache"),
      OPENCODE_DB: join(data, "share", "opencode", "opencode.db"),
    });
    command = [
      process.execPath,
      "--no-env-file",
      "--config=/dev/null",
      OPENCODE_TURN,
      join(input.home, OPENCODE_CREDENTIAL),
      env.OPENCODE_DB!,
      input.cwd,
      ...command,
    ];
    cwd = scratch;
  } else {
    const session = SESSION_DIRECTORIES[input.agent];
    if (!session) throw new Error(`${input.agent} can't run in a sandboxed helper turn`);
    const sessions = plainDirectory(input.home, session);
    properties.push(`BindPaths=${plainDirectory(scratch, "sessions")}:${sessions}`);
  }
  const launchEnv: Record<string, string> = { ...env, XDG_RUNTIME_DIR: runtimeDirectory() };
  return {
    command: "/usr/bin/systemd-run",
    args: [
      ...["--user", "--quiet", "--pipe", "--wait", "--collect", "--service-type=exec"],
      `--unit=${unit}`,
      `--working-directory=${cwd}`,
      ...properties.flatMap((property) => ["-p", property]),
      ...Object.keys(env).map((key) => `--setenv=${key}`),
      "--",
      ...command,
    ],
    env: launchEnv,
    cleanup() {
      spawnSync("/usr/bin/systemctl", ["--user", "stop", unit], {
        env: { PATH: "/usr/bin:/bin", XDG_RUNTIME_DIR: runtimeDirectory() },
        timeout: 30_000,
      });
    },
  };
}

export function writeSandboxed(
  params: { path: string; content: string },
  worktree: string,
  writable: string | undefined,
): Record<string, never> {
  const name = basename(params.path);
  if (
    !writable ||
    !isAbsolute(params.path) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) ||
    ![join(worktree, writable), join(realpathSync(worktree), writable)].includes(
      dirname(resolve(params.path)),
    )
  )
    throw new Error(`This agent session may write only under ${writable ?? "nothing"}`);
  const file = openSync(
    join(plainDirectory(worktree, writable), name),
    constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0o600,
  );
  try {
    if (!fstatSync(file).isFile()) throw new Error("A sandbox path is not a plain file");
    ftruncateSync(file, 0);
    writeSync(file, params.content);
  } finally {
    closeSync(file);
  }
  return {};
}
