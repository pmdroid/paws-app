import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "bun:test";
import { createDirectWorkerSupervisor } from "../src/runner-execution";

const roots: string[] = [];
const pids: number[] = [];
const worker = fileURLToPath(new URL("./fixtures/runner-process-worker.ts", import.meta.url));

afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function running(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return !["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]!);
  } catch {
    return false;
  }
}

async function until(condition: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

async function pidFrom(path: string): Promise<number> {
  await until(() => existsSync(path) && readFileSync(path, "utf8").length > 0);
  const pid = Number(readFileSync(path, "utf8"));
  pids.push(pid);
  return pid;
}

/** A sandbox that ignores SIGTERM, records its pid, and keeps running. */
function sandbox(pidFile: string): string {
  return `process.on("SIGTERM", () => {}); require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
}

/** Starts a sandbox in its own session with an empty environment, then exits, like a detaching sandbox launcher. */
function orphan(pidFile: string): string {
  return `require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(sandbox(pidFile))}], { detached: true, stdio: "ignore", env: {} }).unref(); process.exit(0);`;
}

function fixture(final: "end" | "hang") {
  const root = mkdtempSync(join(tmpdir(), "paws-process-cleanup-"));
  roots.push(root);
  const executionId = "01K00000000000000000000001";
  for (const path of ["output", "home", join("work", executionId)])
    mkdirSync(join(root, path), { recursive: true, mode: 0o700 });
  const sandboxes = { tagged: join(root, "tagged.pid"), orphan: join(root, "orphan.pid") };
  writeFileSync(
    join(root, "script.json"),
    JSON.stringify({
      model: "fixture-model",
      steps: [
        {
          type: "spawn",
          command: process.execPath,
          args: ["-e", sandbox(sandboxes.tagged)],
          detached: true,
        },
        {
          type: "spawn",
          command: process.execPath,
          args: ["-e", orphan(sandboxes.orphan)],
          detached: true,
          env: {},
        },
        { type: "update", update: { sessionUpdate: "plan", entries: [] }, delayMs: 1_000 },
        { type: final },
      ],
    }),
  );
  let workerPid = 0;
  const supervisor = createDirectWorkerSupervisor({
    stateRoot: join(root, "workers"),
    launch(id, _home, log, _resume, tag) {
      const child = spawn(process.execPath, [worker, root, id], {
        detached: true,
        stdio: ["ignore", log, log],
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(root, "home"), ...tag },
      });
      workerPid = child.pid!;
      pids.push(workerPid);
      return child;
    },
  });
  return {
    root,
    executionId,
    supervisor,
    workerPid: () => workerPid,
    sandboxes: async () => [await pidFrom(sandboxes.tagged), await pidFrom(sandboxes.orphan)],
  };
}

test.skipIf(process.platform !== "linux")(
  "processes the agent starts, including detached ones, are gone when the run ends",
  async () => {
    const run = fixture("end");
    await run.supervisor.start(run.executionId);
    const started = await run.sandboxes();
    await until(() => !run.supervisor.alive!(run.executionId), 15_000);
    expect(started.filter(running)).toEqual([]);
    await run.supervisor.stop(run.executionId);
  },
  20_000,
);

test.skipIf(process.platform !== "linux")(
  "processes the agent starts, including detached ones, are gone when the run is cancelled",
  async () => {
    const run = fixture("hang");
    await run.supervisor.start(run.executionId);
    const started = await run.sandboxes();
    await run.supervisor.stop(run.executionId);
    expect(started.filter(running)).toEqual([]);
  },
  20_000,
);

test.skipIf(process.platform !== "linux")(
  "processes the agent starts, including detached ones, are gone when the worker is killed",
  async () => {
    const run = fixture("hang");
    await run.supervisor.start(run.executionId);
    const started = await run.sandboxes();
    process.kill(run.workerPid(), "SIGKILL");
    await until(() => started.every((pid) => !running(pid)));
    expect(await run.supervisor.sweep!()).toBe(0);
  },
  20_000,
);

test.skipIf(process.platform !== "linux")(
  "a restarted runner stops processes of executions it no longer knows and keeps running ones",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "paws-process-sweep-"));
    roots.push(root);
    const stateRoot = join(root, "workers");
    const launch = (exit: boolean) =>
      createDirectWorkerSupervisor({
        stateRoot,
        launch(id, _home, log, _resume, tag) {
          const pidFile = join(root, `${id}.pid`);
          const child = spawn(
            process.execPath,
            [
              "-e",
              `require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(sandbox(pidFile))}], { detached: true, stdio: "ignore" }).unref(); ${exit ? "process.exit(0)" : "setInterval(() => {}, 1000)"}`,
            ],
            {
              detached: true,
              stdio: ["ignore", log, log],
              env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...tag },
            },
          );
          pids.push(child.pid!);
          return child;
        },
      });
    const gone = "01K00000000000000000000002";
    const live = "01K00000000000000000000003";
    await launch(true).start(gone);
    await launch(false).start(live);
    const leftover = await pidFrom(join(root, `${gone}.pid`));
    const kept = await pidFrom(join(root, `${live}.pid`));
    await until(() => !launch(false).alive!(gone));

    const restarted = launch(false);
    expect(await restarted.sweep!()).toBe(1);
    expect(running(leftover)).toBe(false);
    expect(running(kept)).toBe(true);
    await restarted.stop(live);
    expect(running(kept)).toBe(false);
  },
  20_000,
);
