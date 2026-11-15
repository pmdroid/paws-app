import type { Proof } from "./harness";

export default {
  covers: [
    "src/loop/orchestrator.ts",
    "test/candidate-head-replica.test.ts",
    "test/local/runner-orchestration.ts",
  ],
  summary:
    "After approval on another instance, missing and stale mirrored candidate refs are restored from the recorded SHA before verification and publication, and the recorded candidate merges.",
  agent: () => [],
  async run(proof) {
    const child = Bun.spawn(
      [
        "bun",
        "test",
        "test/candidate-head-replica.test.ts",
        "test/runner-orchestration.test.ts",
        "test/merge-dependency-yield.test.ts",
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
