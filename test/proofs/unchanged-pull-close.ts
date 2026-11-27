import { join } from "node:path";
import { ACME, type Proof } from "./harness";

const turns = new Map<string, number>();

export default {
  covers: ["src/loop/nothing-to-publish.ts", "src/github/stopped.ts"],
  summary:
    "A CI fix turn on an open pull request ends with the same head and says no change is needed; Paws asks instead of merging, and closing the pull request completes the item and deletes the branch.",
  ciPending: true,
  agent: (input) =>
    input.purpose !== "implement"
      ? []
      : turns.set(input.worktree, (turns.get(input.worktree) ?? 0) + 1).get(input.worktree) === 1
        ? [{ type: "fs_write", path: join(input.worktree, "widgets.txt"), content: "12\n" }]
        : [
            {
              type: "update",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "This task needs no code change; PR #1 is open." },
              },
            },
          ],
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
    const question = proof.linear.questions.at(-1);
    proof.expect(
      "the question names the open pull request and offers close or keep",
      asked &&
        question?.body.includes("PR #1 is still open") === true &&
        JSON.stringify(question.options) ===
          JSON.stringify([
            "Close the pull request and complete",
            "Keep the pull request and merge",
          ]),
      question,
    );
    proof.expect(
      "Closeout did not accept the old head again",
      (await proof.transitions()).filter((row) => row.event === "closeout_accepted").length === 1,
      await proof.transitions(),
    );
    const branch = proof.github.opened[0]!.head;
    await proof.answerInLinear("Close the pull request and complete");
    const closed = await proof.waitFor("the pull request is closed", () =>
      proof.github.closed.has(1),
    );
    await proof.waitFor("queued Linear activity is delivered", () => false, 1_000);
    proof.expect(
      "the item completed with answer_completed and nothing merged",
      closed &&
        (await proof.itemState()) === "completed" &&
        (await proof.transitions()).at(-1)?.event === "answer_completed" &&
        proof.github.merged.size === 0,
      await proof.transitions(),
    );
    const comment = proof.github.comments.get(1)?.at(-1)?.body ?? "";
    proof.expect("the closing comment names the issue", comment.includes(ACME.identifier), comment);
    proof.expect(
      "the Paws branch is deleted with the App token",
      proof.github.calls.some(
        (call) => call.method === "DELETE" && call.path.endsWith(`/git/refs/heads/${branch}`),
      ),
      proof.github.calls.filter((call) => call.method === "DELETE"),
    );
    proof.expect(
      "Linear got a final response and the issue moved to completed",
      proof.linear.progress.at(-1)?.body.startsWith("Completed without merging") === true &&
        proof.linear.issueStateTypes.get(ACME.issueId) === "completed",
      proof.linear.progress.at(-1),
    );
  },
} satisfies Proof;
