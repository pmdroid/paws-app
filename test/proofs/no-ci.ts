import { join } from "node:path";
import { ACME, type Proof } from "./harness";

export default {
  covers: ["src/github/readiness.ts", "src/github/fake.ts"],
  summary: "An accepted head pushed six minutes ago merges in a repository with no CI.",
  noCi: true,
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
    await proof.waitFor(
      "the fresh published head waits",
      () => proof.itemState() === "merge_queue",
    );
    proof.expect(
      "a fresh head has not merged",
      !proof.github.calls.some((call) => call.method === "PUT" && call.path.endsWith("/merge")),
    );
    proof.expect(
      "age the Paws publication record",
      await proof.waitFor("publication is recorded", () => proof.ageCandidate()),
    );
    const merged = await proof.waitFor(
      "the item is merged",
      () => ["merged", "failed", "manual", "cancelled"].includes(proof.itemState() ?? ""),
      120_000,
    );
    await proof.waitFor("queued Linear activity is delivered", () => false, 1_000);
    const turns = proof.launches.filter((launch) => launch.purpose === "implement");
    proof.expect("the implement turn ran once", turns.length === 1, {
      purposes: proof.launches.map((launch) => launch.purpose),
    });
    const branch = proof.itemBranch();
    const pulls = proof.github.calls.filter(
      (call) => call.method === "POST" && call.path.endsWith("/pulls"),
    );
    const opened = proof.github.opened;
    proof.expect(
      "a pull request was opened for the item's branch against main",
      pulls.filter((call) => call.outcome === "201").length === 1 &&
        pulls[0]!.outcome === "201" &&
        opened.length === 1 &&
        opened[0]!.head === branch &&
        opened[0]!.base === "main",
      { pulls, opened, branch },
    );
    const transitions = proof.transitions();
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
      merged && proof.itemState() === "merged",
      proof.itemState(),
    );
    const final = proof.linear.progress.at(-1);
    proof.expect(
      "the Linear issue moved to its completed state, and the session got a final activity",
      proof.linear.issueStateTypes.get(ACME.issueId) === "completed" &&
        final?.kind === "response" &&
        final.body.startsWith("Merged #1"),
      { issue: proof.linear.issueStateTypes.get(ACME.issueId), final },
    );
    const held = proof.heldWork();
    proof.expect(
      "no run is left active and no slot is held",
      held.activeRuns === 0 && held.reservations === 0 && held.runningJobs === 0,
      held,
    );
  },
} satisfies Proof;
