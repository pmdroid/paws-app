import { join } from "node:path";
import type { FakeStep } from "../../src/acp/testing/script";
import { CARRIED_PREFIX } from "../../src/closeout";
import { getCloseoutProgress, listWorkItemsByStates } from "../../src/db";
import { WORK_ITEM_STATES } from "../../src/core";
import { type Proof } from "./harness";

const CONFLICT = "This restart only resolves a merge conflict with main.";
const rebasePrompts: string[] = [];
const reviews: string[] = [];

const git = (worktree: string, ...args: string[]): FakeStep => ({
  type: "terminal",
  command: "git",
  args: ["-c", "user.name=Acme Agent", "-c", "user.email=agent@acme.test", ...args],
  cwd: worktree,
});

const command = (id: string, ci = false) =>
  `  - id: ${id}\n    kind: command\n    gate: beforePR\n    exec: ["true"]\n    timeoutSeconds: 10\n${ci ? '    ci: "ci"\n' : ""}`;
const review = (id: string) =>
  `  - id: ${id}\n    kind: review\n    gate: beforePR\n    skill: .agents/skills/acme-review/SKILL.md\n    failOn: P1\n    independence:\n      differentSession: true\n      differentModel: true\n`;

export default {
  covers: [
    "src/loop/conflict-checks.ts",
    "src/loop/closeout-focus.ts",
    "src/loop/automatic-risk-approval.ts",
  ],
  summary:
    "A pull request conflicts with main in the merge queue; the rebase turn lists only lint and typecheck, Closeout keeps proof's pass from the accepted commit, both reviews run again and the pull request merges after green CI.",
  ciPending: true,
  config: '[merge.repositories."acme/widgets"]\nconflict_checks = ["lint", "typecheck"]\n',
  files: {
    ".agents/skills/acme-review/SKILL.md":
      "---\nname: acme-review\ndescription: Acme review\n---\nReview the change.",
  },
  policy: `specVersion: "0.1"\nitems:\n${command("lint", true)}${command("typecheck", true)}${command("proof")}${review("independent-review")}${review("security-review")}`,
  reviewer: {
    async review(request) {
      reviews.push(request.itemId ?? "review");
      return { session: "acme-review", model: "acme-review-model", provider: "acme", findings: [] };
    },
  },
  agent: (input) => {
    if (input.purpose !== "implement") return [];
    const write = (content: string): FakeStep => ({
      type: "fs_write",
      path: join(input.worktree, "widgets.txt"),
      content,
    });
    if (input.prompt.includes("no longer rebases cleanly")) {
      rebasePrompts.push(input.prompt);
      return [
        git(input.worktree, "reset", "-q", "--hard", "origin/main"),
        write("99\n12\n"),
        git(input.worktree, "add", "widgets.txt"),
        git(input.worktree, "commit", "-q", "-m", "Count widgets per shelf"),
        { type: "get_closeout" },
        { type: "run_closeout", id: "lint" },
        { type: "run_closeout", id: "typecheck" },
      ];
    }
    return [
      write("12\n"),
      git(input.worktree, "add", "widgets.txt"),
      git(input.worktree, "commit", "-q", "-m", "Count widgets per shelf"),
    ];
  },
  async run(proof) {
    await proof.delegate();
    await proof.waitFor(
      "Closeout accepts and the item waits in the merge queue on CI",
      async () =>
        (await proof.itemState()) === "merge_queue" &&
        proof.github.calls.some((call) => call.path === "/graphql"),
    );
    const reviewsBefore = reviews.length;
    await proof.pushToMain("widgets.txt", "99\n", "Set the acme widget count");
    proof.github.ci.pending = false;
    await proof.waitFor(
      "the item is merged",
      async () =>
        ["merged", "failed", "manual", "awaiting_input"].includes((await proof.itemState()) ?? ""),
      120_000,
    );
    const [item] = await listWorkItemsByStates(proof.store, WORK_ITEM_STATES);
    const head = proof.github.merged.values().next().value ?? item?.acceptedHead ?? "";
    const run = item ? await getCloseoutProgress(proof.store, item.id, head) : null;
    const step = (id: string) => run?.steps.find((entry) => entry.id === id);
    const pending = proof
      .closeoutReports()
      .filter((report) => report.startsWith("{"))
      .map((report) => JSON.stringify((JSON.parse(report) as { pending?: unknown }).pending));
    proof.expect(
      "the rebase turn is told it lists only lint and typecheck",
      rebasePrompts.length === 1 &&
        rebasePrompts[0]!.includes(
          `${CONFLICT} get_closeout lists only lint, typecheck as pending.`,
        ),
      rebasePrompts.map((prompt) => prompt.slice(0, 2_000)),
    );
    proof.expect(
      "get_closeout in the rebase turn lists only lint and typecheck as pending",
      pending.includes(JSON.stringify(["lint", "typecheck"])),
      pending,
    );
    proof.expect(
      "Closeout records proof as carried from the accepted commit on the merged head",
      step("proof")?.state === "passed" &&
        (step("proof")?.detail ?? "").startsWith(CARRIED_PREFIX) &&
        !(step("lint")?.detail ?? "").startsWith(CARRIED_PREFIX),
      run?.steps.map((entry) => [entry.id, entry.state, entry.detail]),
    );
    proof.expect(
      "both reviews run again on the fixed commit",
      reviews.length - reviewsBefore === 2 &&
        step("independent-review")?.state === "passed" &&
        step("security-review")?.state === "passed",
      { reviews: reviews.length - reviewsBefore, steps: run?.steps.map((entry) => entry.id) },
    );
    proof.expect(
      "the pull request merges after green CI",
      (await proof.itemState()) === "merged" && proof.github.merged.size === 1,
      await proof.itemState(),
    );
  },
} satisfies Proof;
