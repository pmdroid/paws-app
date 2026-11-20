import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FakeStep } from "../../src/acp/testing/script";
import fixRound from "./closeout-fix-round";
import { type LaunchInput, type Proof } from "./harness";

const FAILURE = "widgets.txt is missing the line: shelf b: 7";
const MOVED = "while you worked. Start from their commits";
const ARRIVED = "commits that Paws didn't push arrived on";

function personPushes(worktree: string): void {
  const git = (cwd: string, ...args: string[]) => {
    const run = Bun.spawnSync(["git", ...args], {
      cwd,
      env: { ...process.env, GIT_AUTHOR_NAME: "rita", GIT_COMMITTER_NAME: "rita" },
    });
    if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
    return run.stdout.toString().trim();
  };
  const branch = git(worktree, "rev-parse", "--abbrev-ref", "HEAD");
  const other = mkdtempSync(join(tmpdir(), "paws-person-"));
  git(other, "clone", "-q", git(worktree, "remote", "get-url", "origin"), ".");
  git(other, "checkout", "-q", branch);
  writeFileSync(join(other, "notes.txt"), "shelf a sits by the door\n");
  git(other, "add", "notes.txt");
  git(other, "commit", "-q", "-m", "Note where shelf a sits");
  git(other, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
  rmSync(other, { recursive: true, force: true });
}

function agent(input: LaunchInput): FakeStep[] {
  if (input.prompt.includes(ARRIVED)) return fixRound.agent({ ...input, prompt: FAILURE });
  if (input.prompt.includes(FAILURE) && input.purpose === "fix") personPushes(input.worktree);
  return fixRound.agent(input);
}

export default {
  ...fixRound,
  covers: [
    "src/github/push.ts",
    "src/github/publication.ts",
    "src/github/pull-head.ts",
    "src/loop/branch-arrivals.ts",
    "src/loop/orchestrator.ts",
  ],
  summary:
    "With mirrors off, a person pushes a commit to the Paws branch while the fix turn runs. Paws does not overwrite it: the publication sees the moved branch and restarts the item, the next turn starts from the person's commit with it listed in the prompt and one session thought, and the merge keeps both.",
  config: "[github_access]\nmirrors = false\n",
  forbidRepos: true,
  agent,
  async run(proof) {
    await proof.delegate();
    const settled = await proof.waitFor(
      "the item settles",
      async () =>
        ["merged", "failed", "manual", "cancelled"].includes((await proof.itemState()) ?? ""),
      120_000,
    );
    await proof.waitFor("queued Linear activity is delivered", () => false, 1_000);
    const turns = proof.launches.filter((launch) => ["implement", "fix"].includes(launch.purpose));
    const transitions = await proof.transitions();
    proof.expect(
      "publishing over the moved branch restarts the item with the follow-up body",
      turns.length === 3 && turns[2]!.prompt.includes(MOVED),
      { purposes: turns.map((turn) => turn.purpose), transitions },
    );
    proof.expect(
      "turns that start from the branch as Paws left it get no arrivals section",
      turns.length >= 2 &&
        !turns[0]!.prompt.includes(ARRIVED) &&
        !turns[1]!.prompt.includes(ARRIVED),
      turns.map((turn) => turn.prompt.slice(0, 300)),
    );
    const prompt = turns[2]?.prompt ?? "";
    proof.expect(
      "the next turn's prompt lists the person's commit with its sha, author and subject",
      new RegExp(`${ARRIVED} \\S+:\\n[0-9a-f]{7} rita Note where shelf a sits\\n`).test(prompt),
      prompt.slice(0, 1_500),
    );
    const thoughts = proof.linear.progress.filter(
      (entry) => entry.kind === "thought" && /^Continuing from 1 commits on /.test(entry.body),
    );
    proof.expect("the session gets the thought once", thoughts.length === 1, thoughts);
    const log = await proof.originMainLog();
    proof.expect(
      "main keeps the person's commit and one fix, not the overwritten try",
      log.includes("Note where shelf a sits") &&
        log.filter((line) => line === "Count shelf b").length === 1,
      log,
    );
    proof.expect(
      "the item is merged",
      settled && (await proof.itemState()) === "merged",
      await proof.itemState(),
    );
  },
} satisfies Proof;
