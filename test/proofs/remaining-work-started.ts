import { join } from "node:path";
import { ACME, type Proof } from "./harness";

const commit = (cwd: string, args: string[]) => ({
  type: "terminal" as const,
  command: "git",
  args,
  cwd,
});

export default {
  covers: ["src/loop/dispatch.ts", "src/linear/**", "src/db/items.ts"],
  summary:
    "A merged pull request that leaves two parts for later files both as sub-issues and starts a Linear session on each, once.",
  agent: (input) =>
    input.purpose === "implement"
      ? [
          { type: "fs_write", path: join(input.worktree, "widgets.txt"), content: "12\n" },
          commit(input.worktree, ["add", "widgets.txt"]),
          commit(input.worktree, ["commit", "-q", "-m", "Count widgets per shelf"]),
          {
            type: "open_pull_request",
            title: "Count widgets per shelf, part 1",
            body: "Writes the shelf count to widgets.txt.",
            remaining: [
              { title: "Count widgets per aisle", scope: "`aisles.txt`: the aisle count." },
              { title: "Count widgets per store", scope: "`stores.txt`: the store count." },
            ],
          },
        ]
      : [],
  async run(proof) {
    await proof.delegate();
    const sessions = proof.linear.issueSessions;
    await proof.waitFor("both sub-issues are started", async () => sessions.length >= 2, 150_000);
    await proof.waitFor("queued Linear activity is delivered", () => false, 1_000);
    const filed = proof.linear.subIssues.get(ACME.issueId) ?? [];
    const state = await proof.itemState();
    proof.expect("the item merged", state === "merged", { state });
    proof.expect(
      "both parts were filed as sub-issues, and each got exactly one Linear session",
      filed.length === 2 &&
        sessions.length === 2 &&
        filed.every((issue) => sessions.filter((s) => s.issueId === issue.id).length === 1),
      { sessions, filed },
    );
  },
} satisfies Proof;
