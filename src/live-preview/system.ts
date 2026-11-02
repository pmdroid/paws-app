import { execFile, spawn } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeSync,
} from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { journalCaught } from "../journal";
import type { LivePreviewSystem } from "./runtime";

const PREVIEW_SLOT_LIMIT = 16;

function read(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    journalCaught(error, "live-preview.read", null, "process may have exited");
    return "";
  }
}

function list(path: string): string[] {
  try {
    return readdirSync(path);
  } catch (error) {
    journalCaught(error, "live-preview.list", null, "process may have exited");
    return [];
  }
}

export function listeningInodes(table: string, port: number): string[] {
  return table
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(
      (fields) =>
        fields.length > 9 &&
        fields[3] === "0A" &&
        Number.parseInt(fields[1]!.split(":")[1] ?? "", 16) === port,
    )
    .map((fields) => fields[9]!);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function createLivePreviewSystem(options: { lockDirectory: string }): LivePreviewSystem {
  return {
    spawn(command, { cwd, env }) {
      const child = spawn("/bin/sh", ["-c", command], {
        cwd,
        env,
        detached: true,
        stdio: "ignore",
      });
      const exited = new Promise<void>((done) => {
        child.once("exit", () => done());
        child.once("error", () => done());
      });
      const pid = child.pid ?? -1;
      return {
        pid,
        exited,
        kill() {
          if (pid <= 0) return;
          for (const signal of ["SIGTERM", "SIGKILL"] as const) {
            try {
              process.kill(-pid, signal);
            } catch (error) {
              journalCaught(error, "live-preview.kill", null, "group may be gone");
            }
            if (signal === "SIGTERM") Bun.sleepSync(200);
          }
        },
      };
    },
    answers(port) {
      return new Promise((done) => {
        const socket = connect({ host: "127.0.0.1", port, timeout: 1000 });
        const finish = (ok: boolean) => {
          socket.destroy();
          done(ok);
        };
        socket.once("connect", () => finish(true));
        socket.once("error", () => finish(false));
        socket.once("timeout", () => finish(false));
      });
    },
    async listeners(port, candidates) {
      const inodes = ["/proc/net/tcp", "/proc/net/tcp6"].flatMap((path) =>
        listeningInodes(read(path), port),
      );
      const owners = new Map<string, number>();
      for (const pid of candidates)
        for (const fd of list(`/proc/${pid}/fd`)) {
          let target = "";
          try {
            target = readlinkSync(`/proc/${pid}/fd/${fd}`);
          } catch (error) {
            journalCaught(error, "live-preview.listeners.readlink", null, "fd may be closed");
          }
          const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
          if (inode && inodes.includes(inode)) owners.set(inode, pid);
        }
      return inodes.map((inode) => owners.get(inode) ?? null);
    },
    async tree(root) {
      const children = new Map<number, number[]>();
      for (const entry of list("/proc").filter((name) => /^\d+$/.test(name))) {
        const stat = read(`/proc/${entry}/stat`);
        const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
        if (Number.isInteger(parent))
          children.set(parent, [...(children.get(parent) ?? []), Number(entry)]);
      }
      const found = new Set<number>([root]);
      for (const pid of found) for (const child of children.get(pid) ?? []) found.add(child);
      return found;
    },
    async claimSlot() {
      mkdirSync(options.lockDirectory, { recursive: true, mode: 0o700 });
      for (let slot = 1; slot <= PREVIEW_SLOT_LIMIT; slot++) {
        const path = join(options.lockDirectory, `${slot}.lock`);
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const fd = openSync(path, "wx", 0o600);
            writeSync(fd, String(process.pid));
            closeSync(fd);
            return { slot, release: () => rmSync(path, { force: true }) };
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            const holder = Number(read(path));
            if (holder > 0 && alive(holder)) break;
            rmSync(path, { force: true });
          }
        }
      }
      return null;
    },
    tailscale(args) {
      return new Promise((done) => {
        execFile(
          Bun.which("tailscale") ?? "/usr/bin/tailscale",
          [...args],
          { timeout: 30_000 },
          (error, stdout, stderr) =>
            done({
              code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
              stdout,
              stderr: stderr || (error?.message ?? ""),
            }),
        );
      });
    },
    async warm(url, signal) {
      try {
        await fetch(url, {
          redirect: "manual",
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        });
        return true;
      } catch (error) {
        journalCaught(error, "live-preview.warm", null, "certificate may not be issued yet");
        return false;
      }
    },
    sleep: (ms, signal) => sleep(ms, undefined, { signal }),
    now: () => Date.now(),
  };
}
