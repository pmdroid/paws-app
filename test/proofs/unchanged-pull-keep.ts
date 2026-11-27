import close from "./unchanged-pull-close";
import type { Proof } from "./harness";

export default {
  covers: ["src/loop/nothing-to-publish.ts", "src/loop/question-effects.ts"],
  summary:
    "A CI fix turn on an open pull request ends with the same head and says no change is needed; keeping the pull request sends the head through Closeout and the merge queue as before.",
  ciPending: true,
  agent: close.agent,
  async run(proof) {
    proof.github.ci.failed = true;
    await proof.delegate();
    await proof.waitFor(
      "the pull request is open and waits on CI",
      async () => (await proof.itemState()) === "merge_queue" && proof.github.opened.length === 1,
    );
    proof.github.ci.pending = false;
    const asked = await proof.waitFor(
      "the fix turn ends unchanged and Paws asks",
      async () => (await proof.itemState()) === "awaiting_input" && proof.launches.length === 2,
      120_000,
    );
    proof.expect("Paws asks before merging", asked, await proof.transitions());
    proof.github.ci.failed = false;
    await proof.answerInLinear("Keep the pull request and merge");
    const merged = await proof.waitFor(
      "the kept pull request merges",
      async () => (await proof.itemState()) === "merged",
      120_000,
    );
    const transitions = await proof.transitions();
    proof.expect(
      "the answer reverifies the same head and it merges without another turn or a close",
      merged &&
        transitions.some((row) => row.event === "reverify_requested") &&
        transitions.filter((row) => row.event === "closeout_accepted").length === 2 &&
        proof.launches.length === 2 &&
        proof.github.merged.has(1),
      transitions,
    );
  },
} satisfies Proof;
