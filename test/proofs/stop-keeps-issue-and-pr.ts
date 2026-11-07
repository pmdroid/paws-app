import { join } from "node:path";
import { ACME, type Proof } from "./harness";

export default {
  covers: [
    "src/db/commands.ts",
    "src/db/stop-response.ts",
    "src/execution-controls/**",
    "src/linear/administration.ts",
    "src/loop/orchestrator.ts",
  ],
  summary:
    "A Linear stop while the pull request waits in the merge queue pauses the item and leaves the issue status and the pull request as they were.",
  ciPending: true,
  agent: (input) => [
    { type: "fs_write", path: join(input.worktree, "widgets.txt"), content: "12\n" },
  ],
  async run(proof) {
    await proof.delegate();
    const queued = await proof.waitFor(
      "the pull request is open and the item waits in the merge queue",
      () => proof.itemState() === "merge_queue" && proof.github.calls.some(isOpenPull),
    );
    proof.expect("the item reaches the merge queue with an open PR", queued, proof.itemState());
    const statusesBefore = proof.linear.statuses.length;
    await proof.stopInLinear();
    await proof.waitFor("the stop is applied", () => proof.itemState() === "paused", 15_000);
    await proof.waitFor("queued Linear activity is delivered", () => false, 1_000);
    proof.expect("the stop pauses the item", proof.itemState() === "paused", proof.itemState());
    const changes = proof.linear.statuses.slice(statusesBefore);
    proof.expect(
      "the Linear issue status stays as it was",
      changes.length === 0 && proof.linear.issueStateTypes.get(ACME.issueId) !== "canceled",
      changes,
    );
    const pullWrites = proof.github.calls.filter(
      (call) => call.method === "PATCH" || call.path.endsWith("/comments"),
    );
    proof.expect(
      "the pull request stays open with no close or comment",
      pullWrites.length === 0 && proof.github.closed.size === 0,
      pullWrites,
    );
    proof.expect(
      "nothing merges",
      !proof.github.calls.some((call) => call.method === "PUT"),
      proof.github.calls.filter((call) => call.method === "PUT"),
    );
  },
} satisfies Proof;

function isOpenPull(call: { method: string; path: string; outcome: string }) {
  return call.method === "POST" && call.path.endsWith("/pulls") && call.outcome === "201";
}
