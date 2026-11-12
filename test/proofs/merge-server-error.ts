import { join } from "node:path";
import { setJournalSink } from "../../src/journal";
import { type Proof } from "./harness";

export default {
  covers: ["src/github/merge.ts", "src/merge/advance.ts", "src/loop/merge-jobs.ts"],
  summary:
    "GitHub answers the squash merge with HTTP 500 once; Paws journals it and merges 30 s later.",
  noCi: true,
  mergeServerErrors: 1,
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
    const lines: string[] = [];
    const restore = setJournalSink((line) => lines.push(line));
    try {
      await proof.delegate();
      await proof.waitFor(
        "the head waits",
        async () => (await proof.itemState()) === "merge_queue",
      );
      proof.expect(
        "age the Paws publication record",
        await proof.waitFor("publication is recorded", () => proof.ageCandidate()),
      );
      const merged = await proof.waitFor(
        "the item is merged",
        async () => ["merged", "failed", "manual"].includes((await proof.itemState()) ?? ""),
        120_000,
      );
      const merges = proof.github.calls.filter(
        (call) => call.method === "PUT" && call.path.endsWith("/pulls/1/merge"),
      );
      proof.expect(
        "the squash merge got a 500, then merged on the retry",
        merged &&
          (await proof.itemState()) === "merged" &&
          merges.map((call) => call.outcome).join(",") === "500,200",
        { state: await proof.itemState(), merges },
      );
      const journaled = lines.filter((line) => line.includes("GitHub HTTP 500"));
      proof.expect(
        "the 500 was journaled once with its request id and body",
        journaled.length === 1 &&
          journaled[0]!.includes("#1 GitHub HTTP 500, request id PROOF:500") &&
          journaled[0]!.includes('body {"message":"Server Error"}'),
        journaled,
      );
      const transitions = await proof.transitions();
      proof.expect(
        "the item did not go back through Closeout",
        transitions.filter((row) => row.event === "closeout_accepted").length === 1,
        transitions,
      );
    } finally {
      restore();
    }
  },
} satisfies Proof;
