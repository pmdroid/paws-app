import { afterEach, describe, expect, test } from "bun:test";
import { JOB_KIND } from "../core";
import { getWorkItem, listJobs, mergeCallInFlight } from "../db";
import { questionEffects } from "../loop";
import { answer, findOpenQuestion } from "../questions";
import { mergeHarness, type MergeHarness } from "./advance-harness";
import { RETRY_MERGE } from "./merge-denied";

const REFUSED = "At least 1 approving review is required by reviewers with write access.";

let harness: MergeHarness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

function refuse(h: MergeHarness): void {
  h.state.mergeDenial = async () => ({
    status: 405,
    body: { message: "Repository rule violations found", errors: [{ message: REFUSED }] },
  });
}

let replies = 0;

function reply(h: MergeHarness, id: string, body: string): void {
  const now = h.clock.now();
  answer(
    h.db,
    { sessionId: `ses-${id}`, deliveryId: `reply:${++replies}`, body, answeredBy: "acme-dev", now },
    questionEffects(h.db, { now }),
  );
}

function mergeJob(h: MergeHarness, id: string): Record<string, unknown> {
  const job = listJobs(h.db).find(
    (row) =>
      row.queue === JOB_KIND.merge &&
      row.status === "pending" &&
      (row.payload as { itemId?: unknown }).itemId === id,
  );
  expect(job).toBeDefined();
  return job!.payload as Record<string, unknown>;
}

function agentJobs(h: MergeHarness) {
  return listJobs(h.db).filter(
    (job) => job.queue === JOB_KIND.start || job.queue === JOB_KIND.resume,
  );
}

describe("a merge GitHub refuses", () => {
  test("asks with GitHub's status, reason and Retry merge instead of failing", async () => {
    const h = (harness = await mergeHarness());
    const item = await h.addItem("ACME-1");
    refuse(h);
    expect(await h.pass(item.id)).toEqual({ kind: "asked" });
    expect(getWorkItem(h.db, item.id)?.state).toBe("awaiting_input");
    expect(mergeCallInFlight(h.db, item.id)).toBe(false);
    const question = findOpenQuestion(h.db, `ses-${item.id}`)!;
    expect(question.options).toEqual([RETRY_MERGE]);
    expect(question.body).toContain("status 405");
    expect(question.body).toContain("Repository rule violations found");
    expect(question.body).toContain(REFUSED);
    expect(question.body).toContain(`https://github.com/acme/app/pull/${item.pull}`);
    expect(question.body).toContain(item.accepted);
  });

  test("Retry merge queues the accepted head again without an agent, and a 200 merges it", async () => {
    const h = (harness = await mergeHarness());
    const item = await h.addItem("ACME-2");
    refuse(h);
    await h.pass(item.id);
    reply(h, item.id, RETRY_MERGE);
    expect(getWorkItem(h.db, item.id)?.state).toBe("merge_queue");
    expect(agentJobs(h)).toEqual([]);
    expect(listJobs(h.db).filter((job) => job.queue === JOB_KIND.reverify)).toEqual([]);
    h.state.mergeDenial = null;
    expect(await h.pass(item.id, mergeJob(h, item.id))).toEqual({ kind: "merged" });
    expect(h.github.merged).toHaveLength(1);
  });

  test("a reply with guidance sends the task back to its agent", async () => {
    const h = (harness = await mergeHarness());
    const item = await h.addItem("ACME-3");
    refuse(h);
    await h.pass(item.id);
    reply(h, item.id, "Squash merges are off; enable them in the repository settings first.");
    expect(agentJobs(h).map((job) => job.queue)).toEqual([JOB_KIND.resume]);
  });

  test("the third refusal of the same head fails the item with GitHub's reason", async () => {
    const h = (harness = await mergeHarness());
    const item = await h.addItem("ACME-4");
    refuse(h);
    expect(await h.pass(item.id)).toEqual({ kind: "asked" });
    reply(h, item.id, "retry");
    expect(await h.pass(item.id, mergeJob(h, item.id))).toEqual({ kind: "asked" });
    reply(h, item.id, RETRY_MERGE);
    const failed = await h.pass(item.id, mergeJob(h, item.id));
    expect(failed).toMatchObject({ kind: "failed", reason: "merge" });
    expect((failed as { message: string }).message).toContain("status 405");
    expect((failed as { message: string }).message).toContain(REFUSED);
    expect(h.github.merged).toEqual([]);
  });

  test("a refusal because the branch is behind main rebases it without asking", async () => {
    const h = (harness = await mergeHarness({ settings: { mainMoved: "ci" } }));
    const item = await h.addItem("ACME-5");
    h.state.mergeDenial = async () => {
      h.state.mergeDenial = null;
      await h.moveMain("other.txt", "merged first\n");
      h.state.mergeState = "behind";
      return {
        status: 405,
        body: { message: "Head branch was modified. Review and try the merge again." },
      };
    };
    expect(await h.pass(item.id)).toMatchObject({ kind: "wait", reason: "ci" });
    expect(findOpenQuestion(h.db, `ses-${item.id}`)).toBeNull();
    expect(getWorkItem(h.db, item.id)?.state).toBe("merge_queue");
    h.state.mergeState = null;
    expect(await h.pass(item.id)).toMatchObject({ kind: "wait", reason: "ci" });
    expect(await h.remoteHead(item.id)).not.toBe(item.accepted);
    expect(await h.pass(item.id)).toEqual({ kind: "merged" });
    expect(agentJobs(h)).toEqual([]);
  });

  test("a 403 keeps failing the item", async () => {
    const h = (harness = await mergeHarness());
    const item = await h.addItem("ACME-6");
    h.state.mergeDenial = async () => ({
      status: 403,
      body: { message: "Resource not accessible by integration" },
    });
    expect(await h.pass(item.id)).toMatchObject({ kind: "failed", reason: "merge" });
    expect(findOpenQuestion(h.db, `ses-${item.id}`)).toBeNull();
  });
});
