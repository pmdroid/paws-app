import mainMoved from "./main-moved";
import type { Proof } from "./harness";

let turns = 0;

export default {
  covers: ["src/loop/orchestrator.ts", "src/runner-worker/**"],
  summary:
    "A follow-up during an active turn resumes the item and reaches the merge queue without failing.",
  ciPending: true,
  agent(input) {
    if (input.purpose === "implement" && turns++ === 0) return [{ type: "hang" }];
    return mainMoved.agent(input);
  },
  async run(proof) {
    await proof.delegate();
    const delivery = (async () => {
      while (proof.launches.length === 0) await Bun.sleep(20);
      proof.expect("the item starts running", (await proof.itemState()) === "running");
      await proof.delegate();
      await proof.answerInLinear("   ");
      proof.expect(
        "session-start replays leave the first turn running",
        proof.launches.length === 1 && (await proof.itemState()) === "running",
      );
      await proof.answerInLinear("Also count the widgets per shelf.");
    })();
    const continued = await proof.waitFor(
      "the follow-up turn reaches the merge queue",
      async () => (await proof.itemState()) === "merge_queue",
      120_000,
    );
    await delivery;
    proof.expect(
      "the follow-up runs",
      continued && proof.launches.length >= 2,
      proof.launches.length,
    );
    proof.expect(
      "the next turn receives the follow-up",
      proof.launches
        .slice(1)
        .some((launch) => launch.prompt.includes("Also count the widgets per shelf.")),
    );
    proof.expect(
      "no turn fails the item",
      !(await proof.transitions()).some((row) => row.to === "failed"),
      await proof.transitions(),
    );
  },
} satisfies Proof;
