import mainMoved from "./main-moved";
import { type Proof } from "./harness";

export default {
  ...mainMoved,
  covers: [
    "src/merge/advance.ts",
    "src/github/merge.ts",
    "src/github/git-reader.ts",
    "src/closeout-spec/facade.ts",
    "src/github/candidate-reads.ts",
    "src/loop/candidate-risk.ts",
    "src/loop/repository-location.ts",
    "src/index.ts",
    "src/config/file.ts",
    "src/config/paths.ts",
    "src/acp/executor.ts",
    "src/acp/worktree.ts",
    "src/loop/orchestrator.ts",
    "test/proofs/harness.ts",
  ],
  summary:
    'With [github_access] mirrors = false and main_moved = "ci", main moves after Closeout accepts; GitHub rebases the pull request through update-branch, and the item merges the head GitHub made without Closeout running again.',
  forbidRepos: true,
  config: "[github_access]\nmirrors = false\n",
  async run(proof) {
    await mainMoved.run(proof);
    proof.expect(
      "Publication includes a known risk classification",
      proof.github.opened[0]?.body.includes("Risk: normal") === true,
    );
    const paths = proof.github.calls.map((call) => call.path);
    proof.expect(
      "the configured GitHub reader loads main policy and candidate changed paths",
      paths.some((path) => path.endsWith("/git/ref/heads/main")) &&
        paths.some((path) => path.includes("/git/trees/")) &&
        paths.some((path) => path.includes("/compare/")),
      paths,
    );
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
