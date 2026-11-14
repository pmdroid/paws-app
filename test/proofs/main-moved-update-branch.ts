import mainMoved from "./main-moved";
import { type Proof } from "./harness";

export default {
  ...mainMoved,
  covers: ["src/merge/advance.ts", "src/github/merge.ts", "src/config/file.ts"],
  summary:
    'With [github] mirrors = false and main_moved = "ci", main moves after Closeout accepts; GitHub rebases the pull request through update-branch, and the item merges the head GitHub made without Closeout running again.',
  config: "[github]\nmirrors = false\n",
  async run(proof) {
    await mainMoved.run(proof);
    const accepted = /^Head: (\w+)$/m.exec(proof.github.opened[0]?.body ?? "")?.[1] ?? null;
    const updates = proof.github.branchUpdates;
    const merged = [...proof.github.merged.values()];
    proof.expect(
      "GitHub's update-branch rebased the accepted head once, and the lane merged the head it made",
      updates.length === 1 &&
        updates[0]!.expected === accepted &&
        merged.length === 1 &&
        merged[0] === updates[0]!.rebased,
      { accepted, updates, merged },
    );
    const transitions = await proof.transitions();
    proof.expect(
      "Closeout accepted once; its acceptance carried to the rebased head",
      transitions.filter((row) => row.event === "closeout_accepted").length === 1 &&
        !transitions.some((row) => row.to === "verifying" && row.from === "merge_queue"),
      transitions,
    );
  },
} satisfies Proof;
