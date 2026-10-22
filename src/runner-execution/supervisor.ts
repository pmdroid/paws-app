import { spawn } from "node:child_process";
import {
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

function startTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const command = stat.lastIndexOf(")");
    if (command < 0) return;
    return stat.slice(command + 2).split(" ")[19];
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

function workerLaunch(executionId: string, home: string, log: number, resume?: boolean) {
  const script = process.argv[1];
  const worker = [
    "runner",
    "worker",
    "--execution-id",
    executionId,
    ...(resume ? ["--resume"] : []),
  ];
  const args = script && /\.(ts|js|mjs|cjs)$/.test(script) ? [script, ...worker] : worker;
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
  launch?: (
    executionId: string,
    home: string,
    log: number,
    resume?: boolean,
  ) => {
    pid?: number;
    unref(): void;
    on?(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
  };
}): RunnerBrokerClient {
  const taskRoot = options.taskRoot ?? "/var/lib/paws-agent-tasks";
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
    return "/var/lib/paws-agent";
  }
  function receipt(executionId: string): string {
    ExecutionIdSchema.parse(executionId);
    return join(options.stateRoot, `${executionId}.pid`);
  }
  function recorded(executionId: string): { pid: number; born: string } | undefined {
    let text: string;
    try {
      text = readFileSync(receipt(executionId), "utf8").trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const [pidText, born] = text.split(" ");
    const pid = Number(pidText);
    if (!born || !Number.isSafeInteger(pid) || pid <= 1) return;
    return { pid, born };
  }
  function logPath(executionId: string): string {
    ExecutionIdSchema.parse(executionId);
    return join(options.stateRoot, `${executionId}.log`);
  }
  function alive(executionId: string): boolean {
    const worker = recorded(executionId);
    return worker !== undefined && startTime(worker.pid) === worker.born;
  }
  return {
    alive,
    async resume(executionId) {
      if (alive(executionId)) throw new Error("Runner worker is still running");
      try {
        unlinkSync(receipt(executionId));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await admit(executionId, true);
    },
    start: (executionId) => admit(executionId, false),
    log(executionId) {
      try {
        const text = readFileSync(logPath(executionId), "utf8").slice(-4000);
        return text.split("\n").slice(-20).join("\n");
      } catch {
        return "";
      }
    },
    async stop(executionId) {
      const worker = recorded(executionId);
      if (!worker || startTime(worker.pid) !== worker.born) return;
      const { pid, born } = worker;
      killRecorded(pid);
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (startTime(pid) !== born) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("Runner worker did not exit");
    },
  };
  async function admit(executionId: string, resume: boolean) {
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
      child = launch(executionId, home, log, resume);
      child.on?.("exit", (code, signal) => {
        try {
          const exit = openSync(logPath(executionId), constants.O_WRONLY | constants.O_APPEND);
          try {
            writeSync(
              exit,
              `Runner worker exited with ${signal ? `signal ${signal}` : `code ${code}`}\n`,
            );
          } finally {
            closeSync(exit);
          }
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
  }
}
