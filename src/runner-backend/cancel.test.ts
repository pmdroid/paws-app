import { afterEach, expect, test } from "bun:test";
import { RunnerCapacityWait } from "../core";
import type { RunnerWork } from "../runner-work";
import { createRemoteCancellation } from "./cancel";
import { describePglite, withoutForeignKeys, type PgliteTestDb } from "../../test/pglite-fixtures";
import { seedRun, seedRunner, seedWork } from "../../test/runner-rows";

const open: PgliteTestDb[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
});

function recordingWork() {
  const enqueued: unknown[] = [];
  const work = {
    enqueueSteps(_q: unknown, command: unknown) {
      enqueued.push(command);
      return [][Symbol.iterator]();
    },
  } as unknown as RunnerWork;
  return { work, enqueued };
}

describePglite((connect) => {
  async function fixture(runner: Parameters<typeof seedRunner>[2]) {
    const handle = await connect();
    open.push(handle);
    const db = handle.db;
    await withoutForeignKeys(db);
    await seedRunner(db, "box", runner);
    await seedRun(db, "ended", "item");
    await seedWork(db, "ended", "box", { endedAt: 1 });
    await seedRun(db, "open", "item");
    await seedWork(db, "open", "box", { generation: 1 });
    return db;
  }

  test("cancelling an item on a revoked runner resolves at once without a cancel", async () => {
    const db = await fixture({ status: "revoked", revokedAt: 5 });
    const { work, enqueued } = recordingWork();
    const checkpoints: string[] = [];
    const cancelItem = createRemoteCancellation({
      store: db,
      work,
      checkpoint: (runId) => {
        checkpoints.push(runId);
        return null;
      },
    });
    await cancelItem("item");
    expect(enqueued).toEqual([]);
    expect(checkpoints).toEqual([]);
  });

  test("cancelling an item on a paused runner still asks it and waits", async () => {
    const db = await fixture({ status: "paused" });
    const { work, enqueued } = recordingWork();
    let clock = 0;
    const cancelItem = createRemoteCancellation({
      store: db,
      work,
      now: () => (clock += 70_000),
      pollIntervalMs: 1,
    });
    await expect(cancelItem("item")).rejects.toBeInstanceOf(RunnerCapacityWait);
    expect(enqueued).toHaveLength(1);
  });
});
