import { afterEach, expect, test } from "bun:test";
import { getWorkItem, mergeQueuePosition } from "../db";
import { mergeHarness, type MergeHarness } from "./advance-harness";
import { mergeable, type MergeFacts } from "./mergeable";

let harness: MergeHarness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

const S = "a".repeat(40);

function facts(overrides: Partial<MergeFacts> = {}): MergeFacts {
  return {
    head: S,
    headMoved: false,
    accept: { head: S, policyDigest: "sha256:policy" },
    policyDigest: "sha256:policy",
    containsMain: true,
    ci: "green",
    unresolvedThreads: 0,
    protection: "satisfied",
    riskApproval: "not_required",
    ...overrides,
  };
}

test("mergeable(S) blocks a high-risk head nobody approved, after Closeout's acceptance", () => {
  expect(mergeable(facts({ riskApproval: "missing" }))).toEqual({
    ok: false,
    block: "risk_approval",
  });
  expect(mergeable(facts({ riskApproval: "approved" }))).toEqual({ ok: true });
  expect(mergeable(facts({ riskApproval: "not_required" }))).toEqual({ ok: true });
  // A head Closeout never accepted goes back through Closeout before anyone is asked.
  expect(mergeable(facts({ riskApproval: "missing", accept: null }))).toEqual({
    ok: false,
    block: "not_accepted",
  });
});

test("a normal-tier pull request merges as it does today", async () => {
  const h = (harness = await mergeHarness({ settings: { order: "queue" } }));
  await h.addItem("ENG-1");
  expect(await h.pass("ENG-1")).toEqual({ kind: "merged" });
  expect(h.state.riskAsked).toEqual([]);
  expect(h.github.merged).toHaveLength(1);
});

test("a high-risk head is held out of the merge queue and asked about", async () => {
  const h = (harness = await mergeHarness({ settings: { order: "queue" } }));
  const item = await h.addItem("ENG-1");
  h.state.risk = () => "missing";
  expect(await h.pass("ENG-1")).toEqual({ kind: "asked" });
  expect(h.state.riskAsked).toEqual([item.accepted]);
  expect(h.github.merged).toEqual([]);
  expect(mergeQueuePosition(h.db, "ENG-1")).toBeNull();
  expect(getWorkItem(h.db, "ENG-1")?.state).toBe("merge_queue");
});

test("an approved high-risk head joins the queue and merges", async () => {
  const h = (harness = await mergeHarness({ settings: { order: "queue" } }));
  const item = await h.addItem("ENG-1");
  h.state.risk = (head) => (head === item.accepted ? "approved" : "missing");
  expect(await h.pass("ENG-1")).toEqual({ kind: "merged" });
  expect(h.state.riskAsked).toEqual([]);
  expect(h.github.merged).toHaveLength(1);
});

test("under ci, a head the lane rebased onto main keeps the approval of the head it came from", async () => {
  const h = (harness = await mergeHarness({ settings: { mainMoved: "ci" } }));
  const item = await h.addItem("ENG-1");
  // Approved for the accepted head only; the lane's rebase makes a new head.
  h.state.risk = (head) => (head === item.accepted ? "approved" : "missing");
  await h.moveMain("side.txt", "side\n");
  expect(await h.pass("ENG-1")).toMatchObject({ kind: "wait", reason: "ci" });
  const head = await h.remoteHead("ENG-1");
  expect(head).not.toBe(item.accepted);
  expect(await h.pass("ENG-1")).toEqual({ kind: "merged" });
  expect(h.state.riskAsked).toEqual([]);
  expect(h.github.merged.map((merge) => merge.expectedHeadSha)).toEqual([head]);
});

test("under ci, a high-risk head nobody approved is asked about before the lane rebases it", async () => {
  const h = (harness = await mergeHarness({ settings: { mainMoved: "ci" } }));
  const item = await h.addItem("ENG-1");
  h.state.risk = () => "missing";
  await h.moveMain("side.txt", "side\n");
  expect(await h.pass("ENG-1")).toEqual({ kind: "asked" });
  expect(h.state.riskAsked).toEqual([item.accepted]);
  expect(await h.remoteHead("ENG-1")).toBe(item.accepted);
  expect(h.github.merged).toEqual([]);
});
