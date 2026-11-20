import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { FakeStep } from "../src/acp/testing/script";
import { createCloseoutGate, type CarriedPass } from "../src/closeout";
import { throwawayEnvironment } from "../scripts/throwaway-environment";
import { runProof, type Proof, type ProofContext } from "./proofs/harness";

type Variant = {
  mapped?: boolean;
  unreadableCi?: boolean;
  extraPath?: boolean;
  commitAfterChecks?: boolean;
  policyOnMain?: boolean;
};

type Gate = { head: string; carried: readonly CarriedPass[] | undefined };
type Outcome = { gates: Gate[]; failed: string[]; focused: boolean };

const roots: string[] = [];
const saved = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const command = (id: string, ci: boolean) =>
  `  - id: ${id}\n    kind: command\n    gate: beforePR\n    exec: ["true"]\n    timeoutSeconds: 10\n${ci ? '    ci: "ci"\n' : ""}`;
const policy = (mapped: boolean, timeout = 10) =>
  `specVersion: "0.1"\nitems:\n${command("lint", mapped)}${command("typecheck", mapped)}${command("proof", false).replace("timeoutSeconds: 10", `timeoutSeconds: ${timeout}`)}  - id: independent-review\n    kind: review\n    gate: beforePR\n    skill: .agents/skills/acme-review/SKILL.md\n    failOn: P1\n    independence:\n      differentSession: true\n      differentModel: true\n`;

const git = (worktree: string, ...args: string[]): FakeStep => ({
  type: "terminal",
  command: "git",
  args: ["-c", "user.name=Acme Agent", "-c", "user.email=agent@acme.test", ...args],
  cwd: worktree,
});
const write = (worktree: string, file: string, content: string): FakeStep => ({
  type: "fs_write",
  path: join(worktree, file),
  content,
});
const commit = (worktree: string, ...files: string[]): FakeStep[] => [
  git(worktree, "add", ...files),
  git(worktree, "commit", "-q", "-m", "Count widgets per shelf"),
];

async function conflictFix(variant: Variant = {}): Promise<Outcome> {
  const { root, env } = throwawayEnvironment();
  roots.push(root);
  const { PATH: _path, ...rest } = env;
  Object.assign(process.env, rest);
  const gates: Gate[] = [];
  let context: ProofContext | undefined;
  let rebased = false;
  let focused = false;
  const proof: Proof = {
    covers: [],
    summary: "",
    ciPending: true,
    config: '[merge.repositories."acme/widgets"]\nconflict_checks = ["lint", "typecheck"]\n',
    files: {
      ".agents/skills/acme-review/SKILL.md":
        "---\nname: acme-review\ndescription: Acme review\n---\nReview the change.",
    },
    policy: policy(variant.mapped ?? true),
    reviewer: {
      async review() {
        return {
          session: "acme-review",
          model: "acme-review-model",
          provider: "acme",
          findings: [],
        };
      },
    },
    closeoutGate(options) {
      const gate = createCloseoutGate(options);
      return {
        ...gate,
        async run(input) {
          gates.push({ head: input.headSha, carried: options.carried });
          return gate.run(input);
        },
      };
    },
    agent(input) {
      if (input.purpose !== "implement") return [];
      const { worktree } = input;
      if (!input.prompt.includes("no longer rebases cleanly"))
        return [write(worktree, "widgets.txt", "12\n"), ...commit(worktree, "widgets.txt")];
      rebased = true;
      focused = input.prompt.includes(
        "This restart only resolves a merge conflict with main. get_closeout lists only lint, typecheck as pending.",
      );
      if (variant.unreadableCi) context!.github.ci.unreadable = true;
      const extra = variant.extraPath ? [write(worktree, "shelves.txt", "3\n")] : [];
      const files = variant.extraPath ? ["widgets.txt", "shelves.txt"] : ["widgets.txt"];
      return [
        git(worktree, "reset", "-q", "--hard", "origin/main"),
        write(worktree, "widgets.txt", "99\n12\n"),
        ...extra,
        ...commit(worktree, ...files),
        { type: "get_closeout" },
        { type: "run_closeout", id: "lint" },
        { type: "run_closeout", id: "typecheck" },
        ...(variant.commitAfterChecks
          ? [write(worktree, "widgets.txt", "99\n13\n"), ...commit(worktree, "widgets.txt")]
          : []),
      ];
    },
    async run(proof) {
      context = proof;
      await proof.delegate();
      await proof.waitFor(
        "Closeout accepts and the item waits in the merge queue on CI",
        async () =>
          (await proof.itemState()) === "merge_queue" &&
          proof.github.calls.some((call) => call.path === "/graphql"),
      );
      if (variant.policyOnMain)
        await proof.pushToMain(
          ".agents/closeout.yaml",
          policy(variant.mapped ?? true, 20),
          "Give proof more time",
        );
      await proof.pushToMain("widgets.txt", "99\n", "Set the acme widget count");
      proof.github.ci.pending = false;
      await proof.waitFor(
        "Closeout ran on the rebased head and the item left verification",
        async () =>
          rebased &&
          gates.length >= 2 &&
          ["merge_queue", "merged", "failed", "manual", "awaiting_input"].includes(
            (await proof.itemState()) ?? "",
          ),
        120_000,
      );
    },
  };
  const result = await runProof("conflict-checks-gate", proof, root);
  return {
    gates,
    focused,
    failed: result.assertions.filter((entry) => !entry.passed).map((entry) => entry.name),
  };
}

function rebasedGate({ gates, failed, focused }: Outcome): Gate {
  expect(failed).toEqual([]);
  expect(focused).toBe(true);
  expect(gates.length).toBeGreaterThanOrEqual(2);
  const [accepted, ...later] = gates;
  expect(accepted!.carried).toBeUndefined();
  const rebased = later.find((gate) => gate.head !== accepted!.head);
  expect(rebased).toBeDefined();
  return rebased!;
}

test("a conflict-only fix with green CI, a pass at the new head and the same paths carries proof", async () => {
  const gates = await conflictFix();
  const rebased = rebasedGate(gates);
  expect(rebased.carried).toEqual([{ id: "proof", head: gates.gates[0]!.head }]);
}, 150_000);

test("CI that GitHub cannot report carries nothing", async () => {
  expect(rebasedGate(await conflictFix({ unreadableCi: true })).carried).toBeUndefined();
}, 150_000);

test("a policy that maps no check to CI carries nothing", async () => {
  expect(rebasedGate(await conflictFix({ mapped: false })).carried).toBeUndefined();
}, 150_000);

test("a new head that changes one more path carries nothing", async () => {
  expect(rebasedGate(await conflictFix({ extraPath: true })).carried).toBeUndefined();
}, 150_000);

test("a turn with no pass at the new head carries nothing", async () => {
  expect(rebasedGate(await conflictFix({ commitAfterChecks: true })).carried).toBeUndefined();
}, 150_000);

test("a turn pass under another policy digest carries nothing", async () => {
  expect(rebasedGate(await conflictFix({ policyOnMain: true })).carried).toBeUndefined();
}, 150_000);
