import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isInside } from "./permissions";

export interface AgentSandbox {
  writable: readonly string[];
  maxSeconds?: number;
  launcher?: string;
}

export const SYSTEMD_RUN = "/usr/bin/systemd-run";

const userEnv = () => ({
  PATH: "/usr/bin:/bin",
  LANG: "C",
  XDG_RUNTIME_DIR: `/run/user/${process.getuid?.() ?? 0}`,
});

const safePath = (path: string) => {
  if (!/^\/[A-Za-z0-9._/@+-]*$/.test(path)) throw new Error("Unsafe sandbox path");
  return resolve(path);
};

export function sandboxedLaunch(input: {
  command: string;
  args: readonly string[];
  env: Record<string, string>;
  cwd: string;
  scratch: string;
  readOnly: string;
  sandbox: AgentSandbox;
}) {
  const readOnly = safePath(input.readOnly);
  const scratch = safePath(input.scratch);
  const granted = input.sandbox.writable.map(safePath);
  for (const path of [scratch, ...granted.filter((grant) => !isInside(readOnly, grant))])
    if (isInside(path, readOnly)) throw new Error("A sandbox writable path holds the worktree");
  const unit = `paws-helper-${randomUUID()}.service`;
  const envFile = join(scratch, `${unit}.env`);
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
    `RuntimeMaxSec=${input.sandbox.maxSeconds ?? 900}`,
    `EnvironmentFile=${envFile}`,
    ...[scratch, ...granted].map((path) => `ReadWritePaths=${path}`),
  ];
  return {
    unit,
    command: input.sandbox.launcher ?? SYSTEMD_RUN,
    args: [
      "--user",
      "--quiet",
      "--pipe",
      "--wait",
      "--collect",
      "--service-type=exec",
      `--unit=${unit}`,
      `--working-directory=${safePath(input.cwd)}`,
      ...properties.flatMap((property) => ["-p", property]),
      "--",
      input.command,
      ...input.args,
    ],
    env: userEnv(),
    async cleanup() {
      rmSync(envFile, { force: true });
      await new Promise<void>((done) => {
        execFile(
          "/usr/bin/systemctl",
          ["--user", "--no-ask-password", "stop", unit],
          { env: userEnv(), timeout: 30_000 },
          () => done(),
        );
      });
    },
  };
}
