import { join } from "node:path";
import type { Proof } from "./harness";

let implementTurns = 0;

export default {
  covers: ["src/loop/unchanging-error.ts", "src/loop/question-effects.ts"],
  summary:
    "An agent turn ends on a sign-in error and the runner's sign-in check fails too; Paws asks once instead of retrying or failing, and Retry runs the turn again.",
  runnerSignIn: { runner: "goldbox", signedIn: false },
  agent: (input) => {
    if (input.purpose !== "implement") return [];
    implementTurns += 1;
    if (implementTurns === 1) return [{ type: "auth_error" }];
    return [
      { type: "fs_write", path: join(input.worktree, "widgets.txt"), content: "12\n" },
      { type: "terminal", command: "git", args: ["add", "widgets.txt"], cwd: input.worktree },
      {
        type: "terminal",
        command: "git",
        args: ["commit", "-q", "-m", "Count widgets per shelf"],
        cwd: input.worktree,
      },
    ];
  },
  async run(proof) {
    await proof.delegate();
    const asked = await proof.waitFor(
      "Paws asks about the sign-in",
      async () => (await proof.itemState()) === "awaiting_input",
      120_000,
    );
    const question = proof.linear.questions.at(-1);
    proof.expect(
      "the question names the expired sign-in and offers Retry and Stop",
      asked &&
        question !== undefined &&
        question.body.includes("reported its sign-in is missing or expired") &&
        JSON.stringify(question.options) === JSON.stringify(["Retry", "Stop"]),
      question,
    );
    await proof.waitFor("no retry follows", () => false, 3_000);
    const turns = () => proof.launches.filter((launch) => launch.purpose === "implement");
    proof.expect("the turn ran once before the question", turns().length === 1, turns().length);
    await proof.answerInLinear("Retry");
    await proof.waitFor(
      "the item passes Closeout or stops",
      async () =>
        ["merge_queue", "merged", "failed", "manual", "cancelled"].includes(
          (await proof.itemState()) ?? "",
        ),
      120_000,
    );
    proof.expect("Retry ran the turn again", turns().length === 2, turns().length);
    const transitions = await proof.transitions();
    proof.expect(
      "no run_failed was applied",
      !transitions.some((row) => row.event === "run_failed"),
      transitions,
    );
  },
} satisfies Proof;
