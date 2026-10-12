import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

process.on("SIGTERM", () => {});
if (process.argv.includes("--descendant")) {
  process.stdout.write("ready\n");
} else {
  const descendant = spawn(process.execPath, ["--descendant"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  descendant.stdout!.once("data", () =>
    writeFileSync(`${process.execPath}.pids.json`, JSON.stringify([process.pid, descendant.pid])),
  );
}
setInterval(() => {}, 1000);
