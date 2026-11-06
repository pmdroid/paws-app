import { afterEach, describe, expect, test } from "bun:test";
import { JOB_KIND } from "../core";
import { mergeResultPolicyError, POLICY_SCHEMA_SUMMARY } from "../closeout-spec";
import { getWorkItem, listJobs } from "../db";
import { mergeHarness, type HarnessItem, type MergeHarness } from "./advance-harness";

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

function reverifyJobs(h: MergeHarness): (string | null)[] {
  return listJobs(h.db)
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
    expect(reverifyJobs(h)).toEqual([]);
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
    expect(reverifyJobs(h)).toEqual([]);
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
    expect(reverifyJobs(h)).toEqual([]);
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
    expect(reverifyJobs(h)).toEqual([`reverify:ENG-1:${item.accepted}:merge:2`]);
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

describe("advanceMerge when the pull request changes the Closeout policy", () => {
  const skill = (name: string) => `.agents/skills/${name}/SKILL.md`;
  const reviewPolicy = JSON.stringify({
    specVersion: "0.1",
    items: [
      {
        id: "acme-review",
        kind: "review",
        gate: "beforePR",
        skill: skill("acme-review"),
        independence: { differentSession: true, differentModel: false },
        failOn: "P1",
      },
    ],
  });

  async function policyChange(): Promise<{ h: MergeHarness; item: HarnessItem }> {
    const h = (harness = await mergeHarness({ settings: { mainMoved: "ci" } }));
    h.state.mergeResultPolicy = (worktree, heads) =>
      mergeResultPolicyError(worktree, heads.base, heads.head);
    await h.moveMain(skill("acme-review"), "# Acme review\n");
    const item = await h.addItem("ENG-1", { file: ".agents/closeout.yaml", content: reviewPolicy });
    expect(mergeResultPolicyError(item.worktree, item.base, item.accepted)).toBeUndefined();
    return { h, item };
  }

  test("main renamed a skill the branch's policy references: no squash, back to the agent", async () => {
    const { h, item } = await policyChange();
    await h.moveMain(skill("acme-reviewer"), "# Acme review\n", [skill("acme-review")]);
    expect(await h.pass("ENG-1")).toMatchObject({ kind: "wait", reason: "ci" });
    const rebased = await h.remoteHead("ENG-1");
    expect(rebased).not.toBe(item.accepted);

    expect(await h.pass("ENG-1")).toEqual({ kind: "returned" });
    expect(h.github.merged).toEqual([]);
    expect(getWorkItem(h.db, "ENG-1")?.state).toBe("queued");
    const resume = listJobs(h.db).find((job) => job.queue === JOB_KIND.resume);
    const payload = resume?.payload as { reason: string; handoff: string };
    expect(payload.reason).toBe("findings");
    expect(payload.handoff).toContain(
      `The Closeout policy doesn't load once this pull request merges into main: `,
    );
    expect(payload.handoff).toContain(skill("acme-review"));
    expect(payload.handoff).toContain(POLICY_SCHEMA_SUMMARY);
  });

  test("a merge result whose policy loads squashes as before", async () => {
    const { h } = await policyChange();
    await h.moveMain("side.txt", "side\n");
    expect(await h.pass("ENG-1")).toMatchObject({ kind: "wait", reason: "ci" });
    const rebased = await h.remoteHead("ENG-1");
    expect(await h.pass("ENG-1")).toEqual({ kind: "merged" });
    expect(h.github.merged.map((merge) => merge.expectedHeadSha)).toEqual([rebased]);
  });
});
