/**
 * Rule probes.
 *
 * A probe's bytes come from the policy, never from the candidate checkout. The
 * runner writes them to a scratch directory outside the checkout and starts
 * `exec` + that path + `--base <sha> --head <sha> --repo <checkout>`, with a
 * disposable `HOME` and `TMPDIR` in that scratch directory. The probe's working
 * directory is the scratch directory too, so a `bunfig.toml` or similar file in
 * the candidate does not configure it. The checkout must be clean before and
 * after the probe, and `HEAD` must not move: a probe judges the committed
 * candidate, so uncommitted changes in the checkout fail the rule.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { CommandRunResult, ResolvedRule } from "../types";
import { credentialSecrets, scrubCommandEnv } from "./env";
import { porcelain, readHead, spawnArgv } from "./exec";
import type { CloseoutOutputStream } from "./progress";
import { scrubText } from "./scrub";
import { probeArgv } from "../rule-result";

export { probeArgv, probeArtifactPath } from "../rule-result";

/** Seconds a probe may run. A rule has no timeout of its own. */
export const PROBE_TIMEOUT_SECONDS = 120;

export function probeSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export type ProbeExecution = CommandRunResult & {
  /** Lowercase hex SHA-256 of the bytes that ran. */
  probeSha256: string;
  stdout: string;
  stderr: string;
};

/**
 * Run `bytes` as `rule`'s probe against `checkout` at `head`. `artifacts` is empty: the caller
 * stores the log and the probe.
 */
export async function executeProbe(input: {
  rule: Pick<ResolvedRule, "exec" | "probe">;
  bytes: Uint8Array;
  base: string;
  head: string;
  checkout: string;
  timeoutSeconds: number;
  /** Parent environment. Credentials and `PAWS_HOME` are removed; `HOME` and `TMPDIR` replaced. */
  env?: NodeJS.ProcessEnv;
  onOutput?: (stream: CloseoutOutputStream, text: string, truncated: boolean) => void;
}): Promise<ProbeExecution> {
  const secrets = credentialSecrets(input.env);
  const gitEnv = scrubCommandEnv(input.env);
  const scratch = mkdtempSync(join(tmpdir(), "paws-probe-"));
  try {
    const home = join(scratch, "home");
    const temp = join(scratch, "tmp");
    const program = join(scratch, "probe", basename(input.rule.probe));
    for (const dir of [home, temp, dirname(program)]) mkdirSync(dir, { mode: 0o700 });
    writeFileSync(program, input.bytes, { mode: 0o400 });
    const env = probeEnv(gitEnv, home, temp);
    const argv = [
      ...input.rule.exec,
      program,
      "--base",
      input.base,
      "--head",
      input.head,
      "--repo",
      input.checkout,
    ];
    const before = await porcelain(input.checkout, gitEnv);
    const started = Date.now();
    const spawned = await spawnArgv(argv, scratch, env, input.timeoutSeconds, {
      secrets,
      ...(input.onOutput ? { onText: input.onOutput } : {}),
    });
    const durationMs = Math.max(0, Date.now() - started);
    const after = await porcelain(input.checkout, gitEnv);
    const head = await readHead(input.checkout, gitEnv);
    return {
      argv: probeArgv(input.rule, input.base, input.head),
      exitCode: spawned.exitCode,
      timedOut: spawned.timedOut,
      dirty: !clean(before) || !clean(after),
      headMoved: head === null || head !== input.head.toLowerCase(),
      durationMs,
      truncated: spawned.truncated,
      artifacts: [],
      probeSha256: probeSha256(input.bytes),
      stdout: scrubText(spawned.stdout, secrets),
      stderr: scrubText(spawned.stderr, secrets),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** An empty, readable `git status`. Unreadable status counts as dirt. */
function clean(status: Buffer | null): boolean {
  return status !== null && status.length === 0;
}

function probeEnv(
  parent: Record<string, string>,
  home: string,
  temp: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parent)) {
    if (key === "PAWS_HOME" || key.startsWith("XDG_")) continue;
    env[key] = value;
  }
  return { ...env, HOME: home, TMPDIR: temp, TMP: temp, TEMP: temp };
}

export type ProbeRunRequest = {
  rule: ResolvedRule;
  /** Policy bytes of the probe. Undefined when the policy did not carry them. */
  bytes: Uint8Array | undefined;
  base: string;
  head: string;
  /** Detached worktree of the candidate. Passed as `--repo`. */
  checkout: string;
  /** {@link probeArgv} of the rule. */
  argv: string[];
  timeoutSeconds: number;
  logFile: string;
  artifactPath: string;
  onOutput?: (stream: CloseoutOutputStream, text: string, truncated: boolean) => void;
};

export type ProbeRunResult = CommandRunResult & { probeSha256: string };

/**
 * Runs one rule's probe. `undefined` means there is no result, which leaves the rule missing and
 * blocks the pull request.
 */
export type ProbeRunner = {
  runProbe(request: ProbeRunRequest): Promise<ProbeRunResult | undefined>;
};

/** Runs the policy bytes on this machine and writes the log to `logFile`. */
export function createProbeRunner(options: { env?: NodeJS.ProcessEnv } = {}): ProbeRunner {
  return {
    async runProbe(request) {
      if (request.bytes === undefined) return undefined;
      const ran = await executeProbe({
        rule: request.rule,
        bytes: request.bytes,
        base: request.base,
        head: request.head,
        checkout: request.checkout,
        timeoutSeconds: request.timeoutSeconds,
        ...(options.env !== undefined ? { env: options.env } : {}),
        ...(request.onOutput ? { onOutput: request.onOutput } : {}),
      });
      const { stdout, stderr, ...result } = ran;
      return { ...result, artifacts: [writeProbeLog(request, stdout, stderr)] };
    },
  };
}

/** Writes the log a command writes, and returns its artifact. */
export function writeProbeLog(
  request: Pick<ProbeRunRequest, "logFile" | "artifactPath">,
  stdout: string,
  stderr: string,
): { path: string; sha256: string } {
  const bytes = Buffer.from(`STDOUT\n${stdout}\nSTDERR\n${stderr}`, "utf8");
  mkdirSync(dirname(request.logFile), { recursive: true, mode: 0o700 });
  writeFileSync(request.logFile, bytes, { mode: 0o600 });
  return { path: request.artifactPath, sha256: probeSha256(bytes) };
}
