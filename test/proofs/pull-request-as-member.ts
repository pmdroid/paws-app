import { join } from "node:path";
import type { Proof, ProofContext } from "./harness";

export const covers = ["src/github/pulls.ts", "src/loop/orchestrator.ts", "src/workspace/**"];

export const implement: Proof["agent"] = (input) =>
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
    : [];

export async function openedPullCalls(proof: ProofContext) {
  await proof.delegate();
  await proof.waitFor(
    "the item is merged",
    async () =>
      ["merged", "failed", "manual", "cancelled"].includes((await proof.itemState()) ?? ""),
    120_000,
  );
  await proof.waitFor("queued Linear activity is delivered", () => false, 1_000);
  const creates = proof.github.calls.filter(
    (call) => call.method === "POST" && call.path.endsWith("/pulls"),
  );
  return { creates, rest: proof.github.calls.filter((call) => !creates.includes(call)) };
}

export default {
  covers,
  summary:
    'A delegator who turned on "Open pull requests as me" gets the pull request opened with their token; every other GitHub call uses the App token.',
  member: { login: "acme-dev", token: "ghu_proofmember" },
  agent: implement,
  async run(proof) {
    const { creates, rest } = await openedPullCalls(proof);
    proof.expect(
      "the pull request was created once, with the member's token",
      creates.length === 1 &&
        creates[0]!.token === "ghu_proofmember" &&
        creates[0]!.outcome === "201",
      creates,
    );
    proof.expect(
      "every other GitHub call, including the merge, used the App token",
      rest.length > 0 &&
        rest.every((call) => call.token === "proof-fake-token") &&
        rest.some((call) => call.method === "PUT" && call.path.endsWith("/merge")),
      rest,
    );
    proof.expect(
      "the item merged",
      (await proof.itemState()) === "merged",
      await proof.itemState(),
    );
  },
} satisfies Proof;
