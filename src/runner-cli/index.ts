import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { createRunnerHostSampler, openRunnerDaemon } from "../runner-daemon";
import { ExecutionIdSchema } from "../runner-execution";
import { runRunnerWorker } from "../runner-worker";
import { runPairedDaemon } from "./daemon";

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
    throw new Error("Runner service identity is invalid");
  const id = Number(value.trim());
  if (!Number.isSafeInteger(id)) throw new Error("Runner service identity is invalid");
  return id;
}

function accounts() {
  if (process.platform !== "linux") throw new Error("Runner commands require Linux");
  const runnerUid = account("user", "paws-runner");
  const agentUid = account("user", "paws-agent");
  if (runnerUid === 0 || agentUid === 0) throw new Error("Runner identities must be non-root");
  return {
    runnerUid,
    agentUid: runnerUid,
    agentGid: account("group", "paws-agent"),
    resultsGid: account("group", "paws-results"),
  };
}

function loadConfig(path: string, runnerUid: number) {
  if (!isAbsolute(path)) throw new Error("Runner configuration must use an absolute path");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.size > 65536 ||
      ![0, runnerUid].includes(info.uid) ||
      ![0o600, 0o640].includes(info.mode & 0o7777)
    )
      throw new Error("Runner configuration must be a protected regular file");
    const bytes = Buffer.alloc(65537);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, size);
      if (count === 0) break;
      size += count;
    }
    if (size > 65536) throw new Error("Runner configuration exceeds its size limit");
    return configuration.parse(JSON.parse(bytes.subarray(0, size).toString("utf8")));
  } finally {
    closeSync(fd);
  }
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
  try {
    const [operation, ...args] = argv;
    const ids = accounts();
    abort.signal.throwIfAborted();
    if (operation === "worker") {
      if (
        args[0] !== "--execution-id" ||
        !(args.length === 2 || (args.length === 3 && args[2] === "--resume"))
      )
        throw new Error("Invalid worker command");
      const executionId = ExecutionIdSchema.parse(args[1]);
      if (process.getuid?.() !== ids.agentUid) throw new Error("Worker identity is invalid");
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
      });
      abort.signal.throwIfAborted();
      return 0;
    }
    const daemonCommand =
      operation === "daemon" && args.length === 2 && args[0] === "--config" && Boolean(args[1]);
    if (
      !daemonCommand &&
      (operation !== "pair" ||
        args.length !== 4 ||
        args[0] !== "--config" ||
        !args[1] ||
        args[2] !== "--name" ||
        !args[3])
    )
      throw new Error("Invalid pairing command");
    if (process.getuid?.() !== ids.runnerUid) throw new Error("Pairing identity is invalid");
    const daemon = openRunnerDaemon({
      root: "/var/lib/paws-runner",
      ...loadConfig(args[1]!, ids.runnerUid),
      sampleHost: createRunnerHostSampler({ workRoot: "/var/lib/paws-runner" }),
    });
    try {
      if (daemonCommand) {
        await runPairedDaemon(daemon, ids, abort.signal, (failure) =>
          error(`Runner operation failed: ${failure.message.slice(0, 300)}`),
        );
        abort.signal.throwIfAborted();
        return 0;
      }
      const current = daemon.status();
      if (current.phase === "paired") {
        write(
          JSON.stringify({
            paired: true,
            runnerId: current.runnerId,
            workspaceId: current.workspaceId,
          }),
        );
        return 0;
      }
      const pending = await daemon.beginPairing(args[3]!);
      abort.signal.throwIfAborted();
      if (pending.phase !== "pending") throw new Error("Pairing is not pending");
      write(JSON.stringify(pending));
      while (!abort.signal.aborted) {
        const status = await daemon.pollPairing();
        abort.signal.throwIfAborted();
        if (status.phase === "paired") {
          write(
            JSON.stringify({
              paired: true,
              runnerId: status.runnerId,
              workspaceId: status.workspaceId,
            }),
          );
          return 0;
        }
        await delay(2000, undefined, { signal: abort.signal });
      }
      return 130;
    } finally {
      daemon.close();
    }
  } catch {
    if (abort.signal.aborted) return 130;
    error("Runner command failed. Check the service identity, configuration and pairing.");
    return 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    options.signal?.removeEventListener("abort", stop);
  }
}
