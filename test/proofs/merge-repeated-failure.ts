import { join } from "node:path";
import { type Proof } from "./harness";

const FAILURE = "Git process cleanup could not be verified";
let failing = true;
let failures = 0;

export default {
  covers: [
    "src/loop/merge-jobs.ts",
    "src/github/controlled-git.ts",
    "src/process/owned-process.ts",
  ],
  summary:
    "A merge attempt fails three times in a row with the same git error; Paws asks once with the error, and Retry merge merges.",
  noCi: true,
  gitFault: (args, state) => {
    if (
      !failing ||
      state !== "merge_queue" ||
      args.join(" ") !== "rev-parse refs/paws/upstream-main"
    )
      return null;
    failures += 1;
    return FAILURE;
  },
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
    await proof.delegate();
    await proof.waitFor(
      "the item asks after repeated merge failures",
      async () => (await proof.itemState()) === "awaiting_input",
      120_000,
    );
    const questions = proof.linear.questions;
    proof.expect(
      "one question names the error and offers Retry merge, after three failures",
      questions.length === 1 &&
        questions[0]!.body.includes(`3 times in a row with the same error: ${FAILURE}`) &&
        JSON.stringify(questions[0]!.options) === JSON.stringify(["Retry merge"]) &&
        failures === 3,
      { questions, failures },
    );
    failing = false;
    await proof.answerInLinear("Retry merge");
    proof.expect(
      "age the Paws publication record",
      await proof.waitFor("publication is recorded", () => proof.ageCandidate()),
    );
    const merged = await proof.waitFor(
      "the item is merged",
      async () => ["merged", "failed", "manual"].includes((await proof.itemState()) ?? ""),
      120_000,
    );
    proof.expect(
      "Retry merge merges without another Closeout run",
      merged &&
        (await proof.itemState()) === "merged" &&
        (await proof.transitions()).filter((row) => row.to === "verifying").length === 1,
      await proof.transitions(),
    );
  },
} satisfies Proof;
