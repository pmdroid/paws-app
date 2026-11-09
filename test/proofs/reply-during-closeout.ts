import { join } from "node:path";
import { type FakeStep } from "../../src/acp/testing/script";
import { type Proof } from "./harness";

const FAILURE = "widgets.txt is missing the line: shelf b: 7";
const REPLY = "Also list shelf c, even when it is empty.";
const WAITS = "Got it. I'll pick this up once verification finishes.";

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

const count = (text: string, part: string) => text.split(part).length - 1;

export default {
  covers: ["src/db/linear-sessions.ts", "src/loop/orchestrator.ts"],
  summary:
    "A person replies in Linear while Closeout verifies the first commit; Closeout keeps its verdict, the session hears the reply waits, the findings turn gets the failure and the reply once, and the item merges.",
  policy: `specVersion: "0.1"
retry:
  maxFailedAttemptsPerItem: 3
  scope: task
items:
  - id: test
    kind: command
    gate: beforePR
    exec: ["sh", "-c", "sleep 3; grep -qx 'shelf b: 7' widgets.txt || { echo '${FAILURE}'; exit 1; }"]
    timeoutSeconds: 30
`,
  agent: (input) =>
    ["implement", "fix"].includes(input.purpose)
      ? input.prompt.includes(FAILURE)
        ? commit(
            input.worktree,
            input.prompt.includes(REPLY)
              ? "shelf a: 12\nshelf b: 7\nshelf c: 0\n"
              : "shelf a: 12\nshelf b: 7\n",
            "Count shelves b and c",
          )
        : commit(input.worktree, "shelf a: 12\n", "Count widgets per shelf")
      : [],
  async run(proof) {
    await proof.delegate();
    const settled = proof.waitFor(
      "the item is merged",
      () => ["merged", "failed", "manual", "cancelled"].includes(proof.itemState() ?? ""),
      120_000,
    );
    const deadline = Date.now() + 60_000;
    while (proof.itemState() !== "verifying" && Date.now() < deadline) await Bun.sleep(20);
    await proof.replyInLinear(REPLY);
    proof.expect(
      "the reply leaves Closeout running",
      proof.itemState() === "verifying" && proof.launches.length === 1,
      { state: proof.itemState(), launches: proof.launches.map((launch) => launch.purpose) },
    );
    const merged = await settled;
    await proof.waitFor("queued Linear activity is delivered", () => false, 1_000);
    const bodies = proof.linear.progress.map((update) => update.body);
    proof.expect(
      "the session hears once that the reply waits for verification, and no interruption",
      count(bodies.join("\n"), WAITS) === 1 && !bodies.includes("Received your update."),
      bodies,
    );
    const transitions = proof.transitions();
    proof.expect(
      "Closeout's verdict sends the item back once with its findings, not with the reply",
      transitions.filter((row) => row.event === "restart").length === 1 &&
        transitions.some(
          (row) => row.from === "verifying" && row.to === "queued" && row.event === "restart",
        ),
      transitions,
    );
    const turns = proof.launches.filter((launch) => ["implement", "fix"].includes(launch.purpose));
    const fix = turns[1]?.prompt ?? "";
    proof.expect(
      "the findings turn sees the failure and the reply, the reply once",
      turns.length === 2 && fix.includes(FAILURE) && count(fix, REPLY) === 1,
      {
        purposes: turns.map((turn) => turn.purpose),
        replies: count(fix, REPLY),
        fixPrompt: fix.slice(0, 2_000),
      },
    );
    const log = await proof.originMainLog();
    proof.expect(
      "the fix commit is merged into origin main",
      merged && proof.itemState() === "merged" && log.includes("Count shelves b and c"),
      { state: proof.itemState(), log },
    );
  },
} satisfies Proof;
