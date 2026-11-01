import { afterEach, describe, expect, test } from "bun:test";
import { CommandBus, JOB_KIND } from "../core";
import {
  enqueueJob,
  applyLinearCommand,
  completeMergedItem,
  drainCommands,
  listOutbox,
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
    expect(await h.pass(item.id, openMergeJob(h, item.id))).toMatchObject({
      kind: "wait",
      reason: "merge_outcome",
    });
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
    // The call stays fenced until local completion commits.
    expect(mergeCallInFlight(h.db, item.id)).toBe(true);

    expect(await h.pass(item.id, payload)).toEqual({ kind: "obsolete" });
    expect(h.completed).toEqual([item.id]);
    expect(h.github.merged).toHaveLength(1);
    expect(
      h.db.query("SELECT COUNT(*) AS n FROM remote_merge_fact WHERE item_id = ?").get(item.id),
    ).toEqual({ n: 1 });
  });

  test.each(["timeout", "502"])(
    "%s: unknown reads retain a possibly successful merge until a positive read, without a payload flag",
    async (fault) => {
      const h = (harness = await mergeHarness({ settings: { order: "queue" } }));
      const item = await h.addItem("ENG-215");
      enqueueMerges(h, [item.id]);
      h.state.dropMergeResponse = fault === "timeout";
      h.state.mergeResponseStatus = fault === "502" ? 502 : 200;
      expect(await h.pass(item.id)).toMatchObject({ kind: "wait", reason: "merge_outcome" });
      restart(h);
      h.state.mergeReadUnknown = true;
      const published = h.published.length;
      const queue = listMergeQueues(h.db);
      for (let attempt = 0; attempt < 3; attempt++) {
        expect(await h.pass(item.id, { itemId: item.id })).toMatchObject({
          kind: "wait",
          reason: "merge_outcome",
        });
        expect(mergeCallInFlight(h.db, item.id)).toBe(true);
        expect(listMergeQueues(h.db)).toEqual(queue);
        expect(getConfirmedRemoteMerge(h.db, item.id)).toBeNull();
        expect(getWorkItem(h.db, item.id)?.state).toBe("merge_queue");
        expect(reverifies(h)).toEqual([]);
        expect(h.published).toHaveLength(published);
        h.clock.advance(300_000);
      }
      h.state.mergeReadUnknown = false;
      expect(await h.pass(item.id, { itemId: item.id })).toEqual({ kind: "merged" });
      expect(await h.pass(item.id, { itemId: item.id })).toEqual({ kind: "obsolete" });
      expect(h.completed).toEqual([item.id]);
      expect(h.github.merged).toHaveLength(1);
      expect(mergeCallInFlight(h.db, item.id)).toBe(false);
    },
  );

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

    h.state.mergeReadUnknown = true;
    expect(await h.pass(first.id, { itemId: first.id })).toMatchObject({
      kind: "wait",
      reason: "merge_outcome",
    });
    expect(mergeCallInFlight(h.db, first.id)).toBe(true);
    expect(reverifies(h)).toEqual([]);
    h.state.mergeReadUnknown = false;
    expect(await h.pass(first.id, { itemId: first.id })).toEqual({ kind: "returned" });
    expect(getWorkItem(h.db, first.id)?.state).toBe("verifying");
    expect(reverifies(h).map((job) => job.payload)).toEqual([{ itemId: first.id }]);
    expect(mergeCallInFlight(h.db, first.id)).toBe(false);
    expect(getWorkItem(h.db, second.id)?.state).toBe("merge_queue");
    expect(listMergeQueues(h.db).map((entry) => entry.itemId)).toEqual([first.id, second.id]);
    expect(h.github.merged).toEqual([]);
  });
});

test("a stop after the last squash guard defers until the remote merge completes locally", async () => {
  const h = (harness = await mergeHarness());
  const item = await h.addItem("ENG-230");
  let release = () => {};
  h.state.squashGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const turn = h.pass(item.id);
  for (let tries = 0; !h.state.squashing; tries++) {
    if (tries > 500) throw new Error("squash did not start");
    await Bun.sleep(10);
  }
  expect(
    applyLinearCommand(h.db, {
      type: "stop",
      source: "linear",
      itemId: item.id,
      requestedAt: h.clock.now(),
    }).deferred,
  ).toBe(true);
  expect(getWorkItem(h.db, item.id)?.state).toBe("merge_queue");
  release();
  expect(await turn).toEqual({ kind: "merged" });
  expect(h.github.merged).toHaveLength(1);
  expect(mergeCallInFlight(h.db, item.id)).toBe(true);
  // A retry in the gap between the remote response and local completion still waits.
  h.clock.advance(1_000);
  drainCommands(h.db, new CommandBus(), h.clock.now());
  expect(getWorkItem(h.db, item.id)?.state).toBe("merge_queue");
  expect(completeMergedItem(h.db, { itemId: item.id, now: h.clock.now() })?.state).toBe("merged");
  h.clock.advance(1_000);
  drainCommands(h.db, new CommandBus(), h.clock.now());
  expect(getWorkItem(h.db, item.id)?.state).toBe("merged");
  expect(
    listOutbox(h.db).filter((row) =>
      String((row.payload as { body?: string }).body).includes("was already merged"),
    ),
  ).toHaveLength(1);
});

test("a stop during the final squash reads still prevents the GitHub call", async () => {
  const h = (harness = await mergeHarness());
  const item = await h.addItem("ENG-231");
  let stopped = false;
  h.state.pullHead = (head) => {
    if (mergeCallInFlight(h.db, item.id) && !stopped) {
      stopped = true;
      applyLinearCommand(h.db, {
        type: "stop",
        source: "linear",
        itemId: item.id,
        requestedAt: h.clock.now(),
      });
    }
    return head;
  };
  expect(await h.pass(item.id)).toEqual({ kind: "obsolete" });
  expect(stopped).toBe(true);
  expect(h.github.merged).toEqual([]);
  h.clock.advance(1_000);
  drainCommands(h.db, new CommandBus(), h.clock.now());
  expect(getWorkItem(h.db, item.id)?.state).toBe("cancelled");
});
