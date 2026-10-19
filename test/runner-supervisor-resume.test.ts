import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDirectWorkerSupervisor } from "../src/runner-execution";

test("the supervisor reports a dead worker and relaunches it in resume mode", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-supervisor-resume-"));
  const launches: boolean[] = [];
  const children: ReturnType<typeof spawn>[] = [];
  const id = "01J00000000000000000000001";
  try {
    const supervisor = createDirectWorkerSupervisor({
      stateRoot: join(root, "workers"),
      launch(_executionId, _home, _log, resume) {
        launches.push(resume === true);
        const child = spawn("sleep", ["30"], { stdio: "ignore" });
        children.push(child);
        return child;
      },
    });
    await supervisor.start(id);
    expect(supervisor.alive!(id)).toBe(true);
    await expect(supervisor.resume!(id)).rejects.toThrow("still running");
    const exited = new Promise((resolve) => children[0]!.once("exit", resolve));
    children[0]!.kill("SIGKILL");
    await exited;
    expect(supervisor.alive!(id)).toBe(false);
    await supervisor.resume!(id);
    expect(launches).toEqual([false, true]);
    expect(supervisor.alive!(id)).toBe(true);
    await supervisor.stop(id);
    expect(supervisor.alive!(id)).toBe(false);
  } finally {
    for (const child of children) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});
