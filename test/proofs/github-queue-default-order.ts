import { join } from "node:path";
import { type Proof } from "./harness";

export default {
  covers: ["src/merge/advance.ts", "src/merge/base-queue.ts", "src/github/merge-queue.ts"],
  summary:
    "Under the default merge order, main has a GitHub merge queue: Paws adds the accepted pull request to it, never squashes, and the item merges when GitHub's queue merges it.",
  mergeQueue: true,
  agent: (input) =>
    input.purpose === "implement"
      ? [
          { type: "fs_write", path: join(input.worktree, "widgets.txt"), content: "12\n" },
          { type: "terminal", command: "git", args: ["add", "widgets.txt"], cwd: input.worktree },
          {
            type: "terminal",
            command: "git",
            args: ["commit", "-q", "-m", "Count widgets per shelf"],
            cwd: input.worktree,
          },
        ]
      : [],
  async run(proof) {
    const queue = proof.github.queue!;
    await proof.delegate();
    const enqueued = await proof.waitFor(
      "the pull request joins GitHub's merge queue",
      () => queue.enqueued.length > 0,
      120_000,
    );
    proof.expect("the accepted head was added to GitHub's merge queue once", enqueued, {
      enqueued: queue.enqueued,
    });
    proof.expect(
      "the item waits in the merge queue",
      (await proof.itemState()) === "merge_queue",
      await proof.itemState(),
    );
    queue.merge(1, "queue-merge-sha");
    const merged = await proof.waitFor(
      "the item is merged",
      async () => ["merged", "failed", "manual"].includes((await proof.itemState()) ?? ""),
      120_000,
    );
    const squashes = proof.github.calls.filter(
      (call) => call.method === "PUT" && call.path.endsWith("/merge"),
    );
    proof.expect(
      "the item merged through the queue without a squash",
      merged &&
        (await proof.itemState()) === "merged" &&
        squashes.length === 0 &&
        queue.enqueued.length === 1,
      { state: await proof.itemState(), squashes, enqueued: queue.enqueued, calls: queue.calls },
    );
  },
} satisfies Proof;
