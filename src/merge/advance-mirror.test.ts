import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { mergeHarness, pendingCi, type MergeHarness } from "./advance-harness";

let harness: MergeHarness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

async function start(settings: Parameters<typeof mergeHarness>[0]["settings"] = {}) {
  harness = await mergeHarness({ settings, mirror: true });
  return harness;
}

/** The mirror carries no linked worktree, so the lane never checked the item out. */
async function checkouts(h: MergeHarness): Promise<string[]> {
  const listed = await h.git(h.mirror!, "worktree", "list", "--porcelain");
  return listed
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
    .filter((tree) => tree !== h.mirror);
}

describe("advanceMerge for a runner-backed item reads the mirror", () => {
  test("a candidate ref merges at its head with no worktree", async () => {
    const h = await start();
    const item = await h.addItem("ENG-1");
    expect(await h.pass("ENG-1")).toEqual({ kind: "merged" });
    expect(h.github.merged.map((merge) => merge.expectedHeadSha)).toEqual([item.accepted]);
    expect(await checkouts(h)).toEqual([]);
    expect(existsSync(path.join(h.root, "worktrees"))).toBe(false);
  });

  test("a runner rebase moves the candidate ref and merges after CI", async () => {
    const h = await start({ mainMoved: "ci" });
    const item = await h.addItem("ENG-1");
    const main = await h.moveMain("side.txt", "side\n");
    let pushed = "";
    h.state.runnerRebase = async (id, heads) => {
      const as = ["-c", "user.email=runner@example.com", "-c", "user.name=Runner"];
      await h.git(item.worktree, "fetch", "-q", h.bare, "main");
      await h.git(item.worktree, ...as, "rebase", "-q", heads.main);
      await h.git(item.worktree, "push", "-qf", "origin", `HEAD:refs/heads/paws/${id}`);
      pushed = await h.git(item.worktree, "rev-parse", "HEAD");
      return { outcome: "rebased", head: pushed };
    };
    h.state.ci = pendingCi;
    expect(await h.pass("ENG-1")).toMatchObject({ kind: "wait", reason: "ci", base: main });
    expect(await h.git(h.mirror!, "rev-parse", h.candidate("ENG-1"))).toBe(pushed);

    h.state.ci = () => undefined;
    expect(await h.pass("ENG-1")).toEqual({ kind: "merged" });
    expect(h.github.merged.map((merge) => merge.expectedHeadSha)).toEqual([pushed]);
    expect(await checkouts(h)).toEqual([]);
  });

  test("the control-plane fallback rebases in a temporary checkout and moves the candidate ref", async () => {
    const h = await start({ mainMoved: "ci" });
    const item = await h.addItem("ENG-1");
    const main = await h.moveMain("side.txt", "side\n");
    h.state.runnerRebase = async () => ({ outcome: "failed", reason: "no eligible runner" });
    h.state.ci = pendingCi;
    const step = await h.pass("ENG-1");
    const head = await h.remoteHead("ENG-1");
    expect(head).not.toBe(item.accepted);
    expect(step).toMatchObject({ kind: "wait", reason: "ci", base: main, head });
    await h.git(h.bare, "merge-base", "--is-ancestor", main, head);
    expect(await h.git(h.mirror!, "rev-parse", h.candidate("ENG-1"))).toBe(head);
    expect(await checkouts(h)).toEqual([]);
  });
});
