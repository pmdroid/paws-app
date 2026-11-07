import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

export const STALL_MS = Number(process.env.PAWS_TEST_STALL_MS ?? 180_000);

export type RunningFile = { pid: number; file: string; since: number };

export function runningFiles(directory: string): RunningFile[] {
  const files: RunningFile[] = [];
  for (const name of readdirSync(directory)) {
    let text: string;
    try {
      text = readFileSync(join(directory, name), "utf8").trim();
    } catch {
      continue;
    }
    const space = text.indexOf(" ");
    files.push({
      pid: Number(name),
      since: Number(text.slice(0, space)),
      file: text.slice(space + 1),
    });
  }
  return files.sort((a, b) => a.since - b.since);
}

function ps(args: string[]): string[] {
  const result = spawnSync("ps", args, { encoding: "utf8" });
  return result.stdout?.trim().split("\n").slice(1) ?? [];
}

function workerState(pid: number): string[] {
  return [
    ...ps(["-L", "-o", "tid,stat,wchan:32,comm", "-p", String(pid)]).map(
      (line) => `thread ${line.trim()}`,
    ),
    ...ps(["-o", "pid,stat,etime,args", "--ppid", String(pid)]).map(
      (line) => `child ${line.trim()}`,
    ),
  ];
}

export function stallReport(files: RunningFile[], quietMs: number, now = Date.now()): string {
  const lines = [
    `test watchdog: no progress for ${Math.round(quietMs / 1000)} s; files that have not reported:`,
  ];
  if (files.length === 0) lines.push("  (no test file is running)");
  for (const { pid, file, since } of files) {
    lines.push(
      `  ${relative(process.cwd(), file)} (worker ${pid}, running ${Math.round((now - since) / 1000)} s)`,
    );
    lines.push(...workerState(pid).map((line) => `    ${line}`));
  }
  return lines.join("\n");
}

async function main(args: string[]): Promise<number> {
  const directory = mkdtempSync(join(tmpdir(), "paws-test-progress-"));
  const child = Bun.spawn(["bun", "test", ...args], {
    env: { ...process.env, PAWS_TEST_PROGRESS_DIR: directory },
    stdout: "pipe",
    stderr: "pipe",
  });
  let progress = Date.now();
  let running = "";
  const forward = async (stream: ReadableStream<Uint8Array>, out: NodeJS.WriteStream) => {
    for await (const chunk of stream) {
      progress = Date.now();
      out.write(chunk);
    }
  };
  const watch = setInterval(() => {
    const now = Date.now();
    const files = runningFiles(directory);
    const current = files.map((file) => `${file.pid} ${file.file}`).join("\n");
    if (current !== running) {
      running = current;
      progress = now;
    }
    if (now - progress < STALL_MS) return;
    clearInterval(watch);
    console.error(`\n${stallReport(files, now - progress, now)}`);
    child.kill("SIGKILL");
    for (const { pid } of files) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    process.exit(1);
  }, 1_000);
  await Promise.all([forward(child.stdout, process.stdout), forward(child.stderr, process.stderr)]);
  const code = await child.exited;
  clearInterval(watch);
  rmSync(directory, { recursive: true, force: true });
  return code;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
