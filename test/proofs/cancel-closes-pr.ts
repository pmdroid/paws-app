import { join } from "node:path";
import type { Proof } from "./harness";

export default {
  covers: [
    "src/db/commands.ts",
    "src/github/stopped.ts",
    "src/linear/administration.ts",
    "src/loop/linear-administration.ts",
    "src/loop/orchestrator.ts",
  ],
  summary:
    "Moving the issue to Canceled in Linear while its pull request waits in the merge queue closes the pull request with a comment and ends the session.",
  ciPending: true,
  agent: (input) => [
    { type: "fs_write", path: join(input.worktree, "widgets.txt"), content: "12\n" },
  ],
  async run(proof) {
    await proof.delegate();
    const queued = await proof.waitFor(
      "the pull request is open and the item waits in the merge queue",
      async () =>
        (await proof.itemState()) === "merge_queue" &&
        proof.github.calls.some((call) => call.method === "POST" && call.path.endsWith("/pulls")),
    );
    proof.expect(
      "the item reaches the merge queue with an open PR",
      queued,
      await proof.itemState(),
    );
    await proof.cancelInLinear();
    const closed = await proof.waitFor("the pull request is closed", () =>
      proof.github.closed.has(1),
    );
    await proof.waitFor("queued Linear activity is delivered", () => false, 1_000);
    proof.expect(
      "the item is cancelled",
      (await proof.itemState()) === "cancelled",
      await proof.itemState(),
    );
    const comment = proof.github.calls.find(
      (call) => call.method === "POST" && call.path.endsWith("/issues/1/comments"),
    );
    proof.expect("Paws comments on the pull request", comment?.outcome === "201", comment);
    proof.expect("the pull request is closed", closed, [...proof.github.closed]);
    const response = proof.linear.progress.at(-1);
    proof.expect(
      "the session ends with a response that says the PR was closed",
      response?.kind === "response" && response.body.includes("PR #1 was closed"),
      response,
    );
    proof.expect(
      "nothing merges",
      !proof.github.calls.some((call) => call.method === "PUT"),
      proof.github.calls.filter((call) => call.method === "PUT"),
    );
  },
} satisfies Proof;
