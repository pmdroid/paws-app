import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { getItemCandidate, sqliteDb } from "../db";
import { mergeHarness, pendingCi, type MergeHarness } from "./advance-harness";

let harness: MergeHarness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

test("a candidate stored in the database merges at its head with no mirror", async () => {
  harness = await mergeHarness({ storedCandidates: true });
  const item = await harness.addItem("ENG-1");
  expect((await getItemCandidate(sqliteDb(harness.db), "ENG-1"))?.sha).toBe(item.accepted);
  expect(await harness.pass("ENG-1")).toEqual({ kind: "merged" });
  expect(harness.github.merged.map((merge) => merge.expectedHeadSha)).toEqual([item.accepted]);
  expect(existsSync(path.join(harness.root, "repos"))).toBe(false);
});

test("a runner rebase records the new head in the database", async () => {
  const h = (harness = await mergeHarness({
    storedCandidates: true,
    mirror: true,
    settings: { mainMoved: "ci" },
  }));
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
  expect((await getItemCandidate(sqliteDb(h.db), "ENG-1"))?.sha).toBe(pushed);

  h.state.ci = () => undefined;
  expect(await h.pass("ENG-1")).toEqual({ kind: "merged" });
  expect(h.github.merged.map((merge) => merge.expectedHeadSha)).toEqual([pushed]);
});

test("the control-plane rebase of a stored candidate records the pushed head in the database", async () => {
  const h = (harness = await mergeHarness({
    storedCandidates: true,
    mirror: true,
    settings: { mainMoved: "ci" },
  }));
  const item = await h.addItem("ENG-1");
  const main = await h.moveMain("side.txt", "side\n");
  h.state.runnerRebase = async () => ({ outcome: "failed", reason: "no eligible runner" });
  h.state.ci = pendingCi;
  const step = await h.pass("ENG-1");
  const head = await h.remoteHead("ENG-1");
  expect(head).not.toBe(item.accepted);
  expect(step).toMatchObject({ kind: "wait", reason: "ci", base: main, head });
  expect((await getItemCandidate(sqliteDb(h.db), "ENG-1"))?.sha).toBe(head);
  expect(await h.git(h.mirror!, "for-each-ref", "refs/paws/candidates")).toBe("");
});
