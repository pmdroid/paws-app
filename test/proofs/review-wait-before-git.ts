import { acceptGitHubDelivery } from "../../src/loop";
import mainMoved from "./main-moved";
import { REMOTE_GIT, type Proof } from "./harness";

const NOTICE = "Waiting for an approving review on";

export default {
  covers: ["src/merge/advance.ts", "src/merge/orders.ts"],
  summary:
    "The open pull request needs a person's review while every remote git call fails: Paws reads the review before any git work, posts the review wait once and leaves the merge queue, and the approval merges it.",
  ciPending: true,
  agent: mainMoved.agent,
  async run(proof) {
    const deliver = async (deliveryId: string, action: string, state: string) =>
      acceptGitHubDelivery(
        proof.store,
        {
          deliveryId,
          event: "pull_request_review",
          payload: JSON.stringify({
            action,
            review: { state },
            pull_request: { number: 1, head: { ref: await proof.itemBranch() } },
          }),
        },
        Date.now(),
      );
    const notices = () => proof.linear.progress.filter((update) => update.body.includes(NOTICE));
    await proof.delegate();
    const opened = await proof.waitFor(
      "the pull request opens and waits for CI",
      async () =>
        proof.github.opened.length === 1 &&
        (await proof.itemState()) === "merge_queue" &&
        proof.github.calls.some((call) => call.path === "/graphql"),
      120_000,
    );
    proof.github.git.failRemote = true;
    proof.github.ci.review = "REVIEW_REQUIRED";
    const before = proof.github.git.calls.length;
    await deliver("review-dismissed", "dismissed", "dismissed");
    const posted = await proof.waitFor(
      "the review wait is posted",
      () => notices().length > 0,
      60_000,
    );
    await deliver("review-dismissed-again", "dismissed", "dismissed");
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const remote = proof.github.git.calls
      .slice(before)
      .filter((args) => REMOTE_GIT.some((command) => args.includes(command)));
    proof.expect(
      "the review wait is posted once without any remote git call, and the item keeps waiting",
      opened &&
        posted &&
        notices().length === 1 &&
        remote.length === 0 &&
        (await proof.itemState()) === "merge_queue",
      { notices: notices().map((update) => update.body), remote, state: await proof.itemState() },
    );
    proof.github.git.failRemote = false;
    proof.github.ci.review = "APPROVED";
    proof.github.ci.pending = false;
    await deliver("review-approved", "submitted", "approved");
    const merged = await proof.waitFor(
      "the approved pull request merges",
      async () => ["merged", "failed", "manual"].includes((await proof.itemState()) ?? ""),
      120_000,
    );
    proof.expect(
      "the approval merges the item",
      merged && (await proof.itemState()) === "merged" && proof.github.merged.size === 1,
      { state: await proof.itemState(), merged: [...proof.github.merged] },
    );
  },
} satisfies Proof;
