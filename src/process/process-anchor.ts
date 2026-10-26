import { journalCaught } from "../journal";
import { dlopen, FFIType } from "bun:ffi";
import { spawn } from "node:child_process";
import { closeSync, readdirSync, readFileSync } from "node:fs";

const [command, args, cwd] = JSON.parse(process.argv[2]!) as [string, string[], string];
const libc = (() => {
  if (process.platform !== "linux") return;
  for (const name of ["libc.so.6", "libc.so"]) {
    try {
      return dlopen(name, {
        prctl: {
          args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
          returns: FFIType.i32,
        },
        waitpid: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      }).symbols;
    } catch (caughtError1) {
      journalCaught(caughtError1, "process-anchor.recover.dlopen", null);
    }
  }
})();
// PR_SET_CHILD_SUBREAPER: a descendant that detaches and loses its parent, like a sandbox
// started with setsid, is reparented here instead of to init, so teardown still finds it.
try {
  libc?.prctl(36, 1, 0, 0, 0);
} catch (caughtError2) {
  journalCaught(caughtError2, "process-anchor.recover.prctl", null);
}
type Entry = { pid: number; parent: number; group: number; live: boolean };
const table = (): Entry[] =>
  readdirSync("/proc").flatMap((entry) => {
    if (!/^\d+$/.test(entry)) return [];
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const [state, parent, group] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return [
        {
          pid: Number(entry),
          parent: Number(parent),
          group: Number(group),
          live: state !== "Z" && state !== "X",
        },
      ];
    } catch (caughtError3) {
      journalCaught(
        caughtError3,
        "process-anchor.table.readFileSync",
        null,
        "process may be absent or inaccessible",
      );
      return [];
    }
  });
/** Every process in this group or below this process, whichever session it moved to. */
const family = (entries = table()): Entry[] => {
  const children = new Map<number, Entry[]>();
  for (const entry of entries)
    children.set(entry.parent, [...(children.get(entry.parent) ?? []), entry]);
  const found = new Map<number, Entry>();
  for (const entry of entries)
    if (entry.group === process.pid && entry.pid !== process.pid) found.set(entry.pid, entry);
  const queue = [process.pid, ...found.keys()];
  while (queue.length)
    for (const child of children.get(queue.shift()!) ?? [])
      if (child.pid !== process.pid && !found.has(child.pid)) {
        found.set(child.pid, child);
        queue.push(child.pid);
      }
  return [...found.values()];
};
const signalFamily = (signal: NodeJS.Signals): boolean => {
  let members: Entry[];
  try {
    members = family().filter((entry) => entry.live);
  } catch (caughtError4) {
    journalCaught(caughtError4, "process-anchor.signalFamily.filter", null);
    return false;
  }
  for (const member of members) {
    try {
      process.kill(member.pid, signal);
    } catch (caughtError5) {
      journalCaught(
        caughtError5,
        "process-anchor.signalFamily.kill",
        null,
        "process may have exited",
      );
    }
  }
  return members.length > 0;
};
const killGroup = () => {
  for (let round = 0; round < 20 && signalFamily("SIGKILL"); round += 1);
  process.kill(-process.pid, "SIGKILL");
};
const report = (value: object, sent?: () => void) => {
  if (!process.send) return killGroup();
  process.send(value, (error: Error | null) => {
    if (error) killGroup();
    else sent?.();
  });
};
process.on("SIGTERM", () => undefined);
process.on("SIGINT", () => undefined);
process.on("SIGHUP", () => undefined);
const commandProcess = spawn(command, args, { cwd, stdio: ["inherit", "inherit", "inherit"] });
commandProcess.on("error", (error) => report({ type: "error", message: error.message }));
commandProcess.on("exit", (code, signal) => report({ type: "exit", code, signal }));
for (const fd of [0, 1, 2]) closeSync(fd);
const commandRunning = () => commandProcess.exitCode === null && commandProcess.signalCode === null;
/** Adopted orphans are not Bun's children, so their exit is collected here. */
const reap = () => {
  if (!libc) return;
  try {
    for (const entry of table())
      if (entry.parent === process.pid && !entry.live && entry.pid !== commandProcess.pid)
        libc.waitpid(entry.pid, null, 1);
  } catch (caughtError6) {
    journalCaught(caughtError6, "process-anchor.reap.table", null);
  }
};
setInterval(reap, 1000).unref();
const familyRunning = () => {
  try {
    reap();
    return family().some((entry) => entry.live);
  } catch (caughtError7) {
    journalCaught(caughtError7, "process-anchor.familyRunning.reap", null);
    return commandRunning();
  }
};
const reportDrained = () =>
  familyRunning() ? setTimeout(reportDrained, 25) : report({ type: "drained" });
process.on("message", (value) => {
  const message = value as { target: "group" | "command"; signal: NodeJS.Signals };
  if (message.target === "command") {
    if (commandProcess.exitCode === null && commandProcess.signalCode === null)
      commandProcess.kill(message.signal);
  } else if (message.signal === "SIGKILL") report({ type: "teardown" }, killGroup);
  else {
    signalFamily(message.signal);
    process.kill(-process.pid, message.signal);
    reportDrained();
  }
});
process.on("disconnect", killGroup);
