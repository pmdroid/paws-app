import type { Proof } from "./harness";

export default {
  covers: ["src/loop/orchestrator.ts", "src/db/runner-lease.ts"],
  summary:
    "Restarted verification replaces silent runner work within one poll and still asks after twenty minutes of live ownership.",
  agent: () => [],
  async run(proof) {
    const child = Bun.spawn(
      [
        "bun",
        "test",
        "test/loop.closeout-stall.test.ts",
        "--test-name-pattern",
        "a reverify after restart handles an active verifying run with (stale|silent) runner work|PAS-2017 live runner",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    proof.expect("restart and live-owner scenarios pass", status === 0, { stdout, stderr });
  },
} satisfies Proof;
