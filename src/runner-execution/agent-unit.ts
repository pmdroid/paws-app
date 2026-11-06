import { execFile } from "node:child_process";
import {
  closeSync,
  constants,
  fchmodSync,
  fchownSync,
  fsyncSync,
  openSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { journalCaught } from "../journal";
import { ExecutionIdSchema } from "./jobs";

export const RUNNER_AGENT_USER_ENV = "PAWS_AGENT_USER";

export const RUNNER_AGENT_ENV_ROOT = "/run/paws-runner/agent";

export type RunnerSystemctl = (
  args: readonly string[],
) => Promise<{ code: number; output: string }>;

export const runnerSystemctl: RunnerSystemctl = (args) =>
  new Promise((resolve) => {
    execFile(
      "/usr/bin/systemctl",
      ["--no-ask-password", ...args],
      { env: { PATH: "/usr/bin:/bin", LANG: "C" }, timeout: 60_000, encoding: "utf8" },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, output: `${stdout}${stderr}` });
      },
    );
  });

export function agentUnit(executionId: string): string {
  return `paws-agent@${ExecutionIdSchema.parse(executionId)}.service`;
}

export function agentUnitFailure(executionId: string, verb: "start" | "stop", output: string) {
  const reason = output.trim().split("\n")[0]?.slice(0, 200) || "systemctl failed";
  return new Error(
    `Runner worker could not ${verb} ${agentUnit(executionId)}: ${reason}. agentUser is "paws-agent" in /etc/paws-runner/config.json; set it to "runner" to run agents as paws-runner.`,
  );
}

function agentEnvPath(root: string, executionId: string): string {
  return join(root, `${ExecutionIdSchema.parse(executionId)}.env`);
}

export function writeAgentEnv(
  root: string,
  executionId: string,
  values: Record<string, string>,
  agentGid?: number,
): void {
  const lines = Object.entries(values).map(([key, value]) => {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || !/^[A-Za-z0-9._/:=+@-]*$/.test(value))
      throw new Error("Runner worker environment is not safe for an environment file");
    return `${key}=${value}\n`;
  });
  const fd = openSync(
    agentEnvPath(root, executionId),
    constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o640,
  );
  try {
    if (agentGid !== undefined) fchownSync(fd, process.getuid?.() ?? -1, agentGid);
    fchmodSync(fd, 0o640);
    writeSync(fd, lines.join(""));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function removeAgentEnv(root: string, executionId: string): void {
  try {
    unlinkSync(agentEnvPath(root, executionId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    journalCaught(
      error,
      "agent-unit.removeAgentEnv.unlinkSync",
      null,
      "optional file may be absent",
    );
  }
}
