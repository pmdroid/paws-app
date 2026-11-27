import { ACME, type Proof } from "./harness";

const part = (title: string) => ({
  title,
  problem: `${title} is half of a change too big for one pull request.`,
  evidence: "The last review rounds ran at 900 changed lines.",
  change: `Only ${title.toLowerCase()}.`,
  acceptance: ["bun run check passes"],
  leaveAlone: "The other half.",
});

export default {
  covers: [
    "src/loop/issue-split.ts",
    "src/loop/dispatch.ts",
    "src/loop/question-effects.ts",
    "src/linear/sub-issues.ts",
    "src/db/issue-splits.ts",
  ],
  summary:
    "The agent proposes splitting the issue in two; after a person approves in Linear, Paws files both as sub-issues that block the parent, delegates and starts them, and the parent stops its own work.",
  agent: (input) =>
    input.purpose === "implement"
      ? [
          {
            type: "host_tool",
            name: "propose_split",
            arguments: {
              sameFiles: true,
              subIssues: [part("Count widgets per shelf"), part("Count widgets per aisle")],
            },
          },
        ]
      : [],
  async run(proof) {
    await proof.delegate();
    await proof.waitFor(
      "the split is asked in Linear",
      async () =>
        (await proof.itemState()) === "awaiting_input" &&
        proof.linear.questions.some((question) => question.body.includes("proposes splitting")),
    );
    await proof.answerInLinear("Split into 2 sub-issues");
    const sessions = proof.linear.issueSessions;
    await proof.waitFor("both sub-issues are started", async () => sessions.length >= 2, 150_000);
    const filed = proof.linear.subIssues.get(ACME.issueId) ?? [];
    const request = proof.linear.subIssueRequests.at(-1);
    proof.expect(
      "both sub-issues are filed under the parent, block it, chain, and are delegated",
      filed.length === 2 &&
        filed[1]!.blockedBy[0] === filed[0]!.id &&
        request?.blocksParent === true &&
        request.delegate === true,
      { filed, request },
    );
    const state = await proof.itemState();
    proof.expect("the parent stops its own work", state === "completed", { state });
  },
} satisfies Proof;
