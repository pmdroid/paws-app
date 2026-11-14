import { afterEach, describe, expect, test } from "bun:test";
import { getWorkItem, listRebaseReturns } from "../db";
import { setJournalSink } from "../journal";
import { mergeHarnessPg, pendingCi, type MergeHarnessPg } from "./advance-harness";
import { tempStore } from "../../test/pglite";

let harness: MergeHarnessPg | undefined;
let restoreJournal: (() => void) | undefined;
let journalLines: string[] = [];

afterEach(async () => {
  restoreJournal?.();
  await harness?.cleanup();
  harness = undefined;
});

async function start(options: Parameters<typeof mergeHarnessPg>[1] = {}) {
  harness = await mergeHarnessPg(await tempStore(), options);
  journalLines = [];
  restoreJournal = setJournalSink((line) => journalLines.push(line));
  return harness;
}

const fallbacks = () =>
  journalLines.filter(
    (line) => line.includes("without GitHub's update-branch") || line.includes("control plane"),
  );

describe("advanceMerge with [github] mirrors = false", () => {
  test("main_moved = ci rebases through GitHub's update-branch and merges the head GitHub made", async () => {
    const h = await start({ settings: { mainMoved: "ci" }, githubMirrors: false });
    const item = await h.addItem("ENG-1");
    const main = await h.moveMain("side.txt", "side\n");
    h.state.runnerRebase = async () => {
      throw new Error("the runner is not asked");
    };
    h.state.ci = pendingCi;
    const step = await h.pass("ENG-1");
    const head = await h.remoteHead("ENG-1");
    expect(h.state.branchUpdates).toEqual([{ id: "ENG-1", expectedHead: item.accepted }]);
    expect(head).not.toBe(item.accepted);
    expect(step).toMatchObject({ kind: "wait", reason: "ci", base: main, head });
    expect(await h.git(item.worktree, "rev-parse", "HEAD")).toBe(head);
    expect(fallbacks()).toEqual([]);

    h.state.ci = () => undefined;
    expect(await h.pass("ENG-1")).toEqual({ kind: "merged" });
    expect(h.github.merged.map((merge) => merge.expectedHeadSha)).toEqual([head]);
  });

  test("a runner-backed item's candidate ref moves to the head GitHub made", async () => {
    const h = await start({ settings: { mainMoved: "ci" }, githubMirrors: false, mirror: true });
    const item = await h.addItem("ENG-1");
    const main = await h.moveMain("side.txt", "side\n");
    h.state.ci = pendingCi;
    const step = await h.pass("ENG-1");
    const head = await h.remoteHead("ENG-1");
    expect(head).not.toBe(item.accepted);
    expect(step).toMatchObject({ kind: "wait", reason: "ci", base: main, head });
    expect(await h.git(h.mirror!, "rev-parse", h.candidate("ENG-1"))).toBe(head);
    expect(fallbacks()).toEqual([]);
  });

  test("a conflict GitHub reports goes back to the agent through the conflict return", async () => {
    const h = await start({ settings: { mainMoved: "ci" }, githubMirrors: false });
    const item = await h.addItem("ENG-1", { file: "ok.txt", content: "agent\n" });
    const main = await h.moveMain("ok.txt", "from-main\n");
    h.state.updateBranch = async () => ({
      status: 200,
      body: { data: null, errors: [{ message: "merge conflict between base and head" }] },
    });
    expect(await h.pass("ENG-1")).toEqual({ kind: "returned" });
    expect((await getWorkItem(h.db, "ENG-1"))?.state).toBe("queued");
    expect((await listRebaseReturns(h.db, "ENG-1", 0)).map((row) => row.base)).toEqual([main]);
    expect(await h.remoteHead("ENG-1")).toBe(item.accepted);
    expect(fallbacks()).toEqual([]);
  });

  test("a refused update falls back to the local rebase, and the journal notes it", async () => {
    const h = await start({ settings: { mainMoved: "ci" }, githubMirrors: false });
    const item = await h.addItem("ENG-1");
    const main = await h.moveMain("side.txt", "side\n");
    h.state.updateBranch = async () => ({
      status: 200,
      body: { data: null, errors: [{ message: "refusing to allow a GitHub App to update" }] },
    });
    h.state.ci = pendingCi;
    const step = await h.pass("ENG-1");
    const head = await h.remoteHead("ENG-1");
    expect(head).not.toBe(item.accepted);
    expect(step).toMatchObject({ kind: "wait", reason: "ci", base: main, head });
    expect(fallbacks()).toEqual([
      "item ENG-1 rebases without GitHub's update-branch: GitHub did not update the branch: refusing to allow a GitHub App to update",
      "item ENG-1 rebases on the control plane: runner rebase no runner rebase",
    ]);
  });

  test("other main_moved modes and mirrors = true keep the local rebase", async () => {
    for (const options of [
      { settings: { mainMoved: "closeout" as const }, githubMirrors: false },
      { settings: { mainMoved: "ci" as const }, githubMirrors: true },
      { settings: { mainMoved: "ci" as const } },
    ]) {
      const h = await start(options);
      await h.addItem("ENG-1");
      await h.moveMain("side.txt", "side\n");
      await h.pass("ENG-1");
      expect(h.state.branchUpdates).toEqual([]);
      await h.cleanup();
      harness = undefined;
      restoreJournal?.();
    }
  });
});
