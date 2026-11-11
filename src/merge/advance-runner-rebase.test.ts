import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { sqliteDb, getWorkItem, listRebaseReturns } from "../db";
import { setJournalSink } from "../journal";
import { mergeHarness, pendingCi, type MergeHarness } from "./advance-harness";

let harness: MergeHarness | undefined;
let restoreJournal: (() => void) | undefined;
let journalLines: string[] = [];

afterEach(async () => {
  restoreJournal?.();
  await harness?.cleanup();
  harness = undefined;
});

async function start(settings: Parameters<typeof mergeHarness>[0] = {}) {
  harness = await mergeHarness(settings);
  journalLines = [];
  restoreJournal = setJournalSink((line) => journalLines.push(line));
  return harness;
}

async function runnerRebase(
  h: MergeHarness,
  id: string,
  heads: { head: string; main: string },
  extra?: string,
): Promise<string> {
  const clone = path.join(h.root, `runner-${id}-${heads.main.slice(0, 7)}`);
  await h.git(h.root, "clone", "-q", h.bare, clone);
  const as = ["-c", "user.email=runner@example.com", "-c", "user.name=Runner"];
  await h.git(clone, "checkout", "-q", heads.head);
  await h.git(clone, ...as, "rebase", "-q", heads.main);
  if (extra !== undefined) {
    await writeFile(path.join(clone, "extra.txt"), extra);
    await h.git(clone, "add", ".");
    await h.git(clone, ...as, "commit", "-qm", "not the accepted patch");
  }
  await h.git(clone, "push", "-qf", "origin", `HEAD:refs/heads/paws/${id}`);
  return h.git(clone, "rev-parse", "HEAD");
}

const fallbacks = () => journalLines.filter((line) => line.includes("on the control plane"));

describe("advanceMerge rebases on a runner", () => {
  test("a runner-rebased head that verifies carries the acceptance and waits for CI", async () => {
    const h = await start({ settings: { mainMoved: "ci" } });
    const item = await h.addItem("ENG-1");
    const main = await h.moveMain("side.txt", "side\n");
    const asked: { head: string; main: string }[] = [];
    let pushed = "";
    h.state.runnerRebase = async (id, heads) => {
      asked.push(heads);
      pushed = await runnerRebase(h, id, heads);
      return { outcome: "rebased", head: pushed };
    };
    h.state.ci = pendingCi;
    expect(await h.pass("ENG-1")).toMatchObject({ kind: "wait", reason: "ci", base: main });
    expect(asked).toEqual([{ head: item.accepted, main }]);
    expect(await h.remoteHead("ENG-1")).toBe(pushed);
    expect(await h.git(item.worktree, "rev-parse", "HEAD")).toBe(pushed);
    expect(fallbacks()).toEqual([]);

    h.state.ci = () => undefined;
    expect(await h.pass("ENG-1")).toEqual({ kind: "merged" });
    expect(h.github.merged.map((merge) => merge.expectedHeadSha)).toEqual([pushed]);
  });

  test("a head whose patch-id differs is refused and the lane rebases on the control plane", async () => {
    const h = await start({ settings: { mainMoved: "ci" } });
    const item = await h.addItem("ENG-1");
    const main = await h.moveMain("side.txt", "side\n");
    let pushed = "";
    h.state.runnerRebase = async (id, heads) => {
      pushed = await runnerRebase(h, id, heads, "smuggled\n");
      return { outcome: "rebased", head: pushed };
    };
    h.state.ci = pendingCi;
    const step = await h.pass("ENG-1");
    const head = await h.remoteHead("ENG-1");
    expect(head).not.toBe(pushed);
    expect(head).not.toBe(item.accepted);
    expect(step).toMatchObject({ kind: "wait", reason: "ci", base: main, head });
    expect(await h.git(h.bare, "ls-tree", "--name-only", head)).not.toContain("extra.txt");
    expect(fallbacks()).toEqual([
      `item ENG-1 rebases on the control plane: runner rebase refused ${pushed.slice(0, 7)}: its patch-id differs from the accepted head's`,
    ]);
  });

  test("a runner conflict goes back to the agent through the conflict return", async () => {
    const h = await start();
    const item = await h.addItem("ENG-1", { file: "ok.txt", content: "agent\n" });
    const main = await h.moveMain("ok.txt", "from-main\n");
    h.state.runnerRebase = async () => ({ outcome: "conflict", files: ["ok.txt"] });
    expect(await h.pass("ENG-1")).toEqual({ kind: "returned" });
    expect((await getWorkItem(sqliteDb(h.db), "ENG-1"))?.state).toBe("queued");
    expect(
      (await listRebaseReturns(sqliteDb(h.db), "ENG-1", 0)).map((row) => ({
        base: row.base,
        files: row.files,
      })),
    ).toEqual([{ base: main, files: ["ok.txt"] }]);
    expect(await h.remoteHead("ENG-1")).toBe(item.accepted);
    expect(fallbacks()).toEqual([]);
  });

  test("a timeout falls back to the control-plane rebase once, and the journal notes it", async () => {
    const h = await start();
    const item = await h.addItem("ENG-1");
    const main = await h.moveMain("side.txt", "side\n");
    h.state.runnerRebase = async () => ({
      outcome: "failed",
      reason: "timed out after 10 minutes",
    });
    expect(await h.pass("ENG-1")).toEqual({ kind: "returned" });
    const head = await h.remoteHead("ENG-1");
    expect(head).not.toBe(item.accepted);
    await h.git(h.bare, "merge-base", "--is-ancestor", main, head);
    expect((await getWorkItem(sqliteDb(h.db), "ENG-1"))?.state).toBe("verifying");
    expect(fallbacks()).toEqual([
      "item ENG-1 rebases on the control plane: runner rebase timed out after 10 minutes",
    ]);
  });

  test("stopping the item during the runner rebase stops the lane without the fallback", async () => {
    const h = await start({ settings: { mainMoved: "ci" } });
    const item = await h.addItem("ENG-1");
    await h.moveMain("side.txt", "side\n");
    h.state.runnerRebase = (_, __, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        h.state.publication.abort(new Error("item stopped"));
      });
    await expect(h.pass("ENG-1")).rejects.toThrow("item stopped");
    expect(await h.remoteHead("ENG-1")).toBe(item.accepted);
    expect(fallbacks()).toEqual([]);
  });

  test("stopping the item while the runner head is checked stops the lane without the fallback", async () => {
    const h = await start({ settings: { mainMoved: "ci" } });
    const item = await h.addItem("ENG-1");
    await h.moveMain("side.txt", "side\n");
    h.state.runnerRebase = async (id, heads) => {
      const pushed = await runnerRebase(h, id, heads);
      h.state.publication.abort(new Error("item stopped"));
      return { outcome: "rebased", head: pushed };
    };
    await expect(h.pass("ENG-1")).rejects.toThrow("item stopped");
    expect(await h.git(item.worktree, "rev-parse", "HEAD")).toBe(item.accepted);
    expect(fallbacks()).toEqual([]);
  });
});
