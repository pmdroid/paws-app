import fixRound from "./closeout-fix-round";
import { type Proof } from "./harness";

export default {
  ...fixRound,
  covers: ["src/loop/orchestrator.ts", "src/loop/publication.ts", "src/github/push.ts"],
  summary:
    "With mirrors off, the first candidate is pushed before verification and fails its check. The fix turn amends that commit; guarded publication replaces the branch with a force-with-lease push, and the rewritten candidate passes verification and merges without creating repos.",
  config: "[github_access]\nmirrors = false\n",
  forbidRepos: true,
  agent(input) {
    const steps = fixRound.agent(input);
    if (input.purpose === "fix")
      for (const step of steps)
        if (step.type === "terminal" && step.args?.includes("commit"))
          step.args = [...step.args, "--amend"];
    return steps;
  },
  async run(proof) {
    await proof.delegate();
    const settled = await proof.waitFor(
      "the rewritten candidate merges",
      async () =>
        ["merged", "failed", "manual", "cancelled"].includes((await proof.itemState()) ?? ""),
      120_000,
    );
    const transitions = await proof.transitions();
    const turns = proof.launches.filter((launch) => ["implement", "fix"].includes(launch.purpose));
    proof.expect(
      "the failed first candidate causes a fix turn",
      turns.length === 2 &&
        turns[1]?.purpose === "fix" &&
        transitions.some((row) => row.from === "verifying" && row.event === "restart"),
      transitions,
    );
    const log = await proof.originMainLog();
    proof.expect(
      "main contains the amended candidate without the replaced commit",
      log.includes("Count shelf b") && !log.includes("Count widgets per shelf"),
      log,
    );
    proof.expect(
      "the rewritten candidate passes GitHub-backed verification and merges",
      settled && (await proof.itemState()) === "merged",
      await proof.itemState(),
    );
  },
} satisfies Proof;
