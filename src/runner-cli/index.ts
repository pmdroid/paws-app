import { journalCaught } from "../journal";
import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { createRunnerHostSampler, EnrollmentTokenSchema, openRunnerDaemon } from "../runner-daemon";
import { ExecutionIdSchema, RUNNER_SKILLS_ENV } from "../runner-execution";
import { runRunnerWorker } from "../runner-worker";
import { describeRunnerFailure, RunnerCliFailure, journalRunnerFailure } from "./cause";
import { runPairedDaemon } from "./daemon";

export {
  CAUSE_LIMIT,
  describeRunnerFailure,
  RUNNER_FAILURE,
  RunnerCliFailure,
  runnerFailureLine,
  journalRunnerFailure,
} from "./cause";

const configuration = z.strictObject({
  controlPlaneUrl: z.string().max(2048),
  runnerApiUrl: z.string().max(2048),
  allowedRepositories: z.array(z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/)).max(256),
  serverCa: z.string().max(32768).optional(),
  concurrency: z.number().int().min(1).max(16).default(2),
});

function account(kind: "user" | "group", name: string): number {
  const value =
    kind === "user"
      ? execFileSync("/usr/bin/id", ["-u", name], {
          env: { PATH: "/usr/bin:/bin" },
          encoding: "utf8",
        })
      : execFileSync("/usr/bin/getent", ["group", name], {
          env: { PATH: "/usr/bin:/bin" },
          encoding: "utf8",
        }).split(":")[2];
  if (!value || !/^[1-9][0-9]*$/.test(value.trim()))
    throw new RunnerCliFailure("identity", "Runner service identity is invalid.");
  const id = Number(value.trim());
  if (!Number.isSafeInteger(id))
    throw new RunnerCliFailure("identity", "Runner service identity is invalid.");
  return id;
}

function accounts() {
  if (process.platform !== "linux")
    throw new RunnerCliFailure("identity", "Runner commands require Linux.");
  const runnerUid = account("user", "paws-runner");
  const agentUid = account("user", "paws-agent");
  if (runnerUid === 0 || agentUid === 0)
    throw new RunnerCliFailure("identity", "Runner identities must be non-root.");
  return {
    runnerUid,
    agentUid: runnerUid,
    runnerGid: account("group", "paws-runner"),
    agentGid: account("group", "paws-agent"),
    resultsGid: account("group", "paws-results"),
  };
}

/** Why an open of a protected file failed, by error code only. */
function openFailure(what: string, error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return `${what} is missing.`;
  if (code === "ELOOP") return `${what} must not be a symbolic link.`;
  if (code === "EACCES" || code === "EPERM") return `${what} is not readable by this account.`;
  const safe = typeof code === "string" && /^E[A-Z]{1,15}$/.test(code) ? code : "unknown error";
  return `${what} could not be opened (${safe}).`;
}

/** The configuration keys a validation error names: known keys only, never a value. */
function configFields(error: z.ZodError): string {
  const known = new Set(Object.keys(configuration.shape));
  const fields = [
    ...new Set(
      error.issues.flatMap((issue) =>
        issue.code === "unrecognized_keys"
          ? ["an unknown key"]
          : typeof issue.path[0] === "string" && known.has(issue.path[0])
            ? [issue.path[0]]
            : [],
      ),
    ),
  ];
  return fields.length > 0 ? `: ${fields.join(", ")}` : "";
}

export function loadConfig(path: string, runnerUid: number) {
  if (!isAbsolute(path))
    throw new RunnerCliFailure("config", "Runner configuration must use an absolute path.");
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    throw new RunnerCliFailure("config", openFailure("Runner configuration", error));
  }
  try {
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.size > 65536 ||
      ![0, runnerUid].includes(info.uid) ||
      ![0o600, 0o640].includes(info.mode & 0o7777)
    )
      throw new RunnerCliFailure(
        "config",
        "Runner configuration must be a protected regular file owned by root or the runner, mode 0600 or 0640.",
      );
    const bytes = Buffer.alloc(65537);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, size);
      if (count === 0) break;
      size += count;
    }
    if (size > 65536)
      throw new RunnerCliFailure("config", "Runner configuration exceeds its size limit.");
    let value: unknown;
    try {
      value = JSON.parse(bytes.subarray(0, size).toString("utf8"));
    } catch {
      throw new RunnerCliFailure("config", "Runner configuration is not valid JSON.");
    }
    const parsed = configuration.safeParse(value);
    if (!parsed.success)
      throw new RunnerCliFailure(
        "config",
        `Runner configuration has invalid fields${configFields(parsed.error)}.`,
      );
    return parsed.data;
  } finally {
    closeSync(fd);
  }
}

/**
 * The enrollment token from a root-owned mode 0600 file, or null when the file is gone (a retried
 * bootstrap on a host that already enrolled). The token never travels through argv.
 */
export function readTokenFile(path: string): string | null {
  if (!isAbsolute(path))
    throw new RunnerCliFailure("token", "Enrollment token must use an absolute path.");
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      journalCaught(
        error,
        "runner-cli.readTokenFile.openSync",
        null,
        "optional file may be absent",
      );
      return null;
    }
    throw new RunnerCliFailure("token", openFailure("Enrollment token file", error));
  }
  try {
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.size > 4096 ||
      info.uid !== 0 ||
      (info.mode & 0o7777) !== 0o600
    )
      throw new RunnerCliFailure("token", "Enrollment token must be a root-owned mode 0600 file.");
    const bytes = Buffer.alloc(4097);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, size);
      if (count === 0) break;
      size += count;
    }
    if (size > 4096)
      throw new RunnerCliFailure("token", "Enrollment token exceeds its size limit.");
    const token = bytes.subarray(0, size).toString("utf8").trim();
    if (!EnrollmentTokenSchema.safeParse(token).success)
      throw new RunnerCliFailure("token", "Enrollment token file does not hold a valid token.");
    return token;
  } finally {
    closeSync(fd);
  }
}

/** Run as root only to read the token, then continue as the runner account. */
function dropToRunner(ids: { runnerUid: number; runnerGid: number }) {
  process.setgroups!([ids.runnerGid]);
  process.setgid!(ids.runnerGid);
  process.setuid!(ids.runnerUid);
  if (process.getuid?.() !== ids.runnerUid || process.getgid?.() !== ids.runnerGid)
    throw new RunnerCliFailure("identity", "Runner identity could not be assumed.");
}

export async function runRunnerCli(
  argv: readonly string[],
  options: {
    signal?: AbortSignal;
    write?: (value: string) => void;
    error?: (value: string) => void;
  } = {},
): Promise<number> {
  const write = options.write ?? ((value) => console.log(value));
  const error = options.error ?? ((value) => console.error(value));
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stop();
  /** Values a printed cause must never contain. */
  const secrets: string[] = [];
  try {
    const [operation, ...args] = argv;
    const ids = accounts();
    abort.signal.throwIfAborted();
    if (operation === "worker") {
      if (
        args[0] !== "--execution-id" ||
        !(args.length === 2 || (args.length === 3 && args[2] === "--resume"))
      )
        throw new RunnerCliFailure("usage", "Invalid worker command.");
      const executionId = ExecutionIdSchema.parse(args[1]);
      if (process.getuid?.() !== ids.agentUid)
        throw new RunnerCliFailure("identity", "Worker identity is invalid.");
      await runRunnerWorker({
        executionId,
        spool: {
          root: "/var/lib/paws-runner-spool",
          runnerUid: ids.runnerUid,
          agentGid: ids.agentGid,
        },
        results: {
          root: "/var/lib/paws-agent-results",
          agentUid: ids.agentUid,
          resultsGid: ids.resultsGid,
        },
        workRoot: "/var/lib/paws-agent/work",
        home: process.env.HOME ?? "/var/lib/paws-agent",
        signal: abort.signal,
        resume: args[2] === "--resume",
        ...(process.env[RUNNER_SKILLS_ENV] ? { skills: process.env[RUNNER_SKILLS_ENV] } : {}),
      });
      abort.signal.throwIfAborted();
      return 0;
    }
    if (operation === "enroll") {
      if (
        args.length !== 6 ||
        args[0] !== "--config" ||
        !args[1] ||
        args[2] !== "--name" ||
        !args[3] ||
        args[4] !== "--token-file" ||
        !args[5]
      )
        throw new RunnerCliFailure("usage", "Invalid enrollment command.");
      if (process.getuid?.() !== 0)
        throw new RunnerCliFailure("identity", "Enrollment must start as root.");
      const token = readTokenFile(args[5]);
      if (token !== null) secrets.push(token);
      dropToRunner(ids);
      const daemon = openRunnerDaemon({
        root: "/var/lib/paws-runner",
        ...loadConfig(args[1], ids.runnerUid),
      });
      try {
        if (token === null && daemon.status().phase !== "paired")
          throw new RunnerCliFailure(
            "token",
            "Enrollment token file is missing and the runner is not paired.",
          );
        const status = await daemon.enroll(args[3], token ?? "");
        abort.signal.throwIfAborted();
        if (status.phase !== "paired") throw new Error("Enrollment did not pair the runner");
        write(
          JSON.stringify({
            paired: true,
            runnerId: status.runnerId,
            workspaceId: status.workspaceId,
          }),
        );
        return 0;
      } finally {
        daemon.close();
      }
    }
    if (operation !== "daemon" || args.length !== 2 || args[0] !== "--config" || !args[1])
      throw new RunnerCliFailure("usage", "Invalid daemon command.");
    if (process.getuid?.() !== ids.runnerUid)
      throw new RunnerCliFailure("identity", "Runner service identity is invalid.");
    const daemon = openRunnerDaemon({
      root: "/var/lib/paws-runner",
      ...loadConfig(args[1]!, ids.runnerUid),
      sampleHost: createRunnerHostSampler({ workRoot: "/var/lib/paws-runner" }),
    });
    try {
      await runPairedDaemon(daemon, ids, abort.signal, (failure) =>
        error(`Runner operation failed: ${describeRunnerFailure(failure)}`),
      );
      abort.signal.throwIfAborted();
      return 0;
    } finally {
      daemon.close();
    }
  } catch (caught) {
    if (abort.signal.aborted) {
      journalCaught(
        "Runner command canceled.",
        "runner-cli.runRunnerCli",
        null,
        "cancellation requested",
        error,
      );
      return 130;
    }
    journalRunnerFailure(caught, secrets, error);
    return 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    options.signal?.removeEventListener("abort", stop);
  }
}
