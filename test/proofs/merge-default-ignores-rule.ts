import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { ACME, type Proof } from "./harness";

const OURS = "Count widgets per shelf";
const THEIRS = "Document the acme widget shelves";

export default {
  covers: ["src/config/merge.ts", "src/settings/merging.ts", "src/loop/orchestrator.ts"],
  summary:
    "A config.toml issue rule for the Hotfix label asks for Closeout after a rebase; the Acme issue carries that label, and it merges with the [merge] default instead: the rebased head waits for CI and Closeout does not run again.",
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
    appendFileSync(
      join(process.env.PAWS_HOME!, "config.toml"),
      '\n[merge]\nmain_moved = "ci"\n\n[[merge.rules]]\nlabel = "Hotfix"\nmain_moved = "closeout"\n',
    );
    proof.linear.mergeContexts.set(ACME.issueId, { projectId: null, labels: ["Hotfix"] });
    await proof.delegate();
    const queued = await proof.waitFor(
      "Closeout accepts and the item waits in the merge queue on CI",
      async () =>
        (await proof.itemState()) === "merge_queue" &&
        proof.github.calls.some((call) => call.path === "/graphql"),
    );
    proof.expect("Closeout accepts and the item waits to merge", queued, await proof.transitions());
    await proof.pushToMain("SHELVES.md", "# Shelves\n\nShelf a and shelf b.\n", THEIRS);
    proof.github.ci.pending = false;
    await proof.waitFor(
      "the item is merged",
      async () =>
        ["merged", "failed", "manual", "cancelled"].includes((await proof.itemState()) ?? ""),
      120_000,
    );
    const log = await proof.originMainLog();
    proof.expect(
      "the rebased head merges with both commits on main",
      (await proof.itemState()) === "merged" && log[0] === OURS && log[1] === THEIRS,
      { state: await proof.itemState(), log },
    );
    const leftQueue = (await proof.transitions()).filter((row) => row.from === "merge_queue");
    proof.expect(
      "Closeout does not run again after the rebase, as the [merge] default says",
      leftQueue.length === 1 && leftQueue[0]!.to === "merged",
      leftQueue,
    );
  },
} satisfies Proof;
