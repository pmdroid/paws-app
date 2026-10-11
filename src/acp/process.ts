import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { buildDockerRun, type DockerAgent } from "../sandbox";

export interface DockerSpawnOption {
  /** Absolute worktree. The only bind mount. */
  worktree: string;
  agent: DockerAgent;
  /** Allow-list proxy URL. Required so the container names that proxy and no other egress. */
  proxyUrl: string;
  image?: string;
  /** Docker CLI. Defaults to `docker`. Tests pass a fake binary. */
  bin?: string;
  uid?: number;
  gid?: number;
}

export interface SpawnAgentOptions {
  /**
   * Run the agent in a container. Omit it and the host spawn is unchanged:
   * same command, args, env, detached process group, and stdio pipes.
   */
  docker?: DockerSpawnOption;
  /** Host working directory. Grok uses the worktree. Ignored for the docker plan. */
  cwd?: string;
}

export function spawnAgent(
  command: string,
  args: string[],
  env: Record<string, string>,
  options?: SpawnAgentOptions,
): ChildProcess {
  const plan = options?.docker ? dockerPlan(command, args, env, options.docker) : undefined;
  const cwd = options?.cwd;
  const child = spawn(plan?.bin ?? command, plan?.args ?? args, {
    env: plan?.env ?? env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    ...(cwd ? { cwd } : {}),
  });
  child.stdin?.on("error", () => undefined);
  child.stdout?.on("error", () => undefined);
  child.stderr?.on("error", () => undefined);
  return child;
}

function dockerPlan(
  command: string,
  args: string[],
  env: Record<string, string>,
  docker: DockerSpawnOption,
): ReturnType<typeof buildDockerRun> {
  return buildDockerRun({
    agent: docker.agent,
    worktree: docker.worktree,
    command,
    args,
    proxyUrl: docker.proxyUrl,
    hostEnv: env,
    ...(docker.image ? { image: docker.image } : {}),
    ...(docker.bin ? { bin: docker.bin } : {}),
    ...(docker.uid !== undefined ? { uid: docker.uid } : {}),
    ...(docker.gid !== undefined ? { gid: docker.gid } : {}),
  });
}

export function captureStderr(child: ChildProcess, limit = 64_000): { text(): string } {
  let text = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    text = (text + chunk).slice(-limit);
  });
  return { text: () => text };
}

export function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid == null) return;
  if (child.exitCode != null || child.signalCode != null) {
    killCapturedDescendants(child, signal);
    return;
  }
  captureDescendants(child);
  try {
    process.kill(-child.pid, signal);
  } catch {
    if (child.exitCode != null || child.signalCode != null) return;
    try {
      child.kill(signal);
    } catch {
      // The process is already gone.
    }
  }
}

interface ProcessIdentity {
  pid: number;
  group: number;
  session: number;
  started: string;
}

const capturedDescendants = new WeakMap<ChildProcess, Map<number, ProcessIdentity>>();

function processIdentity(pid: number): ProcessIdentity | undefined {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    const started = fields[19];
    if (!started) return undefined;
    return { pid, group: Number(fields[2]), session: Number(fields[3]), started };
  } catch {
    return undefined;
  }
}

function captureDescendants(child: ChildProcess): void {
  if (process.platform !== "linux" || child.pid == null) return;
  const leader = processIdentity(child.pid);
  if (!leader || leader.group !== child.pid) return;
  const members = capturedDescendants.get(child) ?? new Map<number, ProcessIdentity>();
  capturedDescendants.set(child, members);
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const member = processIdentity(Number(entry));
    if (
      member &&
      member.pid !== leader.pid &&
      member.group === leader.group &&
      member.session === leader.session &&
      BigInt(member.started) >= BigInt(leader.started)
    ) {
      members.set(member.pid, member);
    }
  }
}

function killCapturedDescendants(child: ChildProcess, signal: NodeJS.Signals): void {
  const members = capturedDescendants.get(child);
  if (!members) return;
  for (const member of members.values()) {
    const current = processIdentity(member.pid);
    if (!current || current.started !== member.started) {
      members.delete(member.pid);
      continue;
    }
    try {
      process.kill(member.pid, signal);
    } catch {
      members.delete(member.pid);
    }
  }
}

export function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, ms);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

export async function stopChild(child: ChildProcess, graceMs: number): Promise<boolean> {
  if (child.exitCode != null || child.signalCode != null) {
    killTree(child, "SIGKILL");
    return true;
  }
  killTree(child, "SIGTERM");
  if (await waitForExit(child, graceMs)) {
    killTree(child, "SIGKILL");
    return true;
  }
  killTree(child, "SIGKILL");
  return waitForExit(child, graceMs);
}
