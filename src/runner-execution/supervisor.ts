import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  constants,
  fchmodSync,
  fchownSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { ExecutionIdSchema } from "./jobs";
import { readRunnerJob, type RunnerSpool } from "./spool";
import type { RunnerResults } from "./results";
import type { RunnerBrokerClient } from "./broker";

const MEMBER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function startTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const command = stat.lastIndexOf(")");
    if (command < 0) return;
    const fields = stat.slice(command + 2).split(" ");
    if (fields[0] === "Z" || fields[0] === "X") return;
    return fields[19];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function openDirectory(path: string): number {
  if (!isAbsolute(path) || path.split("/").some((part) => part === "." || part === ".."))
    throw new Error("Invalid runner directory");
  let fd = openSync("/", constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    for (const part of path.split("/").filter(Boolean)) {
      const next = openSync(
        `/proc/self/fd/${fd}/${part}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      closeSync(fd);
      fd = next;
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function ensureDirectory(path: string, uid: number, gid: number, mode: number): void {
  const parent = openDirectory(dirname(path));
  try {
    const name = basename(path);
    try {
      mkdirSync(`/proc/self/fd/${parent}/${name}`, { mode });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const directory = openSync(
      `/proc/self/fd/${parent}/${name}`,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      fchmodSync(directory, mode);
      fchownSync(directory, uid, gid);
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function killRecorded(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && code !== "EPERM") throw error;
    try {
      process.kill(pid, "SIGKILL");
    } catch (direct) {
      if ((direct as NodeJS.ErrnoException).code !== "ESRCH") throw direct;
    }
  }
}

function workerLaunch(executionId: string, home: string, log: number) {
  const script = process.argv[1];
  const args =
    script && /\.(ts|js|mjs|cjs)$/.test(script)
      ? [script, "runner", "worker", "--execution-id", executionId]
      : ["runner", "worker", "--execution-id", executionId];
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: "/opt/paws-runner/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    LANG: "C.UTF-8",
  };
  for (const key of ["USER", "LOGNAME"] as const) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return spawn(process.execPath, args, {
    cwd: home,
    detached: true,
    stdio: ["ignore", log, log],
    env,
  });
}

export function createDirectWorkerSupervisor(options: {
  stateRoot: string;
  spool?: RunnerSpool;
  results?: RunnerResults;
  taskRoot?: string;
  memberHomes?: string;
  launch?: (
    executionId: string,
    home: string,
    log: number,
  ) => {
    pid?: number;
    unref(): void;
    on?(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
  };
}): RunnerBrokerClient {
  const taskRoot = options.taskRoot ?? "/var/lib/paws-agent-tasks";
  const memberHomes = options.memberHomes ?? "/var/lib/paws-runner-members";
  const launch = options.launch ?? workerLaunch;
  mkdirSync(options.stateRoot, { recursive: true, mode: 0o700 });
  function homeFor(executionId: string): string {
    if (!options.spool || !options.results) return process.env.HOME ?? "/var/lib/paws-agent";
    const job = readRunnerJob(options.spool, executionId);
    ensureDirectory(
      join(options.results.root, executionId),
      options.results.agentUid,
      options.results.resultsGid,
      0o750,
    );
    const gid = process.getgid?.() ?? options.results.agentUid;
    if (job.command.type === "task")
      ensureDirectory(join(taskRoot, executionId), options.results.agentUid, gid, 0o700);
    const member = job.command.memberId;
    if (member === undefined) return "/var/lib/paws-agent";
    if (!MEMBER.test(member) || !MEMBER.test(job.command.workspaceId))
      throw new Error("Invalid member identity");
    const identity = createHash("sha256")
      .update(JSON.stringify([job.command.workspaceId, member]))
      .digest("hex");
    const home = join(memberHomes, identity);
    ensureDirectory(home, options.results.agentUid, gid, 0o700);
    return home;
  }
  function receipt(executionId: string): string {
    ExecutionIdSchema.parse(executionId);
    return join(options.stateRoot, `${executionId}.pid`);
  }
  function logPath(executionId: string): string {
    ExecutionIdSchema.parse(executionId);
    return join(options.stateRoot, `${executionId}.log`);
  }
  return {
    async start(executionId) {
      const path = receipt(executionId);
      const home = homeFor(executionId);
      let fd: number;
      try {
        fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return { alreadyAdmitted: true };
        throw error;
      }
      let child: ReturnType<typeof launch> | undefined;
      const log = openSync(
        logPath(executionId),
        constants.O_CREAT | constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        child = launch(executionId, home, log);
        child.on?.("exit", (code, signal) => {
          try {
            appendFileSync(
              logPath(executionId),
              `Runner worker exited with ${signal ? `signal ${signal}` : `code ${code}`}\n`,
            );
          } catch {}
        });
        if (child.pid === undefined) throw new Error("Runner worker did not start");
        const born = startTime(child.pid);
        if (born === undefined) throw new Error("Runner worker did not start");
        writeSync(fd, `${child.pid} ${born}\n`);
        fsyncSync(fd);
        syncDirectory(options.stateRoot);
        child.unref();
        return { alreadyAdmitted: false };
      } catch (error) {
        try {
          unlinkSync(path);
        } catch (unlinkError) {
          if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
        }
        syncDirectory(options.stateRoot);
        if (child?.pid !== undefined) killRecorded(child.pid);
        throw error;
      } finally {
        closeSync(fd);
        closeSync(log);
      }
    },
    alive(executionId) {
      let recorded: string;
      try {
        recorded = readFileSync(receipt(executionId), "utf8").trim();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
        throw error;
      }
      const [pidText, born] = recorded.split(" ");
      const pid = Number(pidText);
      return Number.isSafeInteger(pid) && pid > 1 && !!born && startTime(pid) === born;
    },
    log(executionId) {
      try {
        const text = readFileSync(logPath(executionId), "utf8").slice(-4000);
        return text.split("\n").slice(-20).join("\n");
      } catch {
        return "";
      }
    },
    async stop(executionId) {
      let recorded: string;
      try {
        recorded = readFileSync(receipt(executionId), "utf8").trim();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      const [pidText, born] = recorded.split(" ");
      const pid = Number(pidText);
      if (!born || !Number.isSafeInteger(pid) || pid <= 1 || startTime(pid) !== born) return;
      killRecorded(pid);
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (startTime(pid) !== born) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("Runner worker did not exit");
    },
  };
}
