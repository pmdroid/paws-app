import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { createDirectWorkerSupervisor } from "../src/runner-execution";

const roots: string[] = [];
const id = "01K00000000000000000000000";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("direct worker supervisor admits an execution once and kills its process group", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-worker-supervisor-"));
  roots.push(root);
  const supervisor = createDirectWorkerSupervisor({
    stateRoot: join(root, "workers"),
    launch(executionId) {
      return spawn(
        process.execPath,
        ["-e", `setTimeout(() => {}, 30000); void ${JSON.stringify(executionId)}`],
        {
          detached: true,
          stdio: "ignore",
        },
      );
    },
  });
  expect(await supervisor.start(id)).toEqual({ alreadyAdmitted: false });
  expect(await supervisor.start(id)).toEqual({ alreadyAdmitted: true });
  await supervisor.stop(id);
  await supervisor.stop(id);
});
