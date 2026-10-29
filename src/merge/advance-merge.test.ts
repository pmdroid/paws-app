import { findOpenQuestion } from "../questions";
import { afterEach, describe, expect, test } from "bun:test";
import { JOB_KIND } from "../core";
import {
  applyWorkItemEvent,
  completeMergedItem,
  enqueueJob,
  getConfirmedRemoteMerge,
  getWorkItem,
  listJobs,
  listRebaseReturns,
  recordPullReview,
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

async function backInQueue(h: MergeHarness, id: string): Promise<void> {
  const item = getWorkItem(h.db, id)!;
  if (item.state === "queued") applyWorkItemEvent(h.db, id, "dispatched");
  applyWorkItemEvent(h.db, id, "turn_ended");
  await h.closeout(id);
}

function reverifyJobs(h: MergeHarness): string[] {
  return listJobs(h.db)
    .filter((job) => job.queue === JOB_KIND.reverify)
    .map((job) => job.jobKey ?? "");
}

describe("advanceMerge and a changes-requested review", () => {
  test("a review recorded while the merge attempt runs holds the squash", async () => {
    const h = await start();
    await h.addItem("ENG-1");
    let recorded = false;
    // The webhook lands after the first guard, during the readiness reads.
    h.state.ci = () => {
      if (!recorded)
        recorded = recordPullReview(h.db, {
          reviewId: 41,
          itemId: "ENG-1",
          state: "changes_requested",
          pullNumber: 1,
          head: null,
          reviewer: "rev",
          body: "Please rename it.",
          receivedAt: h.clock.now(),
        });
      return undefined;
    };
    expect(await h.pass("ENG-1")).toMatchObject({ kind: "wait", reason: "review" });
    expect(recorded).toBe(true);
    expect(h.github.merged).toEqual([]);
    expect(getConfirmedRemoteMerge(h.db, "ENG-1")).toBeNull();
    expect(getWorkItem(h.db, "ENG-1")?.state).toBe("merge_queue");
  });
});

describe("advanceMerge: the lane only merges mergeable(S)", () => {
  test("green CI merges the accepted head with it as the expected head, without Closeout", async () => {
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
    expect(h.verified).toEqual([]);
  });

  test("pending CI waits on the accepted head and the next pass merges it", async () => {
    const h = await start();
    const item = await h.addItem("ENG-1");
    h.state.ci = pendingCi;
    expect(await h.pass("ENG-1")).toMatchObject({
      kind: "wait",
      reason: "ci",
      base: item.base,
      head: item.accepted,
    });
    expect(getWorkItem(h.db, "ENG-1")?.state).toBe("merge_queue");
    expect(h.github.merged).toEqual([]);
    h.state.ci = () => undefined;
    expect(await h.pass("ENG-1")).toEqual({ kind: "merged" });
    expect(h.verified).toEqual([]);
  });

  test("main moved: the lane rebases, pushes and sends the new head to Closeout without merging", async () => {
    const h = await start();
    const item = await h.addItem("ENG-1");
    const main = await h.moveMain("side.txt", "side\n");
    expect(await h.pass("ENG-1")).toEqual({ kind: "returned" });
    const rebased = await h.remoteHead("ENG-1");
    expect(rebased).not.toBe(item.accepted);
    expect(await onMovedMain(h, rebased, main)).toBe(true);
    expect(getWorkItem(h.db, "ENG-1")?.state).toBe("verifying");
    expect(reverifyJobs(h)).toEqual([`reverify:ENG-1:${rebased}:merge:1`]);
    expect(h.github.merged).toEqual([]);
    // After the pull request only the title moves.
    expect(h.bodies("status")).toEqual([`Rebased onto main ${main.slice(0, 7)}, re-verifying.`]);
    expect(h.bodies("thought")).toEqual([]);
    expect(h.bodies("afterPullRequest")).toEqual([]);

    expect(await h.closeout("ENG-1")).toBe(rebased);
    expect(await h.pass("ENG-1")).toEqual({ kind: "merged" });
    expect(h.github.merged.map((merge) => merge.expectedHeadSha)).toEqual([rebased]);
    expect(h.verified).toEqual([rebased]);
  });

  test("a head Closeout has not accepted goes back to verifying, unchanged", async () => {
    const h = await start();
    const item = await h.addItem("ENG-1");
    await Bun.write(`${item.worktree}/late.txt`, "late\n");
    await h.git(item.worktree, "add", ".");
    await h.git(item.worktree, "commit", "-qm", "late change");
    const head = await h.git(item.worktree, "rev-parse", "HEAD");
    expect(await h.pass("ENG-1")).toEqual({ kind: "returned" });
    expect(getWorkItem(h.db, "ENG-1")?.state).toBe("verifying");
    expect(reverifyJobs(h)).toEqual([`reverify:ENG-1:${head}:merge:1`]);
    expect(h.github.merged).toEqual([]);
    expect(h.bodies()).toEqual([]);
  });

  test("a policy that changed or cannot be read since Closeout accepted the head sends it back", async () => {
    for (const digest of ["sha256:changed-policy", null]) {
      const h = await start();
      const item = await h.addItem("ENG-1");
      h.state.policyDigest = digest;
      expect(await h.pass("ENG-1")).toEqual({ kind: "returned" });
      expect(getWorkItem(h.db, "ENG-1")?.state).toBe("verifying");
      expect(reverifyJobs(h)).toEqual([`reverify:ENG-1:${item.accepted}:merge:1`]);
      expect(h.github.merged).toEqual([]);
      await h.cleanup();
      harness = undefined;
    }
  });

  test("a pull request head that changed releases the lane: no rebase, no merge, place kept", async () => {
    const h = await start();
    const item = await h.addItem("ENG-1");
    h.state.pullHead = () => "c".repeat(40);
    expect(await h.pass("ENG-1")).toMatchObject({
      kind: "wait",
      reason: "ci",
      head: item.accepted,
      message: "The pull request head changed before the merge. Reading it again.",
    });
    expect(getWorkItem(h.db, "ENG-1")?.state).toBe("merge_queue");
    expect(await h.remoteHead("ENG-1")).toBe(item.accepted);
    expect(reverifyJobs(h)).toEqual([]);
    expect(h.github.merged).toEqual([]);
  });

  test("a stop during the facts read merges nothing and makes the pass obsolete", async () => {
    const h = await start();
    await h.addItem("ENG-1");
    h.state.ci = () => {
      h.state.stopped = true;
      return undefined;
    };
    expect(await h.pass("ENG-1")).toEqual({ kind: "obsolete" });
    expect(h.github.merged).toEqual([]);
  });
});

describe("advanceMerge and a pull request merged outside the lane", () => {
  test("a hand merge on GitHub merges the item without publishing or squashing again", async () => {
    const h = await start({ settings: { order: "queue" } });
    await h.addItem("ENG-1");
    const later = enqueueJob(h.db, {
      queue: JOB_KIND.merge,
      jobKey: "merge:ENG-1:later",
      payload: { itemId: "ENG-1" },
      now: h.clock.now(),
    });
    h.state.handMerged.set(1, "hand-merge-sha");
    expect(await h.pass("ENG-1")).toEqual({ kind: "merged" });
    expect(h.published).toEqual([]);
    expect(h.github.merged).toEqual([]);
    expect(getConfirmedRemoteMerge(h.db, "ENG-1")).toMatchObject({
      pullNumber: 1,
      pullUrl: "https://github.com/acme/app/pull/1",
      mergeSha: "hand-merge-sha",
    });
    expect(h.db.query("SELECT item_id FROM merge_queue_entry").all()).toEqual([]);
    // What the job runner does with a merged step: the item is merged and its merge work stops.
    completeMergedItem(h.db, { itemId: "ENG-1", now: h.clock.now() });
    expect(getWorkItem(h.db, "ENG-1")?.state).toBe("merged");
    expect(listJobs(h.db).find((job) => job.id === later)?.status).toBe("cancelled");
  });

  test("a hand merge during the turn merges the item instead of failing it", async () => {
    const h = await start();
    await h.addItem("ENG-1");
    h.state.handMerged.set(1, "hand-merge-sha");
    h.state.handMergeSeenAfter = 1;
    expect(await h.pass("ENG-1")).toEqual({ kind: "merged" });
    expect(h.published).toEqual(["ENG-1"]);
    expect(h.github.merged).toEqual([]);
    expect(getConfirmedRemoteMerge(h.db, "ENG-1")?.mergeSha).toBe("hand-merge-sha");
  });

  test("a stop after the hand merge is read completes the item and makes the pass obsolete", async () => {
    const h = await start();
    await h.addItem("ENG-1");
    h.state.handMerged.set(1, "hand-merge-sha");
    h.state.stopped = true;
    expect(await h.pass("ENG-1")).toEqual({ kind: "obsolete" });
    expect(getWorkItem(h.db, "ENG-1")?.state).toBe("merged");
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
    // Publication pushes the agent's resolution; the lane itself never pushes a head it merges.
    await h.git(added.worktree, "push", "-qf", "origin", "HEAD:paws/ENG-1");
    await backInQueue(h, "ENG-1");
    expect(await h.pass("ENG-1")).toEqual({ kind: "merged" });
    expect(await onMovedMain(h, h.github.merged[0]!.expectedHeadSha, main)).toBe(true);
  });

  test("after three returns for the same main the task asks and names the commit and files", async () => {
    const { h, main } = await conflicting();
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await h.pass("ENG-1")).toEqual({ kind: "returned" });
      await backInQueue(h, "ENG-1");
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
      await backInQueue(h, "ENG-1");
    }
    await h.moveMain("ok.txt", "from-main-again\n");
    expect(await h.pass("ENG-1")).toEqual({ kind: "asked" });
    expect(resumes(h)).toHaveLength(3);
  });

  test("a person's reply after the returns ran out returns the next conflict to the agent", async () => {
    const { h } = await conflicting();
    for (let attempt = 0; attempt < 3; attempt++) {
      await h.pass("ENG-1");
      await backInQueue(h, "ENG-1");
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

describe('advanceMerge and "When main moved before the merge"', () => {
  test("ci: the rebased head merges once its CI is green, without a Closeout job", async () => {
    const h = await start({ settings: { mainMoved: "ci" } });
    const item = await h.addItem("ENG-1");
    const main = await h.moveMain("side.txt", "side\n");
    h.state.ci = pendingCi;
    const rebased = await h.pass("ENG-1");
    const head = await h.remoteHead("ENG-1");
    expect(head).not.toBe(item.accepted);
    expect(await onMovedMain(h, head, main)).toBe(true);
    expect(rebased).toMatchObject({ kind: "wait", reason: "ci", base: main, head });
    expect(getWorkItem(h.db, "ENG-1")?.state).toBe("merge_queue");
    expect(h.bodies("status")).toEqual([
      `Branch updated onto main ${main.slice(0, 7)}, waiting for CI. Closeout does not run again, because "When main moved before the merge" for this task is set to wait for CI in Settings → Merging.`,
    ]);
    expect(await h.pass("ENG-1")).toMatchObject({ kind: "wait", reason: "ci", head });
    expect(h.github.merged).toEqual([]);

    h.state.ci = () => undefined;
    expect(await h.pass("ENG-1")).toEqual({ kind: "merged" });
    expect(h.github.merged.map((merge) => merge.expectedHeadSha)).toEqual([head]);
    expect(reverifyJobs(h)).toEqual([]);
    expect(h.verified).toEqual([]);
  });

  test("ci: main moving again rebases the carried head, and it still merges without Closeout", async () => {
    const h = await start({ settings: { mainMoved: "ci" } });
    await h.addItem("ENG-1");
    await h.moveMain("side.txt", "side\n");
    expect(await h.pass("ENG-1")).toMatchObject({ kind: "wait", reason: "ci" });
    const main = await h.moveMain("other.txt", "other\n");
    expect(await h.pass("ENG-1")).toMatchObject({ kind: "wait", reason: "ci" });
    const head = await h.remoteHead("ENG-1");
    expect(await onMovedMain(h, head, main)).toBe(true);
    expect(await h.pass("ENG-1")).toEqual({ kind: "merged" });
    expect(h.github.merged.map((merge) => merge.expectedHeadSha)).toEqual([head]);
    expect(reverifyJobs(h)).toEqual([]);
  });

  test("ci: a policy that changed since Closeout accepted sends the rebased head to Closeout", async () => {
    const h = await start({ settings: { mainMoved: "ci" } });
    await h.addItem("ENG-1");
    await h.moveMain("side.txt", "side\n");
    expect(await h.pass("ENG-1")).toMatchObject({ kind: "wait", reason: "ci" });
    const head = await h.remoteHead("ENG-1");
    h.state.policyDigest = "sha256:changed-policy";
    expect(await h.pass("ENG-1")).toEqual({ kind: "returned" });
    expect(getWorkItem(h.db, "ENG-1")?.state).toBe("verifying");
    expect(reverifyJobs(h)).toEqual([`reverify:ENG-1:${head}:merge:2`]);
    expect(h.github.merged).toEqual([]);
  });

  test("closeout: the rebased head runs Closeout before it merges", async () => {
    const h = await start({ settings: { mainMoved: "closeout" } });
    await h.addItem("ENG-1");
    await h.moveMain("side.txt", "side\n");
    expect(await h.pass("ENG-1")).toEqual({ kind: "returned" });
    const head = await h.remoteHead("ENG-1");
    expect(reverifyJobs(h)).toEqual([`reverify:ENG-1:${head}:merge:1`]);
    expect(h.github.merged).toEqual([]);
    await h.closeout("ENG-1");
    expect(await h.pass("ENG-1")).toEqual({ kind: "merged" });
    expect(h.verified).toEqual([head]);
  });

  test("overlap: main changed other files, so the accepted head merges without a rebase", async () => {
    const h = await start({ settings: { mainMoved: "overlap" } });
    const item = await h.addItem("ENG-1");
    await h.moveMain("side.txt", "side\n");
    expect(await h.pass("ENG-1")).toEqual({ kind: "merged" });
    expect(await h.remoteHead("ENG-1")).toBe(item.accepted);
    expect(h.github.merged.map((merge) => merge.expectedHeadSha)).toEqual([item.accepted]);
    expect(reverifyJobs(h)).toEqual([]);
    expect(h.verified).toEqual([]);
  });

  test("overlap: main changed the same package, so the branch is rebased and waits for CI", async () => {
    const h = await start({ settings: { mainMoved: "overlap" } });
    h.state.packages = ["apps/*"];
    const item = await h.addItem("ENG-1", { file: "apps/web/a.txt", content: "a\n" });
    const main = await h.moveMain("apps/web/b.txt", "b\n");
    expect(await h.pass("ENG-1")).toMatchObject({ kind: "wait", reason: "ci" });
    const head = await h.remoteHead("ENG-1");
    expect(head).not.toBe(item.accepted);
    expect(h.bodies("status")).toEqual([
      `Main changed apps/web, which this pull request changes too. Branch updated onto main ${main.slice(0, 7)}, waiting for CI.`,
    ]);
    expect(await h.pass("ENG-1")).toEqual({ kind: "merged" });
    expect(h.github.merged.map((merge) => merge.expectedHeadSha)).toEqual([head]);
    expect(reverifyJobs(h)).toEqual([]);
  });

  test("green: main changed the same package, and the accepted head still merges without a rebase", async () => {
    const h = await start({ settings: { mainMoved: "green" } });
    h.state.packages = ["apps/*"];
    const item = await h.addItem("ENG-1", { file: "apps/web/a.txt", content: "a\n" });
    await h.moveMain("apps/web/b.txt", "b\n");
    expect(await h.pass("ENG-1")).toEqual({ kind: "merged" });
    expect(await h.remoteHead("ENG-1")).toBe(item.accepted);
    expect(h.github.merged.map((merge) => merge.expectedHeadSha)).toEqual([item.accepted]);
    expect(reverifyJobs(h)).toEqual([]);
  });

  test("green: GitHub's up-to-date rule still updates the branch and waits for CI", async () => {
    const h = await start({ settings: { mainMoved: "green" } });
    h.state.upToDateRule = true;
    const item = await h.addItem("ENG-1");
    await h.moveMain("side.txt", "side\n");
    expect(await h.pass("ENG-1")).toMatchObject({ kind: "wait", reason: "ci" });
    expect(await h.remoteHead("ENG-1")).not.toBe(item.accepted);
  });

  test("overlap: GitHub's up-to-date rule updates the branch and waits for CI", async () => {
    const h = await start({ settings: { mainMoved: "overlap" } });
    h.state.upToDateRule = true;
    const item = await h.addItem("ENG-1");
    await h.moveMain("side.txt", "side\n");
    expect(await h.pass("ENG-1")).toMatchObject({ kind: "wait", reason: "ci" });
    const head = await h.remoteHead("ENG-1");
    expect(head).not.toBe(item.accepted);
    expect(h.bodies("status")[0]).toContain("GitHub requires branches to be up to date");
    expect(await h.pass("ENG-1")).toEqual({ kind: "merged" });
    expect(h.github.merged.map((merge) => merge.expectedHeadSha)).toEqual([head]);
    expect(reverifyJobs(h)).toEqual([]);
  });
});
