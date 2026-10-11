import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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
import { killTree, stopChild } from "./process";
import { decidePermission, resolveInsideWorktree, type GuardContext } from "./permissions";

const DEFAULT_OUTPUT_LIMIT = 1_000_000;

interface LiveTerminal {
  output: string;
  truncated: boolean;
  limit: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  done: Promise<void>;
  child: ChildProcess;
}

export class TerminalRegistry {
  private readonly terminals = new Map<string, LiveTerminal>();
  private readonly children = new Set<ChildProcess>();
  private seq = 0;
  private closing: Promise<void> | undefined;

  constructor(
    private readonly guard: GuardContext,
    private readonly baseEnv: NodeJS.ProcessEnv,
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
    const child = spawn(params.command, params.args ?? [], {
      cwd: params.cwd ? resolveInsideWorktree(params.cwd, this.guard) : this.guard.worktree,
      env,
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
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

  release(params: ReleaseTerminalRequest): ReleaseTerminalResponse {
    const terminal = this.get(params.terminalId);
    killTree(terminal.child, "SIGTERM");
    this.terminals.delete(params.terminalId);
    return {};
  }

  close(graceMs: number): Promise<void> {
    this.closing ??= Promise.all([...this.children].map((child) => stopChild(child, graceMs))).then(
      () => {
        this.terminals.clear();
        this.children.clear();
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
  const path = resolveInsideWorktree(params.path, guard);
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
