import type { Proof } from "./harness";

export default {
  covers: ["src/loop/orchestrator.ts", "src/closeout-spec/session.ts"],
  summary:
    "A checks run that leaves a required command unstarted or loses its policy retries once, then asks a person; a failed check no longer stops later checks from running.",
  agent: () => [],
  async run(proof) {
    const child = Bun.spawn(
      [
        "bun",
        "test",
        "test/closeout-rules-first.test.ts",
        "test/closeout-skipped-check.test.ts",
        "test/closeout-timeout-policy.test.ts",
        "--test-name-pattern",
        "incomplete checks retry once|later command after an earlier one failed|withheld behind a failed check",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    proof.expect(
      "incomplete checks retry once before asking, and later checks run after a failure",
      status === 0,
      { stdout, stderr },
    );
  },
} satisfies Proof;
