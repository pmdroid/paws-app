import { JOB_KIND } from "../../src/core";
import { listJobs } from "../../src/db";
import { acceptGitHubDelivery } from "../../src/loop";
import defaultOrder from "./github-queue-default-order";
import { type Proof } from "./harness";

export default {
  covers: ["src/merge/orders.ts", "src/merge/wait.ts", "src/github/merge-queue.ts"],
  summary:
    "GitHub refuses to add the accepted pull request to its merge queue until a code owner reviews it: the item waits in the merge queue instead of failing, and the review event gets it queued and merged.",
  mergeQueue: true,
  agent: defaultOrder.agent,
  async run(proof) {
    const queue = proof.github.queue!;
    const deliver = (deliveryId: string, event: string, body: unknown) =>
      acceptGitHubDelivery(
        proof.store,
        { deliveryId, event, payload: JSON.stringify(body) },
        Date.now(),
      );
    queue.refusal = "Pull request Waiting on code owner review from acme/widget-owners.";
    await proof.delegate();
    const refused = await proof.waitFor(
      "GitHub refuses to queue the pull request for a review",
      () => queue.enqueued.length > 0,
      120_000,
    );
    const waiting = await proof.waitFor(
      "the item shows the review wait",
      async () =>
        (await listJobs(proof.store)).some(
          (job) =>
            job.queue === JOB_KIND.merge &&
            JSON.stringify(job.payload).includes(
              "Waiting for code owner review from acme/widget-owners.",
            ),
        ),
      30_000,
    );
    const transitions = await proof.transitions();
    proof.expect(
      "the refused item waits in the merge queue with the review reason and does not fail",
      refused &&
        waiting &&
        (await proof.itemState()) === "merge_queue" &&
        !transitions.some((transition) => transition.event === "work_failed"),
      { state: await proof.itemState(), transitions, enqueued: queue.enqueued },
    );
    queue.refusal = null;
    const head = queue.enqueued[0]!.head;
    await deliver("review-approved", "pull_request_review", {
      action: "submitted",
      review: { state: "approved" },
      pull_request: { number: 1, head: { sha: head } },
    });
    const queued = await proof.waitFor(
      "the review event gets the pull request queued",
      () => queue.isQueued(1),
      120_000,
    );
    queue.merge(1, "queue-merge-sha");
    await deliver("queue-merged", "merge_group", { action: "destroyed", reason: "merged" });
    const merged = await proof.waitFor(
      "the item is merged",
      async () => ["merged", "failed", "manual"].includes((await proof.itemState()) ?? ""),
      120_000,
    );
    proof.expect(
      "after the review the same head is queued and merges",
      queued &&
        merged &&
        (await proof.itemState()) === "merged" &&
        queue.enqueued.length === 2 &&
        queue.enqueued.every((entry) => entry.head === head),
      { state: await proof.itemState(), enqueued: queue.enqueued, calls: queue.calls },
    );
  },
} satisfies Proof;
