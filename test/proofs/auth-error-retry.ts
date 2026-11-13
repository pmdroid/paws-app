import { join } from "node:path";
import type { Proof } from "./harness";

let implementTurns = 0;

export default {
  covers: ["src/loop/orchestrator.ts", "src/runner-health/**"],
  summary:
    "An agent turn that ends on a sign-in error while the runner's sign-in check passes is retried, and the item reaches Closeout instead of failing.",
  runnerSignIn: { runner: "goldbox", signedIn: true },
  agent: (input) => {
    if (input.purpose !== "implement") return [];
    implementTurns += 1;
    if (implementTurns === 1) return [{ type: "auth_error" }];
    return [
      { type: "fs_write", path: join(input.worktree, "widgets.txt"), content: "12\n" },
      { type: "terminal", command: "git", args: ["add", "widgets.txt"], cwd: input.worktree },
      {
        type: "terminal",
        command: "git",
        args: ["commit", "-q", "-m", "Count widgets per shelf"],
        cwd: input.worktree,
      },
    ];
  },
  async run(proof) {
    await proof.delegate();
    await proof.waitFor(
      "the item passes Closeout or stops",
      async () =>
        ["merge_queue", "merged", "failed", "manual", "cancelled"].includes(
          (await proof.itemState()) ?? "",
        ),
      120_000,
    );
    const turns = proof.launches.filter((launch) => launch.purpose === "implement");
    proof.expect("the implement turn ran again after the sign-in error", turns.length === 2, {
      purposes: proof.launches.map((launch) => launch.purpose),
    });
    const state = await proof.itemState();
    proof.expect("the item did not fail", state !== "failed", state);
    const transitions = await proof.transitions();
    proof.expect(
      "no run_failed was applied",
      !transitions.some((row) => row.event === "run_failed"),
      transitions,
    );
  },
} satisfies Proof;
