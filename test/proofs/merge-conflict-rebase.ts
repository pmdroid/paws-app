import { join } from "node:path";
import { type Proof } from "./harness";

const CONFLICT = "Main moved and #";
const SQUASH = "git reset --soft $(git merge-base HEAD origin/main)";
const rebasePrompts: string[] = [];

const commit = (worktree: string, message: string) => [
  { type: "terminal" as const, command: "git", args: ["add", "widgets.txt"], cwd: worktree },
  {
    type: "terminal" as const,
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

export default {
  covers: [
    "src/merge/**",
    "src/loop/activity-policy.ts",
    "src/loop/fix-round-notice.ts",
    "src/loop/session-progress.ts",
    "src/scheduler/waits.ts",
  ],
  summary:
    "Main changes the file the pull request changes after the pull request response; the Linear session gets one merge-conflict thought, the rebase turn's plan shows Fix merge conflicts, its handoff asks for one squashed commit and the pull request says Paws is working on the conflict.",
  ciPending: true,
  agent: (input) => {
    if (input.purpose !== "implement") return [];
    // The rebase turn lasts long enough for its plan update to go out before Closeout runs.
    if (input.prompt.includes("no longer rebases cleanly")) {
      rebasePrompts.push(input.prompt);
      return [
        {
          type: "update",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Rebasing." },
          },
          delayMs: 3_000,
        },
      ];
    }
    return [
      { type: "fs_write", path: join(input.worktree, "widgets.txt"), content: "12\n" },
      ...commit(input.worktree, "Count widgets per shelf"),
    ];
  },
  async run(proof) {
    await proof.delegate();
    await proof.waitFor(
      "Closeout accepts and the item waits in the merge queue on CI",
      async () =>
        (await proof.itemState()) === "merge_queue" &&
        proof.github.calls.some((call) => call.path === "/graphql"),
    );
    await proof.pushToMain("widgets.txt", "99\n", "Set the acme widget count");
    proof.github.ci.pending = false;

    const thoughts = () =>
      proof.linear.progress.filter(
        (entry) => entry.kind === "thought" && entry.body.startsWith(CONFLICT),
      );
    const fixing = () =>
      proof.linear.sessionUpdates.some((update) =>
        update.plan?.some(
          (step) => step.content === "Fix merge conflicts" && step.status === "inProgress",
        ),
      );
    await proof.waitFor("the conflict reaches the session", () => thoughts().length > 0, 60_000);
    await proof.waitFor("the rebase turn's plan shows the step", fixing, 60_000);
    await proof.waitFor("later deliveries settle", () => false, 1_000);

    proof.expect(
      "the session gets exactly one merge-conflict thought",
      thoughts().length === 1 &&
        /now conflicts with it\. Rebasing onto main\.$/.test(thoughts()[0]!.body),
      thoughts().map((entry) => entry.body),
    );
    proof.expect("the rebase turn's plan shows Fix merge conflicts", fixing());
    const working = [...proof.github.comments.values()]
      .flat()
      .filter((comment) => comment.body.startsWith("🐾 Paws is working on this"));
    proof.expect(
      "the pull request gets one working-on-it comment per rebase turn, naming the conflict",
      working.length > 0 &&
        working.length === rebasePrompts.length &&
        working.every((comment) =>
          comment.body.startsWith("🐾 Paws is working on this: a merge conflict with main."),
        ),
      working.map((comment) => comment.body),
    );
    proof.expect(
      "the rebase turn is told to squash the branch to one commit first",
      // The scripted rebase turn commits nothing, so the head may go back more than once.
      rebasePrompts.length > 0 && rebasePrompts.every((prompt) => prompt.includes(SQUASH)),
      rebasePrompts.length,
    );
  },
} satisfies Proof;
