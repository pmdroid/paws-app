import { join } from "node:path";
import { acceptGitHubDelivery } from "../../src/loop";
import { formatToolchainQuestion } from "../../src/runner-protocol";
import { ACME, type LaunchInput, type Proof } from "./harness";

const QUESTION = formatToolchainQuestion({
  descriptions: ["Cargo.toml needs cargo, which isn't installed on the runner."],
  file: "mise.toml",
  entries: [{ name: "rust", version: "stable" }],
});
const COMMIT = "Count widgets per shelf";
const resumed = (launch: LaunchInput) =>
  launch.purpose === "implement" && launch.prompt.includes(QUESTION);

export default {
  covers: ["src/loop/toolchain-merged.ts", "src/loop/merge-jobs.ts"],
  summary:
    "The implement turn asks a toolchain question; a person merges the paws/toolchain pull request on GitHub, and the merge event answers retry for the item, which resumes and reaches the merge queue without a Linear answer.",
  agent: (input) =>
    input.purpose !== "implement"
      ? []
      : !resumed(input)
        ? [{ type: "ask_team", question: QUESTION }]
        : [
            { type: "fs_write", path: join(input.worktree, "widgets.txt"), content: "12\n" },
            { type: "terminal", command: "git", args: ["add", "widgets.txt"], cwd: input.worktree },
            {
              type: "terminal",
              command: "git",
              args: ["-c", "user.name=A", "-c", "user.email=a@acme.test", "commit", "-qm", COMMIT],
              cwd: input.worktree,
            },
          ],
  async run(proof) {
    await proof.delegate();
    await proof.waitFor(
      "the toolchain question is asked and the item waits for input",
      async () => (await proof.itemState()) === "awaiting_input",
    );
    const repository = { full_name: ACME.repository };
    const closed = (merged: boolean) => ({
      action: "closed",
      repository: { ...repository, default_branch: "main" },
      pull_request: {
        merged,
        merged_at: merged ? new Date().toISOString() : null,
        head: { ref: "paws/toolchain", sha: "tools", repo: repository },
        base: { ref: "main", repo: repository },
      },
    });
    const deliver = (deliveryId: string, body: unknown) =>
      acceptGitHubDelivery(
        proof.store,
        { deliveryId, event: "pull_request", payload: JSON.stringify(body) },
        Date.now(),
      );
    await deliver("toolchain-closed", closed(false));
    proof.expect(
      "a toolchain pull request closed without merging leaves the item waiting",
      (await proof.itemState()) === "awaiting_input",
      await proof.itemState(),
    );
    await deliver("toolchain-merged", closed(true));
    await deliver("toolchain-merged-again", closed(true));
    const done = await proof.waitFor(
      "the resumed item reaches the merge queue",
      async () =>
        ["merge_queue", "merged", "failed", "manual", "cancelled"].includes(
          (await proof.itemState()) ?? "",
        ),
      120_000,
    );
    const turns = proof.launches.filter((launch) => launch.purpose === "implement");
    proof.expect(
      "the merge event resumes the item once, with retry as the answer",
      turns.length === 2 &&
        turns.filter(resumed).length === 1 &&
        (await proof.transitions()).filter(
          (row) => row.from === "awaiting_input" && row.event === "restart",
        ).length === 1,
      { purposes: proof.launches.map((launch) => launch.purpose) },
    );
    proof.expect(
      "the resumed turn's work passes Closeout and enters the merge queue",
      done && (await proof.itemState()) === "merge_queue",
      await proof.itemState(),
    );
  },
} satisfies Proof;
