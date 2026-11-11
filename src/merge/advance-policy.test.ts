import { afterEach, describe, expect, test } from "bun:test";
import { JOB_KIND } from "../core";
import { sqliteDb, getWorkItem, listJobs } from "../db";
import { mergeHarness, type MergeHarness } from "./advance-harness";

let harness: MergeHarness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

const BROKEN = {
  ok: false as const,
  message: ".agents/closeout.yaml: /rules/0 must have required property 'probe'",
  path: ".agents/closeout.yaml",
  main: "a".repeat(40),
  commit: "b".repeat(40),
};

async function reverifyJobs(h: MergeHarness): Promise<(string | null)[]> {
  return (await listJobs(sqliteDb(h.db)))
    .filter((job) => job.queue === JOB_KIND.reverify)
    .map((job) => job.jobKey);
}

describe("advanceMerge when the Closeout policy on main does not load", () => {
  test("an accepted, approved head with green CI waits in the merge queue, with no Closeout", async () => {
    const h = (harness = await mergeHarness());
    const item = await h.addItem("ENG-1");
    h.state.mainPolicy = BROKEN;
    const message = `held: ${BROKEN.message} (${BROKEN.commit})`;
    expect(await h.pass("ENG-1")).toEqual({
      kind: "wait",
      reason: "policy",
      queued: true,
      message,
      base: item.base,
      head: item.accepted,
    });
    expect(getWorkItem(h.db, "ENG-1")?.state).toBe("merge_queue");
    expect(await reverifyJobs(h)).toEqual([]);
    expect(h.verified).toEqual([]);
    expect(h.github.merged).toEqual([]);
    expect(h.state.policyHolds).toEqual([{ id: "ENG-1", repository: "acme/app", message }]);
    expect(h.bodies("status")).toEqual([message]);
  });

  test("a head behind main is neither rebased nor sent back while main's policy does not load", async () => {
    const h = (harness = await mergeHarness());
    const item = await h.addItem("ENG-1");
    await h.moveMain("side.txt", "side\n");
    h.state.mainPolicy = BROKEN;
    expect(await h.pass("ENG-1")).toMatchObject({ kind: "wait", reason: "policy" });
    expect(await h.remoteHead("ENG-1")).toBe(item.accepted);
    expect(await reverifyJobs(h)).toEqual([]);
  });

  test("main fixed with the same recheck digest: the lane settles the hold and merges without Closeout", async () => {
    const h = (harness = await mergeHarness());
    const item = await h.addItem("ENG-1");
    h.state.mainPolicy = BROKEN;
    await h.pass("ENG-1");
    h.state.mainPolicy = null;
    h.state.policyDigest = "sha256:fixed-policy";
    expect(await h.pass("ENG-1")).toEqual({ kind: "merged" });
    expect(h.state.policyLoads).toEqual(["acme/app"]);
    expect(h.github.merged.map((merge) => merge.expectedHeadSha)).toEqual([item.accepted]);
    expect(await reverifyJobs(h)).toEqual([]);
    expect(h.verified).toEqual([]);
  });

  test("main fixed but a `recheck: true` check changed: the head re-verifies as before", async () => {
    const h = (harness = await mergeHarness());
    const item = await h.addItem("ENG-1");
    h.state.mainPolicy = BROKEN;
    await h.pass("ENG-1");
    h.state.mainPolicy = null;
    h.state.policyDigest = "sha256:fixed-policy";
    h.state.recheckDigest = "sha256:changed-recheck";
    expect(await h.pass("ENG-1")).toEqual({ kind: "returned" });
    expect(getWorkItem(h.db, "ENG-1")?.state).toBe("verifying");
    expect(await reverifyJobs(h)).toEqual([`reverify:ENG-1:${item.accepted}:merge:2`]);
    expect(h.github.merged).toEqual([]);
  });

  test("an origin Paws cannot read still sends the head back, unlike a policy that does not load", async () => {
    const h = (harness = await mergeHarness());
    await h.addItem("ENG-1");
    h.state.policyDigest = null;
    expect(await h.pass("ENG-1")).toEqual({ kind: "returned" });
    expect(h.state.policyHolds).toEqual([]);
  });
});
