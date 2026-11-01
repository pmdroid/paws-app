import type { LivePreviewSystem } from "./runtime";

export interface FakeLivePreviewSystem extends LivePreviewSystem {
  spawned: { command: string; cwd: string; env: Record<string, string> }[];
  tailscaleCalls: string[][];
  killed: number[];
  released: number[];
  exit(): void;
}

export function createFakeLivePreviewSystem(
  options: {
    pid?: number;
    children?: number[];
    listenerPids?: (number | null)[];
    answersAfter?: number;
    warmAfter?: number;
    slots?: number;
    suffix?: string;
  } = {},
): FakeLivePreviewSystem {
  const pid = options.pid ?? 4100;
  let clock = 0;
  let probes = 0;
  let warms = 0;
  let taken = 0;
  let exit!: () => void;
  const exited = new Promise<void>((done) => (exit = done));
  const system: FakeLivePreviewSystem = {
    spawned: [],
    tailscaleCalls: [],
    killed: [],
    released: [],
    exit: () => exit(),
    spawn(command, { cwd, env }) {
      system.spawned.push({ command, cwd, env });
      return { pid, exited, kill: () => (system.killed.push(pid), exit()) };
    },
    async answers() {
      return ++probes > (options.answersAfter ?? 0);
    },
    async listeners(_port, candidates) {
      return (options.listenerPids ?? [pid]).map((owner) =>
        owner !== null && candidates.has(owner) ? owner : null,
      );
    },
    async tree() {
      return new Set([pid, ...(options.children ?? [])]);
    },
    async claimSlot() {
      if (taken >= (options.slots ?? 1)) return null;
      const slot = ++taken;
      return { slot, release: () => system.released.push(slot) };
    },
    async tailscale(args) {
      system.tailscaleCalls.push([...args]);
      return args[0] === "status"
        ? {
            code: 0,
            stdout: JSON.stringify({ MagicDNSSuffix: options.suffix ?? "tail0.ts.net" }),
            stderr: "",
          }
        : { code: 0, stdout: "", stderr: "" };
    },
    async warm() {
      return ++warms > (options.warmAfter ?? 0);
    },
    async sleep(ms) {
      clock += ms;
    },
    now: () => clock,
  };
  return system;
}
