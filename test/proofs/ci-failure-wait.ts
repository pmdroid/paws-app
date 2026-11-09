import mainMoved from "./main-moved";
import type { Proof } from "./harness";

export default {
  covers: ["src/merge/**", "src/github/readiness.ts", "src/db/pull-ci.ts"],
  summary: "A failed check waits for the running check before one CI fix turn.",
  ciPending: true,
  agent: mainMoved.agent,
  async run(proof) {
    proof.github.ci.failed = true;
    await proof.delegate();
    const waiting = await proof.waitFor(
      "the lane reads failed and running CI",
      () =>
        proof.itemState() === "merge_queue" &&
        proof.github.calls.filter((c) => c.path === "/graphql").length >= 2,
    );
    proof.expect(
      "CI waits without a fix turn",
      waiting && proof.launches.length === 1,
      proof.launches.map((l) => l.purpose),
    );
    proof.github.ci.pending = false;
    const fixed = await proof.waitFor("one CI fix turn starts", () => proof.launches.length >= 2);
    proof.expect(
      "the completed checks trigger one fix turn",
      fixed && proof.launches.length === 2,
      proof.launches.map((l) => l.purpose),
    );
    proof.github.ci.failed = false;
    const merged = await proof.waitFor(
      "the fixed pull merges",
      () => proof.itemState() === "merged",
      120_000,
    );
    proof.expect(
      "the item merges after exactly one fix",
      merged && proof.launches.length === 2,
      proof.itemState(),
    );
  },
} satisfies Proof;
