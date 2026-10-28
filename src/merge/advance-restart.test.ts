import { afterEach, describe, expect, test } from "bun:test";
import { JOB_KIND, MERGE_LANE } from "../core";
import {
  enqueueJob,
  getConfirmedRemoteMerge,
  getWorkItem,
  listJobs,
  listMergeQueues,
  mergeCallInFlight,
  prepareShutdown,
  recoverOnStartup,
} from "../db";
import { mergeHarness, pendingCi, type MergeHarness } from "./advance-harness";

let harness: MergeHarness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

/** Each task's merge job, as Closeout's acceptance queues it. */
function enqueueMerges(h: MergeHarness, ids: string[]): void {
  for (const id of ids)
    enqueueJob(h.db, {
      queue: JOB_KIND.merge,
      lane: MERGE_LANE,
      jobKey: `merge:${id}`,
      payload: { itemId: id, head: getWorkItem(h.db, id)!.checkpoint!.wipCommit },
      now: h.clock.now(),
    });
}

function openMergeJob(h: MergeHarness, id: string): Record<string, unknown> {
  const job = listJobs(h.db).find(
    (row) =>
      row.queue === JOB_KIND.merge &&
      (row.status === "pending" || row.status === "running") &&
      (row.payload as { itemId?: unknown }).itemId === id,
  );
  expect(job).toBeDefined();
  return job!.payload as Record<string, unknown>;
}

function reverifies(h: MergeHarness) {
  return listJobs(h.db).filter((job) => job.queue === JOB_KIND.reverify);
}

function restart(h: MergeHarness): void {
  prepareShutdown(h.db, h.clock.now());
  h.clock.advance(1_000);
  recoverOnStartup(h.db, h.clock.now());
}

describe("a Paws restart and the merge queue", () => {
  test("tasks waiting in the queue keep their place and merge in their original order", async () => {
    const h = (harness = await mergeHarness({ settings: { order: "queue" } }));
    const ids = ["ENG-201", "ENG-202", "ENG-203"];
    for (const id of ids) await h.addItem(id);
    enqueueMerges(h, ids);
    h.state.ci = pendingCi;
    for (const id of ids) {
      expect(await h.pass(id, openMergeJob(h, id))).toMatchObject({ kind: "wait" });
      h.clock.advance(1_000);
    }
    expect(listMergeQueues(h.db).map((entry) => entry.itemId)).toEqual(ids);

    restart(h);

    expect(reverifies(h)).toEqual([]);
    for (const id of ids) expect(getWorkItem(h.db, id)?.state).toBe("merge_queue");
    expect(listMergeQueues(h.db).map((entry) => entry.itemId)).toEqual(ids);

    h.state.ci = () => undefined;
    for (const id of [...ids].reverse()) await h.pass(id, openMergeJob(h, id));
    for (const id of ids) await h.pass(id, openMergeJob(h, id));
    expect(h.github.merged.map((merge) => ids[merge.number - 1])).toEqual(ids);
    expect(reverifies(h)).toEqual([]);
  });

  test("a merge GitHub finished just before shutdown is recorded once after start", async () => {
    const h = (harness = await mergeHarness());
    const item = await h.addItem("ENG-210");
    enqueueMerges(h, [item.id]);
    h.state.dropMergeResponse = true;
    await expect(h.pass(item.id, openMergeJob(h, item.id))).rejects.toThrow();
    expect(h.github.merged).toHaveLength(1);
    expect(getConfirmedRemoteMerge(h.db, item.id)).toBeNull();
    expect(mergeCallInFlight(h.db, item.id)).toBe(true);

    restart(h);

    expect(getWorkItem(h.db, item.id)?.state).toBe("merge_queue");
    expect(reverifies(h)).toEqual([]);
    const payload = openMergeJob(h, item.id);
    expect(payload.mergeCallInFlight).toBe(true);
    expect(await h.pass(item.id, payload)).toEqual({ kind: "merged" });
    expect(getConfirmedRemoteMerge(h.db, item.id)).toMatchObject({
      pullNumber: item.pull,
      mergeSha: `fake-merge-${item.accepted}`,
    });
    expect(mergeCallInFlight(h.db, item.id)).toBe(false);

    expect(await h.pass(item.id, payload)).toEqual({ kind: "obsolete" });
    expect(h.completed).toEqual([item.id]);
    expect(h.github.merged).toHaveLength(1);
    expect(
      h.db.query("SELECT COUNT(*) AS n FROM remote_merge_fact WHERE item_id = ?").get(item.id),
    ).toEqual({ n: 1 });
  });

  test("a merge call GitHub never saw re-verifies the task, which keeps its place", async () => {
    const h = (harness = await mergeHarness({ settings: { order: "queue" } }));
    const first = await h.addItem("ENG-220");
    const second = await h.addItem("ENG-221");
    enqueueMerges(h, [first.id, second.id]);
    h.state.ci = pendingCi;
    await h.pass(first.id, openMergeJob(h, first.id));
    h.clock.advance(1_000);
    await h.pass(second.id, openMergeJob(h, second.id));
    // The process stopped while the merge call for the first task was in flight.
    h.db.run("INSERT INTO merge_call(item_id, head_sha, started_at) VALUES (?, ?, ?)", [
      first.id,
      first.accepted,
      h.clock.now(),
    ]);

    restart(h);

    expect(await h.pass(first.id, openMergeJob(h, first.id))).toEqual({ kind: "returned" });
    expect(getWorkItem(h.db, first.id)?.state).toBe("verifying");
    expect(reverifies(h).map((job) => job.payload)).toEqual([{ itemId: first.id }]);
    expect(mergeCallInFlight(h.db, first.id)).toBe(false);
    expect(getWorkItem(h.db, second.id)?.state).toBe("merge_queue");
    expect(listMergeQueues(h.db).map((entry) => entry.itemId)).toEqual([first.id, second.id]);
    expect(h.github.merged).toEqual([]);
  });
});
