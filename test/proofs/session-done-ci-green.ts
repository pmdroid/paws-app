import { saveSessionDone } from "../../src/db";
import mainMoved from "./main-moved";
import type { Proof } from "./harness";

export default {
  covers: ["src/loop/session-done.ts", "src/db/session-done.ts", "src/loop/activity-policy.ts"],
  summary:
    "With the session set to finish on green CI, the pull request opens as a thought, and the final response comes once CI is green on the head, before the merged line.",
  ciPending: true,
  agent: mainMoved.agent,
  async run(proof) {
    await saveSessionDone(proof.store, { sessionDone: "ci_green", sessionQuietMinutes: 10 });
    await proof.delegate();
    const opened = await proof.waitFor(
      "the pull request opens",
      async () =>
        (await proof.itemState()) === "merge_queue" &&
        proof.linear.progress.some(
          (update) => update.kind === "thought" && update.body.includes("Opened "),
        ),
    );
    proof.expect("the pull request text is posted as a thought", opened, proof.linear.progress);
    await proof.waitFor(
      "the lane reads pending CI twice",
      () => proof.github.calls.filter((call) => call.path === "/graphql").length >= 2,
    );
    proof.expect(
      "no response while CI is pending",
      !proof.linear.progress.some((update) => update.kind === "response"),
      proof.linear.progress.filter((update) => update.kind === "response"),
    );

    proof.github.ci.pending = false;
    const merged = await proof.waitFor(
      "the pull request merges",
      async () => (await proof.itemState()) === "merged",
      120_000,
    );
    proof.expect("the item merges", merged, await proof.itemState());
    const responses = proof.linear.progress
      .filter((update) => update.kind === "response")
      .map((update) => update.body);
    proof.expect(
      "the ready response says CI is green and comes before the merged line",
      responses.length === 2 &&
        responses[0]!.includes("Opened ") &&
        responses[0]!.endsWith("CI is green.") &&
        responses[1]!.startsWith("Merged #"),
      responses,
    );
    const openedAt = proof.linear.progress.findIndex((update) => update.body.includes("Opened "));
    const leaked = proof.linear.progress
      .slice(openedAt + 1)
      .filter((update) => update.kind === "action" || update.kind === "thought");
    proof.expect("no progress after the pull request opens", leaked.length === 0, leaked);
  },
} satisfies Proof;
