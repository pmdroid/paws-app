import type { Proof } from "./harness";
import { covers, implement, openedPullCalls } from "./pull-request-as-member";

export default {
  covers,
  summary:
    "When GitHub refuses the delegator's token, Paws opens the pull request as the App and says so in one line in the Linear session.",
  member: { login: "acme-dev", token: "ghu_proofmember", refused: 403 },
  agent: implement,
  async run(proof) {
    const { creates, rest } = await openedPullCalls(proof);
    proof.expect(
      "the member's token was refused, and the App opened the pull request",
      creates.length === 2 &&
        creates[0]!.token === "ghu_proofmember" &&
        creates[0]!.outcome === "403" &&
        creates[1]!.token === "proof-fake-token" &&
        creates[1]!.outcome === "201",
      creates,
    );
    proof.expect(
      "no other call used the member's token",
      rest.every((call) => call.token === "proof-fake-token"),
      rest,
    );
    const lines = proof.linear.progress.filter((update) =>
      update.body.startsWith("Opened as Paws:"),
    );
    proof.expect(
      "the Linear session got the one fallback line",
      lines.length === 1 &&
        lines[0]!.body === "Opened as Paws: GitHub refused acme-dev's token (403).",
      lines,
    );
    proof.expect(
      "the item merged",
      (await proof.itemState()) === "merged",
      await proof.itemState(),
    );
  },
} satisfies Proof;
