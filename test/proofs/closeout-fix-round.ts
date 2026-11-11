import { join } from "node:path";
import { type FakeStep } from "../../src/acp/testing/script";
import { type Proof } from "./harness";

const FAILURE = "widgets.txt is missing the line: shelf b: 7";

function commit(worktree: string, content: string, message: string): FakeStep[] {
  return [
    { type: "fs_write", path: join(worktree, "widgets.txt"), content },
    { type: "terminal", command: "git", args: ["add", "widgets.txt"], cwd: worktree },
    {
      type: "terminal",
      command: "git",
      args: [
        "-c",
        "user.name=Acme Agent",
        "-c",
        "user.email=agent@acme.test",
        "commit",
        "-q",
        "-m",
        message,
      ],
      cwd: worktree,
    },
  ];
}

export default {
  covers: [
    "src/closeout/**",
    "src/closeout-spec/**",
    "src/loop/closeout-round.ts",
    "src/loop/closeout-focus.ts",
    "src/loop/operations.ts",
    "src/loop/orchestrator.ts",
  ],
  summary:
    "The policy's test check fails on the first commit; Closeout sends the item back with the failure, the fix turn sees it in its prompt and adds the line, and the item merges.",
  policy: `specVersion: "0.1"
retry:
  maxFailedAttemptsPerItem: 3
  scope: task
items:
  - id: test
    kind: command
    gate: beforePR
    exec: ["sh", "-c", "grep -qx 'shelf b: 7' widgets.txt || { echo '${FAILURE}'; exit 1; }"]
    timeoutSeconds: 10
`,
  agent: (input) =>
    ["implement", "fix"].includes(input.purpose)
      ? input.prompt.includes(FAILURE)
        ? commit(input.worktree, "shelf a: 12\nshelf b: 7\n", "Count shelf b")
        : commit(input.worktree, "shelf a: 12\n", "Count widgets per shelf")
      : [],
  async run(proof) {
    await proof.delegate();
    const merged = await proof.waitFor(
      "the item is merged",
      async () =>
        ["merged", "failed", "manual", "cancelled"].includes((await proof.itemState()) ?? ""),
      120_000,
    );
    await proof.waitFor("queued Linear activity is delivered", () => false, 1_000);
    const turns = proof.launches.filter((launch) => ["implement", "fix"].includes(launch.purpose));
    const purposes = proof.launches.map((launch) => launch.purpose);
    proof.expect(
      "the first turn commits without the line, so Closeout sends the item back",
      turns.length >= 2 &&
        turns[0]!.purpose === "implement" &&
        !turns[0]!.prompt.includes(FAILURE) &&
        (await proof.transitions()).some(
          (row) => row.from === "verifying" && row.event === "restart",
        ),
      { purposes, transitions: await proof.transitions() },
    );
    proof.expect(
      "the fix turn sees the failure text in its prompt",
      turns.length === 2 && turns[1]!.purpose === "fix" && turns[1]!.prompt.includes(FAILURE),
      { purposes, fixPrompt: turns[1]?.prompt.slice(0, 2_000) ?? null },
    );
    const log = await proof.originMainLog();
    proof.expect(
      "the fix commit is merged into origin main",
      log.includes("Count shelf b") && log.includes("Count widgets per shelf"),
      log,
    );
    proof.expect(
      "the item is merged, not failed",
      merged && (await proof.itemState()) === "merged",
      await proof.itemState(),
    );
  },
} satisfies Proof;
