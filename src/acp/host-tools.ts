import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import {
  RequestError,
  type CreateTerminalRequest,
  type CreateTerminalResponse,
  type KillTerminalRequest,
  type KillTerminalResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type ReleaseTerminalRequest,
  type ReleaseTerminalResponse,
  type TerminalOutputRequest,
  type TerminalOutputResponse,
  type WaitForTerminalExitRequest,
  type WaitForTerminalExitResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import { minimalAgentEnv } from "./env";
import { killTree, spawnAgent, stopChild, type OwnedProcess } from "./process";
import {
  decidePermission,
  isLocalSkillPath,
  resolveInsideWorktree,
  type GuardContext,
} from "./permissions";

const DEFAULT_OUTPUT_LIMIT = 1_000_000;

interface LiveTerminal {
  output: string;
  truncated: boolean;
  limit: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  done: Promise<void>;
  child: OwnedProcess;
}

export class TerminalRegistry {
  private readonly terminals = new Map<string, LiveTerminal>();
  private readonly children = new Set<OwnedProcess>();
  private seq = 0;
  private closing: Promise<boolean> | undefined;

  constructor(
    private readonly guard: GuardContext,
    private readonly baseEnv: NodeJS.ProcessEnv,
    private readonly attributionEnv: Record<string, string> = {},
  ) {}

  create(params: CreateTerminalRequest): CreateTerminalResponse {
    if (this.closing) throw RequestError.invalidParams({}, "run cancelled");
    const decision = decidePermission(
      {
        kind: "execute",
        command: params.command,
        args: params.args ?? [],
        cwd: params.cwd,
      },
      this.guard,
    );
    if (!decision.allow)
      throw RequestError.invalidParams({ reason: decision.reason }, decision.reason);
    if (params.cwd) resolveInsideWorktree(params.cwd, this.guard);

    const id = `term-${++this.seq}`;
    const limit = params.outputByteLimit ?? DEFAULT_OUTPUT_LIMIT;
    const env = {
      ...minimalAgentEnv(this.baseEnv),
      ...minimalAgentEnv(
        Object.fromEntries((params.env ?? []).map(({ name, value }) => [name, value])),
      ),
    };
    Object.assign(env, this.attributionEnv);
    const child = spawnAgent(params.command, params.args ?? [], env, {
      cwd: params.cwd ? resolveInsideWorktree(params.cwd, this.guard) : this.guard.worktree,
    });
    child.stdin?.end();
    const terminal: LiveTerminal = {
      output: "",
      truncated: false,
      limit,
      exitCode: null,
      signal: null,
      done: Promise.resolve(),
      child,
    };
    const append = (chunk: Buffer) => {
      if (terminal.output.length >= terminal.limit) {
        terminal.truncated = true;
        return;
      }
      const text = chunk.toString("utf8");
      const room = terminal.limit - terminal.output.length;
      terminal.output += text.slice(0, room);
      if (text.length > room) terminal.truncated = true;
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    terminal.done = new Promise((resolve) => {
      child.on("error", () => resolve());
      child.on("close", (code, signal) => {
        terminal.exitCode = code;
        terminal.signal = signal;
        resolve();
      });
    });
    this.terminals.set(id, terminal);
    this.children.add(child);
    return { terminalId: id };
  }

  output(params: TerminalOutputRequest): TerminalOutputResponse {
    const terminal = this.get(params.terminalId);
    return {
      output: terminal.output,
      truncated: terminal.truncated,
      ...(terminal.exitCode != null || terminal.signal != null
        ? { exitStatus: { exitCode: terminal.exitCode, signal: terminal.signal } }
        : {}),
    };
  }

  async wait(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
    const terminal = this.get(params.terminalId);
    await terminal.done;
    return { exitCode: terminal.exitCode, signal: terminal.signal };
  }

  kill(params: KillTerminalRequest): KillTerminalResponse {
    killTree(this.get(params.terminalId).child, "SIGTERM");
    return {};
  }

  async release(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> {
    const terminal = this.get(params.terminalId);
    if (!(await stopChild(terminal.child, 500)))
      throw RequestError.invalidParams({}, "terminal process cleanup could not be verified");
    this.children.delete(terminal.child);
    this.terminals.delete(params.terminalId);
    return {};
  }

  close(graceMs: number): Promise<boolean> {
    this.closing ??= Promise.all([...this.children].map((child) => stopChild(child, graceMs))).then(
      (stopped) => {
        this.terminals.clear();
        this.children.clear();
        return stopped.every(Boolean);
      },
    );
    return this.closing;
  }

  private get(id: string): LiveTerminal {
    const terminal = this.terminals.get(id);
    if (!terminal) throw RequestError.invalidParams({ terminalId: id }, `unknown terminal ${id}`);
    return terminal;
  }
}

export async function readGuarded(
  params: ReadTextFileRequest,
  guard: GuardContext,
): Promise<ReadTextFileResponse> {
  const decision = decidePermission({ kind: "read", locations: [{ path: params.path }] }, guard);
  if (!decision.allow)
    throw RequestError.invalidParams({ reason: decision.reason }, decision.reason);
  const path = isLocalSkillPath(params.path, guard)
    ? params.path.startsWith("~/")
      ? resolvePath(guard.home, params.path.slice(2))
      : resolvePath(guard.worktree, params.path)
    : resolveInsideWorktree(params.path, guard);
  let content = await readFile(path, "utf8");
  if (params.line != null || params.limit != null) {
    const lines = content.split("\n");
    const start = Math.max(0, (params.line ?? 1) - 1);
    const end = params.limit != null ? start + params.limit : lines.length;
    content = lines.slice(start, end).join("\n");
  }
  return { content };
}

export async function writeGuarded(
  params: WriteTextFileRequest,
  guard: GuardContext,
): Promise<WriteTextFileResponse> {
  const decision = decidePermission({ kind: "edit", locations: [{ path: params.path }] }, guard);
  if (!decision.allow)
    throw RequestError.invalidParams({ reason: decision.reason }, decision.reason);
  const path = resolveInsideWorktree(params.path, guard);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, params.content);
  return {};
}
