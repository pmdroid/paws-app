import { createHash } from "node:crypto";
import { closeSync, constants, fsyncSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { credentialSecrets, scrubText, type PawsCommandRunner } from "../closeout-spec";
import {
  RunnerCheckInputSchema,
  RunnerCheckResultSchema,
  runnerCheckInputHash,
  type RunnerCheckInput,
  type RunnerCheckResult,
} from "../runner-check";

export interface RemoteCloseoutRequest {
  candidateSha: string;
  argv: string[];
  cwd: ".";
  timeoutMs: number;
}
export interface RemoteCloseoutExecution {
  input: RunnerCheckInput;
  result: RunnerCheckResult;
}
export function createRemoteCloseoutCommandRunner(options: {
  execute(request: RemoteCloseoutRequest, signal?: AbortSignal): Promise<RemoteCloseoutExecution>;
  signal?: AbortSignal;
  secrets?: readonly string[];
}): Pick<PawsCommandRunner, "runLogged"> {
  const secrets = options.secrets ?? credentialSecrets();
  return {
    async runLogged(request) {
      options.signal?.throwIfAborted();
      if (!isAbsolute(request.cwd) || !isAbsolute(request.logFile))
        throw new Error("Remote Closeout requires absolute local evidence paths");
      const dispatched: RemoteCloseoutRequest = {
        candidateSha: RunnerCheckInputSchema.shape.candidateSha.parse(request.expectedHead),
        argv: RunnerCheckInputSchema.shape.argv.parse(request.argv),
        cwd: ".",
        timeoutMs: RunnerCheckInputSchema.shape.timeoutMs.parse(request.timeoutSeconds * 1000),
      };
      const execution = await options.execute(dispatched, options.signal);
      options.signal?.throwIfAborted();
      const input = RunnerCheckInputSchema.parse(execution.input);
      const result = RunnerCheckResultSchema.parse(execution.result);
      if (
        input.candidateSha !== dispatched.candidateSha ||
        JSON.stringify(input.argv) !== JSON.stringify(dispatched.argv) ||
        input.timeoutMs !== dispatched.timeoutMs ||
        !input.cwd.endsWith(`/${input.verificationAttemptId}/workspace`) ||
        result.executionId !== input.executionId ||
        result.verificationAttemptId !== input.verificationAttemptId ||
        result.candidateSha !== input.candidateSha ||
        result.inputSha256 !== runnerCheckInputHash(input)
      )
        throw new Error("Trusted remote Closeout result binding changed");
      const cap = 262_144;
      const stdoutBytes = Buffer.from(result.stdout);
      const stderrBytes = Buffer.from(result.stderr);
      const truncated =
        result.stdoutTruncated ||
        result.stderrTruncated ||
        stdoutBytes.length > cap ||
        stderrBytes.length > cap;
      const stdout = scrubText(stdoutBytes.subarray(0, cap).toString("utf8"), secrets);
      const stderr = scrubText(stderrBytes.subarray(0, cap).toString("utf8"), secrets);
      request.onOutput?.("stdout", stdout, truncated);
      request.onOutput?.("stderr", stderr, truncated);
      const bytes = Buffer.from(`STDOUT\n${stdout}\nSTDERR\n${stderr}`, "utf8");
      mkdirSync(dirname(request.logFile), { recursive: true, mode: 0o700 });
      const file = openSync(
        request.logFile,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeFileSync(file, bytes);
        fsyncSync(file);
      } finally {
        closeSync(file);
      }
      return {
        argv: dispatched.argv,
        exitCode: result.exitCode ?? 128 + result.signal!,
        timedOut: result.timedOut,
        dirty: result.dirty,
        headMoved: result.headMoved,
        durationMs: result.durationMs,
        truncated,
        artifacts: [
          { path: request.artifactPath, sha256: createHash("sha256").update(bytes).digest("hex") },
        ],
      };
    },
  };
}
