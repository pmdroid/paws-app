import mainMoved from "./main-moved";
import type { Proof } from "./harness";

const ALLOWED_THOUGHTS =
  /^(Received your update\.|Starting on your request|@|.* commented on pull request|Main moved and)/;

export default {
  covers: ["src/loop/activity-policy.ts", "src/loop/session-progress.ts", "src/loop/dispatch.ts"],
  summary:
    "After the pull request opens, a person's follow-up and a CI fix round post no agent progress to the Linear session, and the title moves only between phases.",
  ciPending: true,
  agent: (input) => [
    { type: "post_update", text: `Counting the shelves (${input.purpose}).` },
    ...mainMoved.agent(input),
  ],
  async run(proof) {
    await proof.delegate();
    const opened = await proof.waitFor(
      "the pull request response is posted",
      async () =>
        (await proof.itemState()) === "merge_queue" &&
        proof.linear.progress.some((update) => update.kind === "response"),
    );
    proof.expect("the pull request opens", opened, await proof.itemState());
    const prResponse = proof.linear.progress.findIndex((update) => update.kind === "response");
    const titlesBefore = proof.linear.sessionUpdates.length;

    await proof.answerInLinear("Also keep the shelf count in the README.");
    const followedUp = await proof.waitFor(
      "the follow-up turn publishes again",
      async () => proof.launches.length >= 2 && (await proof.itemState()) === "merge_queue",
      120_000,
    );
    proof.expect("the follow-up runs one turn", followedUp, proof.launches.length);

    proof.github.ci.failed = true;
    proof.github.ci.pending = false;
    const fixing = await proof.waitFor("one CI fix turn starts", () => proof.launches.length >= 3);
    proof.expect("CI sends the item back once", fixing, proof.launches.length);
    proof.github.ci.failed = false;
    const merged = await proof.waitFor(
      "the fixed pull request merges",
      async () => (await proof.itemState()) === "merged",
      120_000,
    );
    proof.expect("the item merges", merged, await proof.itemState());

    const after = proof.linear.progress.slice(prResponse + 1);
    const leaked = after.filter(
      (update) =>
        update.kind === "action" ||
        (update.kind === "thought" && !ALLOWED_THOUGHTS.test(update.body)),
    );
    proof.expect("no agent progress after the pull request response", leaked.length === 0, leaked);
    const titles = proof.linear.sessionUpdates
      .slice(titlesBefore)
      .flatMap((update) => (update.summary ? [update.summary] : []));
    proof.expect(
      "after the pull request the title names only phases",
      titles.every((title) =>
        /: (waiting to merge|fixing CI|fixing review comments|fixing merge conflicts|merged)$/.test(
          title,
        ),
      ) && titles.at(-1)?.endsWith(": merged") === true,
      titles,
    );
  },
} satisfies Proof;
