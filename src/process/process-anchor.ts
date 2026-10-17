import { spawn } from "node:child_process";
import { closeSync, readdirSync, readFileSync } from "node:fs";

const [command, args, cwd] = JSON.parse(process.argv[2]!) as [string, string[], string];
const killGroup = () => process.kill(-process.pid, "SIGKILL");
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
const groupMember = (entry: string) => {
  if (!/^\d+$/.test(entry) || Number(entry) === process.pid) return false;
  try {
    const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
    const [state, , group] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return Number(group) === process.pid && state !== "Z" && state !== "X";
  } catch {
    return false;
  }
};
const groupRunning = () => {
  try {
    return readdirSync("/proc").some(groupMember);
  } catch {
    return commandRunning();
  }
};
const reportDrained = () =>
  groupRunning() ? setTimeout(reportDrained, 25) : report({ type: "drained" });
process.on("message", (value) => {
  const message = value as { target: "group" | "command"; signal: NodeJS.Signals };
  if (message.target === "command") {
    if (commandProcess.exitCode === null && commandProcess.signalCode === null)
      commandProcess.kill(message.signal);
  } else if (message.signal === "SIGKILL") report({ type: "teardown" }, killGroup);
  else {
    process.kill(-process.pid, message.signal);
    reportDrained();
  }
});
process.on("disconnect", killGroup);
