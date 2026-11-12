import { afterEach, describe, expect, test } from "bun:test";
import { mergeResultPolicyError, POLICY_SCHEMA_SUMMARY } from "../src/closeout-spec";
import { JOB_KIND } from "../src/core";
import { getWorkItem, listJobs } from "../src/db";
import { createFakeMergeQueue } from "../src/github";
import {
  mergeHarnessPg,
  type HarnessItem,
  type MergeHarnessPg,
} from "../src/merge/advance-harness";
import { tempStore } from "./pglite";

let harness: MergeHarnessPg | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
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

  async function policyChange(
    options: Parameters<typeof mergeHarnessPg>[1] = { settings: { mainMoved: "ci" } },
  ): Promise<{ h: MergeHarnessPg; item: HarnessItem }> {
    const h = (harness = await mergeHarnessPg(await tempStore(), options));
    h.state.mergeResultPolicy = (worktree, heads) => {
      const error = mergeResultPolicyError(worktree, heads.base, heads.head);
      return error === undefined ? undefined : { error, reference: POLICY_SCHEMA_SUMMARY };
    };
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
    expect((await getWorkItem(h.db, "ENG-1"))?.state).toBe("queued");
    const resume = (await listJobs(h.db)).find((job) => job.queue === JOB_KIND.resume);
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

  test("with GitHub's merge queue, a merge result whose policy doesn't load is never queued", async () => {
    const queue = createFakeMergeQueue({ ahead: 1, headOf: async () => "" });
    const { h } = await policyChange({ settings: { order: "github-queue" }, queue });
    await h.moveMain(skill("acme-reviewer"), "# Acme review\n", [skill("acme-review")]);
    expect(await h.pass("ENG-1")).toEqual({ kind: "returned" });
    expect(queue.enqueued).toEqual([]);
    expect(h.github.merged).toEqual([]);
    const resume = (await listJobs(h.db)).find((job) => job.queue === JOB_KIND.resume);
    expect((resume?.payload as { reason: string } | undefined)?.reason).toBe("findings");
  });

  test("with GitHub's merge queue, a merge result whose policy loads is queued as before", async () => {
    let head = async (): Promise<string> => "";
    const queue = createFakeMergeQueue({ ahead: 1, headOf: () => head() });
    const { h } = await policyChange({ settings: { order: "github-queue" }, queue });
    head = () => h.remoteHead("ENG-1");
    await h.moveMain("side.txt", "side\n");
    expect(await h.pass("ENG-1")).toMatchObject({ kind: "wait", githubQueue: { queued: true } });
    expect(queue.enqueued).toHaveLength(1);
  });

  test("with GitHub's merge queue, main breaking a queued merge result takes it out of the queue", async () => {
    let head = async (): Promise<string> => "";
    const queue = createFakeMergeQueue({ ahead: 1, headOf: () => head() });
    const { h } = await policyChange({ settings: { order: "github-queue" }, queue });
    head = () => h.remoteHead("ENG-1");
    expect(await h.pass("ENG-1")).toMatchObject({ kind: "wait", githubQueue: { queued: true } });
    await h.moveMain(skill("acme-reviewer"), "# Acme review\n", [skill("acme-review")]);
    expect(await h.pass("ENG-1")).toEqual({ kind: "returned" });
    expect(queue.calls).toContain("dequeue");
    const resume = (await listJobs(h.db)).find((job) => job.queue === JOB_KIND.resume);
    expect((resume?.payload as { reason: string } | undefined)?.reason).toBe("findings");
  });

  test("a merge result git cannot build stops the merge instead of passing", async () => {
    const { h, item } = await policyChange();
    const blob = await h.git(item.worktree, "rev-parse", "HEAD:.agents/closeout.yaml");
    expect(() => mergeResultPolicyError(item.worktree, item.base, blob)).toThrow(
      "could not build the merge result",
    );
  });

  const unreadableMain = {
    ok: false as const,
    message: ".agents/closeout.yaml: review acme-review: skill file is missing",
    path: ".agents/closeout.yaml",
    main: "a".repeat(40),
    commit: "b".repeat(40),
  };

  test("with GitHub's merge queue, an unreadable main policy holds the pull request instead of queueing it", async () => {
    const queue = createFakeMergeQueue({ ahead: 1, headOf: async () => "" });
    const { h } = await policyChange({ settings: { order: "github-queue" }, queue });
    h.state.mainPolicy = unreadableMain;
    expect(await h.pass("ENG-1")).toMatchObject({ kind: "wait", reason: "policy", queued: true });
    expect(queue.enqueued).toEqual([]);
    expect(h.state.policyHolds.map((hold) => hold.id)).toEqual(["ENG-1"]);
    expect((await listJobs(h.db)).filter((job) => job.queue === JOB_KIND.resume)).toEqual([]);
    expect((await getWorkItem(h.db, "ENG-1"))?.state).toBe("merge_queue");
  });

  test("with GitHub's merge queue, main's policy breaking while queued takes the pull request out and holds it", async () => {
    let head = async (): Promise<string> => "";
    const queue = createFakeMergeQueue({ ahead: 1, headOf: () => head() });
    const { h } = await policyChange({ settings: { order: "github-queue" }, queue });
    head = () => h.remoteHead("ENG-1");
    expect(await h.pass("ENG-1")).toMatchObject({ kind: "wait", githubQueue: { queued: true } });
    h.state.mainPolicy = unreadableMain;
    expect(await h.pass("ENG-1")).toMatchObject({ kind: "wait", reason: "policy", queued: true });
    expect(queue.calls).toContain("dequeue");
    expect((await listJobs(h.db)).filter((job) => job.queue === JOB_KIND.resume)).toEqual([]);

    h.state.mainPolicy = null;
    expect(await h.pass("ENG-1")).toMatchObject({ kind: "wait", githubQueue: { queued: true } });
    expect(h.state.policyLoads).toContain("acme/app");
  });
});
