import { join } from "node:path";
import { type LaunchInput, type Proof } from "./harness";

const QUESTION = "Count the empty shelves too?";
const ANSWER = "Yes, count the empty shelves as 0.";
const COMMIT = "Count widgets per shelf, empty shelves as 0";

const answered = (launch: LaunchInput) =>
  launch.purpose === "implement" && launch.prompt.includes(ANSWER);

export default {
  covers: [
    "src/acp/ask-team.ts",
    "src/acp/ask-team-mcp.ts",
    "src/core/handoff.ts",
    "src/loop/operations.ts",
    "src/loop/orchestrator.ts",
    "src/loop/question-effects.ts",
    "src/questions/**",
    "src/linear/**",
  ],
  summary:
    "The implement turn asks a blocking question; the item waits for input with its slot freed, the answer in Linear resumes the run with the answer in its prompt, and the item merges.",
  agent: (input) =>
    input.purpose !== "implement"
      ? []
      : !answered(input)
        ? [{ type: "ask_team", question: QUESTION }]
        : [
            { type: "fs_write", path: join(input.worktree, "widgets.txt"), content: "12\n0\n" },
            { type: "terminal", command: "git", args: ["add", "widgets.txt"], cwd: input.worktree },
            {
              type: "terminal",
              command: "git",
              args: [
                "-c",
                "user.name=Acme Agent",
                "-c",
                "user.email=agent@acme.test",
                "commit",
                "-q",
                "-m",
                COMMIT,
              ],
              cwd: input.worktree,
            },
          ],
  async run(proof) {
    await proof.delegate();
    const asked = await proof.waitFor(
      "the question is asked and the item waits for input",
      () => proof.itemState() === "awaiting_input" && proof.heldWork().activeRuns === 0,
    );
    proof.expect(
      "the implement turn asks the question in Linear",
      proof.linear.questions.some((question) => question.body.includes(QUESTION)),
      proof.linear.questions,
    );
    const held = proof.heldWork();
    proof.expect(
      "the item goes to awaiting_input and its slot is freed",
      asked && held.activeRuns === 0 && held.reservations === 0 && held.runningJobs === 0,
      { state: proof.itemState(), held },
    );
    const askingRun = proof.itemRunId();

    await proof.answerInLinear(ANSWER);
    const merged = await proof.waitFor(
      "the item is merged",
      () => ["merged", "failed", "manual", "cancelled"].includes(proof.itemState() ?? ""),
      120_000,
    );
    await proof.waitFor("queued Linear activity is delivered", () => false, 1_000);
    const turns = proof.launches.filter((launch) => launch.purpose === "implement");
    const resumed = turns.filter(answered);
    proof.expect(
      "the answer resumes the same run, and the resumed turn's prompt carries the question and the answer",
      turns.length === 2 &&
        resumed.length === 1 &&
        resumed[0]!.prompt.includes(QUESTION) &&
        askingRun !== null &&
        proof.itemRunId() === askingRun &&
        proof.transitions().some((row) => row.from === "awaiting_input" && row.event === "restart"),
      {
        purposes: proof.launches.map((launch) => launch.purpose),
        resumedWithAnswer: resumed.length,
        runs: { asking: askingRun, final: proof.itemRunId() },
      },
    );
    const log = await proof.originMainLog();
    proof.expect("the resumed turn's commit is merged into origin main", log.includes(COMMIT), log);
    proof.expect(
      "the item is merged, not failed",
      merged && proof.itemState() === "merged",
      proof.itemState(),
    );
  },
} satisfies Proof;
