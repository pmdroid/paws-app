import { join } from "node:path";
import { type Proof } from "./harness";

const CONFLICT = "Main moved and #";
const rebasePrompts: string[] = [];

export default {
  covers: ["src/merge/advance.ts", "src/merge/orders.ts"],
  summary:
    "The item waits in the merge queue on CI, then GitHub reports its pull request DIRTY with no checks; the next lane turn sends it back to rebase with one merge-conflict thought instead of waiting for CI that never runs.",
  ciPending: true,
  agent: (input) => {
    if (input.purpose !== "implement") return [];
    if (input.prompt.includes("no longer rebases cleanly")) {
      rebasePrompts.push(input.prompt);
      return [];
    }
    return [
      { type: "fs_write", path: join(input.worktree, "widgets.txt"), content: "12\n" },
      { type: "terminal", command: "git", args: ["add", "widgets.txt"], cwd: input.worktree },
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
          "Count widgets per shelf",
        ],
        cwd: input.worktree,
      },
    ];
  },
  async run(proof) {
    await proof.delegate();
    await proof.waitFor(
      "Closeout accepts and the item waits in the merge queue on CI",
      () =>
        proof.itemState() === "merge_queue" &&
        proof.github.calls.some((call) => call.path === "/graphql"),
    );
    proof.github.ci.pending = false;
    proof.github.ci.dirty = true;

    const thoughts = () =>
      proof.linear.progress.filter(
        (entry) => entry.kind === "thought" && entry.body.startsWith(CONFLICT),
      );
    await proof.waitFor("the conflict reaches the session", () => thoughts().length > 0, 60_000);
    await proof.waitFor("the rebase turn starts", () => rebasePrompts.length > 0, 60_000);
    await proof.waitFor("later deliveries settle", () => false, 1_000);

    proof.expect(
      "the session gets exactly one merge-conflict thought",
      thoughts().length === 1,
      thoughts().map((entry) => entry.body),
    );
    proof.expect(
      "the item went back to the agent with reason conflict",
      proof.transitions().some((row) => row.from === "merge_queue" && row.event === "restart") &&
        rebasePrompts.length === 1,
      proof.transitions().map((row) => row.event),
    );
    proof.expect(
      "the lane never squashed the conflicting pull request",
      !proof.github.calls.some((call) => call.method === "PUT" && call.path.endsWith("/merge")),
    );
  },
} satisfies Proof;
