import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

/**
 * Names the runner execution a process belongs to. The runner sets it on each worker, and
 * every owned process inherits it, so the runner can find what an execution left behind.
 */
export const EXECUTION_TAG_ENV = "PAWS_RUNNER_EXECUTION_TAG";

export class OwnedProcess extends EventEmitter {
  readonly pid: number | undefined;
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  private readonly anchor: ChildProcess;
  private readonly closed: Promise<void>;
  private anchorClosed = false;
  private anchorKilled = false;
  private teardownConfirmed = false;
  private stopping: Promise<boolean> | undefined;
  private commandClosed = false;
  private outputClosed = 0;

  constructor(command: string, args: string[], env: Record<string, string>, cwd?: string) {
    super();
    if (process.platform === "win32") throw new Error("Owned ACP process groups require POSIX");
    const packaged = !process.execPath.endsWith("/bun");
    const tag = process.env[EXECUTION_TAG_ENV];
    if (tag) env = { ...env, [EXECUTION_TAG_ENV]: tag };
    this.anchor = spawn(
      packaged ? "/opt/paws-runner/bin/bun" : process.execPath,
      [
        "--no-env-file",
        packaged
          ? "/opt/paws-runner/current/src/process/process-anchor.ts"
          : fileURLToPath(new URL("./process-anchor.ts", import.meta.url)),
        JSON.stringify([command, args, cwd ?? process.cwd()]),
      ],
      {
        env,
        detached: true,
        stdio: ["pipe", "pipe", "pipe", "ipc"],
        serialization: "json",
        cwd: packaged
          ? "/opt/paws-runner/current/src/process"
          : fileURLToPath(new URL(".", import.meta.url)),
      },
    );
    this.pid = this.anchor.pid;
    this.stdin = this.anchor.stdin;
    this.stdout = this.anchor.stdout;
    this.stderr = this.anchor.stderr;
    for (const stream of [this.stdin, this.stdout, this.stderr])
      stream?.on("error", () => undefined);
    for (const stream of [this.stdout, this.stderr]) {
      stream?.once("close", () => {
        this.outputClosed += 1;
        this.closeCommand();
      });
    }
    this.anchor.on("message", (value) => {
      const message = value as {
        type: "exit" | "error" | "teardown" | "drained";
        code?: number | null;
        signal?: NodeJS.Signals | null;
        message?: string;
      };
      if (message.type === "teardown") this.teardownConfirmed = true;
      else if (message.type === "drained") this.emit("drained");
      else if (message.type === "error") this.emit("error", new Error(message.message));
      else {
        this.exitCode = message.code ?? null;
        this.signalCode = message.signal ?? null;
        this.emit("exit", this.exitCode, this.signalCode);
        this.closeCommand();
      }
    });
    this.anchor.on("error", (error) => this.emit("error", error));
    this.anchor.on("exit", (code, signal) => {
      this.anchorKilled = signal === "SIGKILL";
      if (this.exitCode === null && this.signalCode === null) {
        this.exitCode = code;
        this.signalCode = signal;
        this.emit("exit", code, signal);
        this.closeCommand();
      }
    });
    this.closed = new Promise((resolve) => {
      this.anchor.once("close", () => {
        this.anchorClosed = true;
        resolve();
      });
      this.anchor.once("error", () => {
        this.anchorClosed = true;
        resolve();
      });
    });
  }

  private closeCommand(): void {
    if (
      this.commandClosed ||
      this.outputClosed < 2 ||
      (this.exitCode === null && this.signalCode === null)
    )
      return;
    this.commandClosed = true;
    this.emit("close", this.exitCode, this.signalCode);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    return this.signal("command", signal);
  }

  killGroup(signal: NodeJS.Signals): void {
    this.signal("group", signal);
  }

  stop(graceMs: number): Promise<boolean> {
    this.stopping ??= this.teardown(graceMs);
    return this.stopping;
  }

  private signal(target: "group" | "command", signal: NodeJS.Signals): boolean {
    if (this.anchorClosed || !this.anchor.connected) return false;
    return this.anchor.send({ target, signal }, () => undefined);
  }

  private async teardown(graceMs: number): Promise<boolean> {
    if (!this.anchorClosed) {
      const drained = new Promise((resolve) => this.once("drained", resolve));
      this.killGroup("SIGTERM");
      await Promise.race([
        this.closed,
        drained,
        new Promise((resolve) => setTimeout(resolve, graceMs)),
      ]);
      this.killGroup("SIGKILL");
      await Promise.race([this.closed, new Promise((resolve) => setTimeout(resolve, graceMs))]);
    }
    this.stdin?.destroy();
    this.stdout?.destroy();
    this.stderr?.destroy();
    return this.anchorClosed && this.anchorKilled && this.teardownConfirmed;
  }
}
