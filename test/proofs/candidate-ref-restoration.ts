import type { Proof } from "./harness";

export default {
  covers: [
    "src/loop/orchestrator.ts",
    "src/runner-backend/candidate.ts",
    "test/candidate-head-replica.test.ts",
    "test/local/runner-orchestration.ts",
    "test/runner-orchestration*.ts",
  ],
  summary:
    "After approval on another instance, missing and stale mirrored candidate refs are restored from the recorded SHA before verification and publication, and the recorded candidate merges. A rewritten work branch asks how to continue and restores the chosen tree.",
  agent: () => [],
  async run(proof) {
    const child = Bun.spawn(
      [
        "bun",
        "test",
        "--parallel=12",
        "test/runner-orchestration-rebase-unchecked.test.ts",
        "test/runner-orchestration-reverify.test.ts",
        "test/runner-orchestration-rebase.test.ts",
        "test/runner-orchestration.test.ts",
        "test/runner-orchestration-recovery.test.ts",
        "test/runner-orchestration-rebase-failing.test.ts",
        "test/candidate-head-replica.test.ts",
        "test/runner-orchestration-rebase-missing-result.test.ts",
        "test/runner-orchestration-rebase-rate-limited.test.ts",
        "test/runner-orchestration-rebase-missing-twice.test.ts",
        "test/merge-dependency-yield.test.ts",
        "test/rewritten-branch.test.ts",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    proof.expect("candidate restoration and replica merge scenarios pass", status === 0, {
      stdout,
      stderr,
    });
  },
} satisfies Proof;
