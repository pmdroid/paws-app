import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCommandRunner } from "../src/closeout-spec/run";

test("a command finishes when it exits even if a detached child keeps its output open", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-closeout-drain-"));
  const mark = join(root, "pid.txt");
  spawnSync("git", ["init", "-q"], { cwd: root });
  const script = [
    'const {spawn}=require("child_process");',
    'const child=spawn(process.execPath,["-e","setTimeout(()=>{},60000)"],{detached:true,stdio:["ignore","inherit","inherit"]});',
    `require("fs").writeFileSync(${JSON.stringify(mark)}, String(child.pid));`,
    'child.unref();console.log("done");',
  ].join("");
  const started = Date.now();
  try {
    const result = await createCommandRunner({ logDir: join(root, "logs") }).run({
      cwd: root,
      argv: [process.execPath, "-e", script],
      timeoutSeconds: 30,
    });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(Date.now() - started).toBeLessThan(10_000);
  } finally {
    const leaked = Number(readFileSync(mark, "utf8"));
    if (leaked > 0) spawnSync("kill", ["-9", String(leaked)]);
    rmSync(root, { recursive: true, force: true });
  }
});
