import { join } from "node:path";
import { ACME, type Proof } from "./harness";

export default {
  covers: [
    "src/loop/**",
    "src/merge/**",
    "src/closeout/**",
    "src/github/**",
    "src/linear/**",
    "src/scheduler/**",
    "src/runner-backend/**",
    "src/db/items.ts",
    "src/db/commands.ts",
  ],
  summary:
    "A delegated issue is implemented, passes Closeout, gets a pull request, merges into main and is marked done in Linear.",
  agent: (input) =>
    input.purpose === "implement"
      ? [
          { type: "fs_write", path: join(input.worktree, "widgets.txt"), content: "12\n" },
          { type: "terminal", command: "git", args: ["add", "widgets.txt"], cwd: input.worktree },
          {
            type: "terminal",
            command: "git",
            args: ["commit", "-q", "-m", "Count widgets per shelf"],
            cwd: input.worktree,
          },
        ]
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
    const turns = proof.launches.filter((launch) => launch.purpose === "implement");
    proof.expect("the implement turn ran once", turns.length === 1, {
      purposes: proof.launches.map((launch) => launch.purpose),
    });
    const branch = await proof.itemBranch();
    const pulls = proof.github.calls.filter(
      (call) => call.method === "POST" && call.path.endsWith("/pulls"),
    );
    const opened = proof.github.opened;
    proof.expect(
      "a pull request was opened for the item's branch against main",
      pulls.length === 1 &&
        pulls[0]!.outcome === "201" &&
        opened.length === 1 &&
        opened[0]!.head === branch &&
        opened[0]!.base === "main",
      { pulls, opened, branch },
    );
    const transitions = await proof.transitions();
    proof.expect(
      "Closeout accepted the head",
      transitions.some((row) => row.event === "closeout_accepted"),
      transitions,
    );
    const merges = proof.github.calls.filter(
      (call) => call.method === "PUT" && call.path.endsWith("/pulls/1/merge"),
    );
    const files = await proof.originMainFiles();
    proof.expect(
      "the merge request was made, and origin main contains widgets.txt",
      merges.length === 1 && merges[0]!.outcome === "200" && files.includes("widgets.txt"),
      { merges, files },
    );
    proof.expect(
      "the item is merged, not failed",
      merged && (await proof.itemState()) === "merged",
      await proof.itemState(),
    );
    const final = proof.linear.progress.at(-1);
    proof.expect(
      "the Linear issue moved to its completed state, and the session got a final activity",
      proof.linear.issueStateTypes.get(ACME.issueId) === "completed" &&
        final?.kind === "response" &&
        final.body.startsWith("Merged #1"),
      { issue: proof.linear.issueStateTypes.get(ACME.issueId), final },
    );
    const held = await proof.heldWork();
    proof.expect(
      "no run is left active and no slot is held",
      held.activeRuns === 0 && held.reservations === 0 && held.runningJobs === 0,
      held,
    );
  },
} satisfies Proof;
