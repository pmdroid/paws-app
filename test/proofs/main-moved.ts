import { join } from "node:path";
import { type Proof } from "./harness";

const OURS = "Count widgets per shelf";
const THEIRS = "Document the acme widget shelves";

export default {
  covers: [
    "src/merge/**",
    "src/loop/merge-jobs.ts",
    "src/loop/pull-ci.ts",
    "src/loop/repository-git.ts",
    "src/github/**",
  ],
  summary:
    "Main moves after Closeout accepts and before the merge; the merge lane rebases the pull request onto the new main, and the item merges with both commits on origin main.",
  ciPending: true,
  agent: (input) =>
    input.purpose === "implement"
      ? [
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
              OURS,
            ],
            cwd: input.worktree,
          },
        ]
      : [],
  async run(proof) {
    await proof.delegate();
    const queued = await proof.waitFor(
      "Closeout accepts and the item waits in the merge queue on CI",
      () =>
        proof.itemState() === "merge_queue" &&
        proof.github.calls.some((call) => call.path === "/graphql"),
    );
    proof.expect(
      "Closeout accepts and the item waits to merge",
      queued && proof.transitions().some((row) => row.event === "closeout_accepted"),
      proof.transitions(),
    );
    const accepted = /^Head: (\w+)$/m.exec(proof.github.opened[0]?.body ?? "")?.[1] ?? null;
    await proof.pushToMain("SHELVES.md", "# Shelves\n\nShelf a and shelf b.\n", THEIRS);
    proof.github.ci.pending = false;
    const merged = await proof.waitFor(
      "the item is merged",
      () => ["merged", "failed", "manual", "cancelled"].includes(proof.itemState() ?? ""),
      120_000,
    );
    await proof.waitFor("queued Linear activity is delivered", () => false, 1_000);
    const merges = proof.github.calls.filter(
      (call) => call.method === "PUT" && call.path.endsWith("/merge"),
    );
    const log = await proof.originMainLog();
    const mergedHeads = [...proof.github.merged.values()];
    proof.expect(
      "the merge lane rebases onto the new main and merges the rebased head",
      merges.length === 1 &&
        merges[0]!.outcome === "200" &&
        accepted !== null &&
        mergedHeads.length === 1 &&
        mergedHeads[0] !== accepted &&
        log[0] === OURS &&
        log[1] === THEIRS,
      { merges, accepted, merged: mergedHeads, log },
    );
    const files = await proof.originMainFiles();
    proof.expect(
      "origin main holds both commits",
      log.includes(OURS) &&
        log.includes(THEIRS) &&
        files.includes("SHELVES.md") &&
        files.includes("widgets.txt"),
      { log, files },
    );
    proof.expect(
      "the item is merged, not failed",
      merged && proof.itemState() === "merged",
      proof.itemState(),
    );
  },
} satisfies Proof;
