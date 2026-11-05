import { journalCaught } from "../journal";
import { spawn } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { runnerCommandAccount, type RunnerAgentUser } from "../runner-protocol";
import { ExecutionIdSchema } from "./jobs";
import { executionScope, executionTag, startTime, stopExecutionProcesses } from "./processes";
import { readRunnerJob, type RunnerSpool } from "./spool";
import type { RunnerResults } from "./results";
import type { RunnerBrokerClient } from "./broker";
import type { RunnerSkillInstaller } from "./skills";
import { openSharedDirectory } from "./shared";
import {
  confirmRunnerAccountHold,
  holdRunnerAccountHome,
  openRunnerAccountHome,
  releaseRunnerAccountHome,
  runnerAccountHome,
  prepareRunnerWorkRoot,
  shareRunnerAgentState,
} from "./accounts";
import {
  agentUnit,
  agentUnitFailure,
  removeAgentEnv,
  RUNNER_AGENT_ENV_ROOT,
  runnerSystemctl,
  writeAgentEnv,
  type RunnerSystemctl,
} from "./agent-unit";

export const RUNNER_SKILLS_ENV = "PAWS_AGENT_SKILLS";

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

function ensureDirectory(path: string, gid: number, mode: number): void {
  const parent = openDirectory(dirname(path));
  try {
    const directory = openSharedDirectory(parent, basename(path), gid, mode);
    try {
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
    journalCaught(error, "supervisor.killRecorded.kill", null, "process may have exited");
    try {
      process.kill(pid, "SIGKILL");
    } catch (direct) {
      if ((direct as NodeJS.ErrnoException).code !== "ESRCH") throw direct;
      journalCaught(direct, "supervisor.killRecorded.kill", null, "process may have exited");
    }
  }
}

/** The rootless Docker daemon's socket that `paws-docker.service` (deploy/linux/install.py) runs for runner work as paws-runner. */
export const RUNNER_DOCKER_SOCKET = "/run/paws-docker/docker.sock";

/** `DOCKER_HOST` for runner work when the rootless Docker daemon's socket exists. */
export function runnerDockerEnv(socket = RUNNER_DOCKER_SOCKET): Record<string, string> {
  try {
    return lstatSync(socket, { throwIfNoEntry: false })?.isSocket()
      ? { DOCKER_HOST: `unix://${socket}` }
      : {};
  } catch (caught) {
    journalCaught(caught, "supervisor.runnerDockerEnv.lstatSync", null, "socket not reachable");
    return {};
  }
}

export function workerSpawn(
  executionId: string,
  home: string,
  log: number,
  resume?: boolean,
  tag: Record<string, string> = {},
  skills?: string,
) {
  const script = process.argv[1];
  const worker = [
    "runner",
    "worker",
    "--execution-id",
    executionId,
    ...(resume ? ["--resume"] : []),
  ];
  // The packaged launcher passes `--no-env-file --config=/dev/null`; the worker keeps the same Bun flags.
  const args =
    script && /\.(ts|js|mjs|cjs)$/.test(script) ? [...process.execArgv, script, ...worker] : worker;
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: "/opt/paws-runner/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    LANG: "C.UTF-8",
    ...runnerDockerEnv(),
    ...tag,
    ...(skills ? { [RUNNER_SKILLS_ENV]: skills } : {}),
  };
  for (const key of ["USER", "LOGNAME"] as const) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return [
    process.execPath,
    args,
    { cwd: home, detached: true, stdio: ["ignore", log, log], env },
  ] as const satisfies Parameters<typeof spawn>;
}

function workerLaunch(...input: Parameters<typeof workerSpawn>) {
  return spawn(...workerSpawn(...input));
}

export function createDirectWorkerSupervisor(options: {
  stateRoot: string;
  spool?: RunnerSpool;
  results?: RunnerResults;
  taskRoot?: string;
  agentUser?: RunnerAgentUser;
  systemctl?: RunnerSystemctl;
  agentEnvRoot?: string;
  /** The home every agent runs from. */
  agentHome?: string;
  /** Where run and review checkouts live, under the agent home. */
  workRoot?: string;
  /** Installs current skills into a home before its worker starts, and pins them for the run. */
  skills?: Pick<RunnerSkillInstaller, "prepareHome" | "hold" | "release">;
  launch?: (
    executionId: string,
    home: string,
    log: number,
    resume?: boolean,
    /** Environment that marks the worker and everything it starts as this execution's. */
    tag?: Record<string, string>,
    skills?: string,
  ) => {
    pid?: number;
    unref(): void;
    on?(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
  };
}): RunnerBrokerClient {
  const taskRoot = options.taskRoot ?? "/var/lib/paws-agent-tasks";
  const agentHome = options.agentHome ?? "/var/lib/paws-agent";
  const workRoot = options.workRoot ?? join(agentHome, "work");
  const launch = options.launch ?? workerLaunch;
  const asAgent = options.agentUser === "paws-agent";
  const systemctl = options.systemctl ?? runnerSystemctl;
  const agentEnvRoot = options.agentEnvRoot ?? RUNNER_AGENT_ENV_ROOT;
  const scope = executionScope(options.stateRoot);
  mkdirSync(options.stateRoot, { recursive: true, mode: 0o700 });
  const held = new Map<string, string>();
  const shared = new Set<string>();
  function homeFor(executionId: string): string {
    if (!options.spool || !options.results) return process.env.HOME ?? "/var/lib/paws-agent";
    const job = readRunnerJob(options.spool, executionId);
    const named = runnerCommandAccount(job.command);
    if (job.command.type === "task")
      ensureDirectory(join(taskRoot, executionId), options.spool.agentGid, 0o770);
    if (!named) return agentHome;
    return openRunnerAccountHome(agentHome, named.account, named.agent, {
      signIn: job.command.type === "login",
      owners: { runnerUid: options.spool.runnerUid, agentGid: options.spool.agentGid },
    });
  }
  function recordedHome(executionId: string): string | undefined {
    if (!options.spool) return;
    try {
      const named = runnerCommandAccount(readRunnerJob(options.spool, executionId).command);
      return named ? runnerAccountHome(agentHome, named.account) : undefined;
    } catch (caughtError3) {
      journalCaught(caughtError3, "supervisor.recordedHome.readRunnerJob", null);
      return;
    }
  }
  function release(executionId: string) {
    const home = held.get(executionId) ?? recordedHome(executionId);
    if (home) releaseRunnerAccountHome(home, executionId);
    held.delete(executionId);
    options.skills?.release(executionId);
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
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        journalCaught(error, "supervisor.recorded.trim", null, "optional file may be absent");
        return;
      }
      throw error;
    }
    const [pidText, born] = text.split(" ");
    const pid = Number(pidText);
    if (!born || !Number.isSafeInteger(pid) || pid <= 1) return;
    return { pid, born };
  }
  function logPath(executionId: string): string {
    ExecutionIdSchema.parse(executionId);
    if (asAgent) return join(agentEnvRoot, `${executionId}.log`);
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
      await stopExecutionProcesses(scope, (id) => id === executionId);
      try {
        unlinkSync(receipt(executionId));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        journalCaught(error, "supervisor.resume.unlinkSync", null, "optional file may be absent");
      }
      await admit(executionId, true);
    },
    start: (executionId) => admit(executionId, false),
    log(executionId) {
      try {
        const text = readFileSync(logPath(executionId), "utf8").slice(-4000);
        return text.split("\n").slice(-20).join("\n");
      } catch (caughtError1) {
        journalCaught(caughtError1, "supervisor.log.slice", null);
        return "";
      }
    },
    async stop(executionId) {
      const worker = recorded(executionId);
      if (asAgent) {
        if (existsSync(receipt(executionId))) await stopUnit(executionId);
      } else if (worker && startTime(worker.pid) === worker.born) {
        const { pid, born } = worker;
        killRecorded(pid);
        const deadline = Date.now() + 5_000;
        while (startTime(pid) === born) {
          if (Date.now() >= deadline) throw new Error("Runner worker did not exit");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      await stopExecutionProcesses(scope, (id) => id === executionId);
      release(executionId);
    },
    /** Stops processes left by executions whose worker is gone, such as before a restart. */
    sweep: () => stopExecutionProcesses(scope, (id) => !alive(id)),
  };
  async function stopUnit(executionId: string) {
    const stopped = await systemctl(["stop", agentUnit(executionId)]);
    if (stopped.code !== 0) throw agentUnitFailure(executionId, "stop", stopped.output);
    removeAgentEnv(agentEnvRoot, executionId);
  }
  async function startUnit(
    executionId: string,
    resume: boolean,
    skills: string | undefined,
  ): Promise<{ pid?: number }> {
    writeAgentEnv(
      agentEnvRoot,
      executionId,
      {
        PAWS_RESUME: resume ? "--resume" : "",
        ...(skills ? { [RUNNER_SKILLS_ENV]: skills } : {}),
        ...executionTag(scope, executionId),
        ...runnerDockerEnv(),
      },
      options.spool?.agentGid,
    );
    const started = await systemctl(["start", agentUnit(executionId)]);
    if (started.code !== 0) {
      removeAgentEnv(agentEnvRoot, executionId);
      throw agentUnitFailure(executionId, "start", started.output);
    }
    const shown = await systemctl([
      "show",
      "--property=MainPID",
      "--value",
      agentUnit(executionId),
    ]);
    const pid = Number(shown.output.trim());
    if (shown.code !== 0 || !Number.isSafeInteger(pid) || pid <= 1) {
      await stopUnit(executionId);
      throw new Error("Runner worker did not start");
    }
    return { pid };
  }
  async function admit(executionId: string, resume: boolean) {
    const path = receipt(executionId);
    const home = homeFor(executionId);
    let fd: number;
    try {
      fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        journalCaught(error, "supervisor.admit.openSync", null, "path may already exist");
        return { alreadyAdmitted: true };
      }
      throw error;
    }
    let child: ReturnType<typeof launch> | undefined;
    let unit = false;
    const log = openSync(
      logPath(executionId),
      constants.O_CREAT | constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      if (home !== agentHome && options.spool && options.results) {
        holdRunnerAccountHome(
          home,
          executionId,
          { scope },
          {
            runnerUid: options.spool.runnerUid,
            agentGid: options.spool.agentGid,
          },
        );
        held.set(executionId, home);
      }
      if (asAgent && options.spool) {
        const { command } = readRunnerJob(options.spool, executionId);
        if (command.type === "run" || command.type === "review" || command.type === "retro")
          prepareRunnerWorkRoot(
            workRoot,
            { runnerUid: options.spool.runnerUid, agentGid: options.spool.agentGid },
            command.type === "run" ? { name: command.runId, resume } : undefined,
          );
      }
      if (asAgent && options.spool && !shared.has(home)) {
        shareRunnerAgentState(home, {
          runnerUid: options.spool.runnerUid,
          agentGid: options.spool.agentGid,
        });
        shared.add(home);
      }
      options.skills?.prepareHome(home);
      const skills = options.skills?.hold(home, executionId);
      if (asAgent) {
        const started = await startUnit(executionId, resume, skills);
        unit = true;
        child = { ...started, unref() {} };
      } else
        child = launch(
          executionId,
          held.has(executionId) ? agentHome : home,
          log,
          resume,
          executionTag(scope, executionId),
          skills,
        );
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
        } catch (caughtError2) {
          journalCaught(caughtError2, "supervisor.admit.openSync", null);
        }
      });
      if (child.pid === undefined) throw new Error("Runner worker did not start");
      const born = startTime(child.pid);
      if (born === undefined) throw new Error("Runner worker did not start");
      writeSync(fd, `${child.pid} ${born}\n`);
      fsyncSync(fd);
      if (held.has(executionId) && options.spool)
        confirmRunnerAccountHold(
          home,
          executionId,
          { scope, pid: child.pid, born },
          { runnerUid: options.spool.runnerUid, agentGid: options.spool.agentGid },
        );
      syncDirectory(options.stateRoot);
      child.unref();
      return { alreadyAdmitted: false };
    } catch (error) {
      try {
        unlinkSync(path);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
        journalCaught(
          unlinkError,
          "supervisor.admit.unlinkSync",
          null,
          "optional file may be absent",
        );
      }
      syncDirectory(options.stateRoot);
      if (unit) await stopUnit(executionId);
      else if (child?.pid !== undefined) killRecorded(child.pid);
      release(executionId);
      throw error;
    } finally {
      closeSync(fd);
      closeSync(log);
    }
  }
}
