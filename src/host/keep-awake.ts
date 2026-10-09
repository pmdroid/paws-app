export type ChildProcess = { kill: () => void };

export type Spawn = (command: string, args: string[]) => ChildProcess | null;

export type KeepAwakeCommand = { command: string; args: string[] };

/**
 * macOS: `caffeinate -i -w <pid>` holds an idle assertion until that pid exits.
 * Linux: `systemd-inhibit --what=idle:sleep` blocks idle sleep. Closing the lid
 * still sleeps; this only stops the machine from dozing while a run is active.
 */
export function keepAwakeCommand(platform: string, pid: number): KeepAwakeCommand | null {
  if (platform === "darwin") {
    return { command: "caffeinate", args: ["-i", "-w", String(pid)] };
  }
  if (platform === "linux") {
    return {
      command: "systemd-inhibit",
      args: [
        "--what=idle:sleep",
        "--who=paws",
        "--why=Paws run active",
        "--mode=block",
        "sleep",
        "infinity",
      ],
    };
  }
  return null;
}

export function defaultSpawn(command: string, args: string[]): ChildProcess | null {
  try {
    const child = Bun.spawn([command, ...args], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    child.unref();
    return { kill: () => child.kill() };
  } catch {
    return null;
  }
}

export class KeepAwake {
  private child: ChildProcess | null = null;
  private held = false;

  constructor(
    readonly platform: string,
    readonly pid: number,
    private readonly spawn: Spawn = defaultSpawn,
  ) {}

  get isHeld(): boolean {
    return this.held;
  }

  setRunActive(active: boolean): void {
    if (active === this.held) return;
    if (!active) {
      this.child?.kill();
      this.child = null;
      this.held = false;
      return;
    }
    const spec = keepAwakeCommand(this.platform, this.pid);
    if (!spec) return;
    const child = this.spawn(spec.command, spec.args);
    if (!child) return;
    this.child = child;
    this.held = true;
  }

  release(): void {
    this.setRunActive(false);
  }
}
