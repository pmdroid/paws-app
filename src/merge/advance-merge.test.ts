import { findOpenQuestion } from "../questions";
import { afterEach, describe, expect, test } from "bun:test";
import { JOB_KIND } from "../core";
import {
  applyWorkItemEvent,
  enqueueJob,
  getConfirmedRemoteMerge,
  getWorkItem,
  listJobs,
  listRebaseReturns,
  saveCheckpoint,
} from "../db";
import { mergeHarness, pendingCi, type MergeHarness } from "./advance-harness";
import { REBASE_CONFLICT_INSTRUCTION, REBASE_CONFLICT_THOUGHT } from "./orders";

let harness: MergeHarness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

async function start(settings: Parameters<typeof mergeHarness>[0] = {}) {
  harness = await mergeHarness(settings);
  return harness;
}

function resumes(h: MergeHarness) {
  return listJobs(h.db)
    .filter((job) => job.queue === JOB_KIND.resume)
    .map((job) => job.payload as { handoff: string; reason: string });
}

async function onMovedMain(h: MergeHarness, head: string, main: string): Promise<boolean> {
  return h
    .git(h.bare, "merge-base", "--is-ancestor", main, head)
    .then(() => true)
    .catch(() => false);
}

function backInQueue(h: MergeHarness, id: string): void {
  const item = getWorkItem(h.db, id)!;
  if (item.state === "queued") applyWorkItemEvent(h.db, id, "dispatched");
  applyWorkItemEvent(h.db, id, "turn_ended");
  applyWorkItemEvent(h.db, id, "closeout_accepted");
  saveCheckpoint(h.db, id, { ...item.checkpoint!, phase: "merge_queue" });
}

describe("advanceMerge on the serial merge", () => {
  test("green CI merges the accepted head and records the remote merge", async () => {
    const h = await start();
    const item = await h.addItem("ENG-1");
    expect(await h.pass("ENG-1")).toEqual({ kind: "merged" });
    expect(h.github.merged).toEqual([
      { repository: "acme/app", number: 1, expectedHeadSha: item.accepted },
    ]);
    expect(getConfirmedRemoteMerge(h.db, "ENG-1")).toMatchObject({
      pullNumber: 1,
      mergeSha: `fake-merge-${item.accepted}`,
    });
    expect(h.verified.map((input) => input.head)).toEqual([item.accepted]);
  });

  test("pending CI waits with the verified candidate, and the next pass merges without Closeout", async () => {
    const h = await start();
    const item = await h.addItem("ENG-1");
    h.state.ci = pendingCi;
    expect(await h.pass("ENG-1")).toMatchObject({
      kind: "wait",
      reason: "ci",
      base: item.base,
      head: item.accepted,
      summary: "Re-verified.",
    });
    expect(h.github.merged).toEqual([]);
    h.state.ci = () => undefined;
    expect(await h.pass("ENG-1")).toEqual({ kind: "merged" });
    expect(h.verified).toHaveLength(1);
  });

  test("with main moved set to wait for CI, a branch update merges without Closeout and says why", async () => {
    const h = await start({ settings: { mainMoved: "ci" } });
    const item = await h.addItem("ENG-1");
    const main = await h.moveMain("side.txt", "side\n");
    expect(await h.pass("ENG-1")).toEqual({ kind: "merged" });
    const merged = h.github.merged[0]!.expectedHeadSha;
    expect(merged).not.toBe(item.accepted);
    expect(await onMovedMain(h, merged, main)).toBe(true);
    expect(h.verified).toEqual([]);
    expect(h.accepted).toEqual([{ sha: merged, baseSha: main }]);
    const updated = `Branch updated onto main ${main.slice(0, 7)}, waiting for CI. Closeout does not run again, because "When main moved before the merge" for this task is set to wait for CI in Settings → Merging.`;
    expect(h.bodies("status")).toContain(updated);
    expect(h.bodies("thought")).not.toContain(updated);
  });

  test("with Closeout after an update, a branch update runs Closeout on the new head", async () => {
    const h = await start({ settings: { mainMoved: "closeout" } });
    const item = await h.addItem("ENG-1");
    const main = await h.moveMain("side.txt", "side\n");
    expect(await h.pass("ENG-1")).toEqual({ kind: "merged" });
    expect(h.verified).toHaveLength(1);
    expect(h.verified[0]).toMatchObject({ base: main });
    expect(h.verified[0]!.head).not.toBe(item.accepted);
    expect(h.github.merged[0]!.expectedHeadSha).toBe(h.verified[0]!.head);
    expect(h.bodies("status")).toContain("Branch updated, running Closeout again.");
    expect(h.bodies("thought")).not.toContain("Branch updated, running Closeout again.");
  });

  test("Closeout rejecting the updated head asks for Closeout help and merges nothing", async () => {
    const h = await start();
    await h.addItem("ENG-1");
    await h.moveMain("side.txt", "side\n");
    h.state.verdict = {
      accepted: false,
      outcome: "rejected",
      summary: "The test fails.",
      rejected: true,
    };
    expect(await h.pass("ENG-1")).toEqual({ kind: "asked" });
    expect(h.closeoutHelp).toEqual(["ENG-1"]);
    expect(h.github.merged).toEqual([]);
  });

  test("overlap only: main changed other files, so the accepted head merges without an update", async () => {
    const h = await start({ settings: { mainMoved: "overlap" } });
    const item = await h.addItem("ENG-1");
    const main = await h.moveMain("side.txt", "side\n");
    expect(await h.pass("ENG-1")).toEqual({ kind: "merged" });
    expect(h.github.merged.map((merge) => merge.expectedHeadSha)).toEqual([item.accepted]);
    expect(h.accepted).toEqual([{ sha: item.accepted, baseSha: main }]);
    expect(h.verified).toEqual([]);
    expect(h.bodies().filter((body) => body.startsWith("Branch updated"))).toEqual([]);
    expect(h.bodies().filter((body) => body.startsWith("GitHub requires"))).toEqual([]);
  });

  test("overlap only with GitHub's up-to-date rule updates the branch, waits for CI and notes why once", async () => {
    const h = await start({ settings: { mainMoved: "overlap" } });
    const item = await h.addItem("ENG-1");
    const main = await h.moveMain("side.txt", "side\n");
    h.state.upToDateRule = true;
    h.state.ci = pendingCi;
    expect(await h.pass("ENG-1")).toMatchObject({ kind: "wait", reason: "ci" });
    h.state.ci = () => undefined;
    expect(await h.pass("ENG-1")).toEqual({ kind: "merged" });
    const merged = h.github.merged.map((merge) => merge.expectedHeadSha);
    expect(merged).toHaveLength(1);
    expect(merged[0]).not.toBe(item.accepted);
    expect(await onMovedMain(h, merged[0]!, main)).toBe(true);
    expect(h.verified).toEqual([]);
    expect(h.bodies("afterPullRequest")).toEqual([
      `GitHub requires branches to be up to date before merging in acme/app, so Paws updates the branch and waits for CI even when main changed other files. Turn off "Require branches to be up to date before merging" for the base branch to merge without an update.`,
    ]);
    expect(h.bodies("status")).toContain(
      `Branch updated onto main ${main.slice(0, 7)}, waiting for CI.`,
    );
  });

  test("main moving again before the merge sends the task back to Closeout", async () => {
    const h = await start({ settings: { mainMoved: "closeout" } });
    const item = await h.addItem("ENG-1");
    h.state.pullHead = () => "c".repeat(40);
    expect(await h.pass("ENG-1")).toEqual({ kind: "returned" });
    expect(getWorkItem(h.db, "ENG-1")?.state).toBe("merge_queue");
    expect(
      listJobs(h.db)
        .filter((job) => job.queue === JOB_KIND.reverify)
        .map((job) => job.jobKey),
    ).toEqual([`reverify:ENG-1:${item.accepted}:merge:1`]);
    expect(h.github.merged).toEqual([]);
  });

  test("main moving again with Closeout off keeps waiting to update the branch", async () => {
    const h = await start({ settings: { mainMoved: "ci" } });
    await h.addItem("ENG-1");
    h.state.pullHead = () => "c".repeat(40);
    expect(await h.pass("ENG-1")).toMatchObject({
      kind: "wait",
      reason: "branch_update",
      message: "Main moved again before the merge. Updating the branch and waiting for CI.",
    });
    expect(getWorkItem(h.db, "ENG-1")?.state).toBe("merge_queue");
  });

  test("a stop during the merge merges nothing and makes the pass obsolete", async () => {
    const h = await start();
    await h.addItem("ENG-1");
    h.state.verdict = () => {
      h.state.stopped = true;
      return { accepted: true, outcome: "merged", summary: "Re-verified.", rejected: false };
    };
    expect(await h.pass("ENG-1")).toEqual({ kind: "obsolete" });
    expect(h.github.merged).toEqual([]);
  });
});

describe("advanceMerge on a rebase conflict", () => {
  async function conflicting() {
    const h = await start();
    const item = await h.addItem("ENG-1", { file: "ok.txt", content: "agent\n" });
    const main = await h.moveMain("ok.txt", "from-main\n");
    return { h, main, item };
  }

  test("a conflict goes back to the agent to rebase, and the resolved branch then merges", async () => {
    const { h, main, item: added } = await conflicting();
    expect(await h.pass("ENG-1")).toEqual({ kind: "returned" });
    const item = getWorkItem(h.db, "ENG-1")!;
    expect(item.state).toBe("queued");
    expect(item.checkpoint?.phase).toBe("running");
    expect(resumes(h)).toEqual([
      {
        itemId: "ENG-1",
        runId: item.currentRunId,
        handoff: REBASE_CONFLICT_INSTRUCTION,
        reason: "conflict",
      },
    ] as never);
    expect(
      listRebaseReturns(h.db, "ENG-1", 0).map((row) => ({ base: row.base, files: row.files })),
    ).toEqual([{ base: main, files: ["ok.txt"] }]);
    expect(h.bodies("thought")).toContain(REBASE_CONFLICT_THOUGHT);

    await h.git(added.worktree, "reset", "-q", "--hard", "refs/paws/upstream-main");
    await Bun.write(`${added.worktree}/ok.txt`, "agent\n");
    await h.git(added.worktree, "commit", "-qam", "Resolve the conflict with main");
    backInQueue(h, "ENG-1");
    expect(await h.pass("ENG-1")).toEqual({ kind: "merged" });
    expect(await onMovedMain(h, h.github.merged[0]!.expectedHeadSha, main)).toBe(true);
  });

  test("after three returns for the same main the task asks and names the commit and files", async () => {
    const { h, main } = await conflicting();
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await h.pass("ENG-1")).toEqual({ kind: "returned" });
      backInQueue(h, "ENG-1");
    }
    expect(await h.pass("ENG-1")).toEqual({ kind: "asked" });
    expect(getWorkItem(h.db, "ENG-1")?.state).toBe("awaiting_input");
    expect(findOpenQuestion(h.db, "ses-ENG-1")).toMatchObject({
      reason: "rebase_budget_spent",
      body: expect.stringContaining(
        `Main commits: ${main.slice(0, 7)}. Conflicting files: ok.txt.`,
      ),
    });
    expect(resumes(h).map((payload) => payload.handoff)).toEqual([
      REBASE_CONFLICT_INSTRUCTION,
      REBASE_CONFLICT_INSTRUCTION,
      REBASE_CONFLICT_INSTRUCTION,
    ]);
  });

  test("a newer main cannot refill the used-up conflict budget", async () => {
    const { h } = await conflicting();
    for (let attempt = 0; attempt < 3; attempt++) {
      await h.pass("ENG-1");
      backInQueue(h, "ENG-1");
    }
    await h.moveMain("ok.txt", "from-main-again\n");
    expect(await h.pass("ENG-1")).toEqual({ kind: "asked" });
    expect(resumes(h)).toHaveLength(3);
  });

  test("a person's reply after the returns ran out returns the next conflict to the agent", async () => {
    const { h } = await conflicting();
    for (let attempt = 0; attempt < 3; attempt++) {
      await h.pass("ENG-1");
      backInQueue(h, "ENG-1");
    }
    enqueueJob(h.db, {
      queue: JOB_KIND.resume,
      jobKey: "linear-turn:ses-ENG-1:1",
      payload: { itemId: "ENG-1", handoff: "retry" },
      now: h.clock.now(),
    });
    expect(await h.pass("ENG-1")).toEqual({ kind: "returned" });
    expect(
      resumes(h).filter((payload) => payload.handoff === REBASE_CONFLICT_INSTRUCTION),
    ).toHaveLength(4);
  });

  test("a rebase that fails without a conflict fails the task", async () => {
    const h = await start();
    const item = await h.addItem("ENG-1");
    await h.moveMain("side.txt", "side\n");
    const hooks = `${item.worktree}-hooks`;
    await Bun.write(`${hooks}/pre-rebase`, "#!/bin/sh\nexit 1\n");
    await h.git(item.worktree, "config", "core.hooksPath", hooks);
    await Bun.$`chmod 755 ${hooks}/pre-rebase`;
    expect(await h.pass("ENG-1")).toEqual({
      kind: "failed",
      reason: "merge",
      message: "rebase failed",
    });
    expect(resumes(h)).toEqual([]);
    expect(h.github.merged).toEqual([]);
  });
});
