import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { POLICY_VALID_ID, run, type DecisionDocument } from "../src/closeout-spec";
import { bypassable, type CloseoutBypass } from "../src/closeout";
import { applyBypasses } from "../src/closeout/bypass";

const TOO_LONG = "/description must NOT have more than 500 characters";

function policy(description: string, exit = 0): string {
  return JSON.stringify({
    specVersion: "0.1",
    description,
    items: [
      {
        id: "typecheck",
        kind: "command",
        gate: "beforePR",
        exec: [process.execPath, "-e", `process.exit(${exit})`],
        timeoutSeconds: 30,
      },
    ],
  });
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

function commit(dir: string, files: Record<string, string>, message: string): string {
  for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
  git(dir, "add", ".");
  git(dir, "commit", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

async function closeout(
  mainPolicy: string,
  files: Record<string, string>,
): Promise<DecisionDocument> {
  const root = mkdtempSync(join(tmpdir(), "paws-candidate-policy-"));
  try {
    const repo = join(root, "monorepo");
    const origin = join(root, "acme-monorepo.git");
    git(root, "init", "-b", "main", repo);
    mkdirSync(join(repo, ".agents"));
    const base = commit(
      repo,
      { ".agents/closeout.yaml": mainPolicy, "README.md": "acme\n" },
      "Base",
    );
    git(root, "clone", "--bare", repo, origin);
    git(repo, "remote", "add", "origin", origin);
    const head = commit(repo, files, "Candidate");
    return await run({
      repo,
      base,
      head,
      gate: "beforePR",
      task: "DEP-687",
      candidate: { session: "candidate", model: "candidate-model", provider: "fixture" },
      evidenceDir: join(root, "evidence"),
      pawsHome: join(root, "paws"),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a candidate that breaks the policy fails policy-valid and still runs main's checks", async () => {
  const decided = await closeout(policy("Acme checks"), {
    ".agents/closeout.yaml": policy("x".repeat(539)),
  });
  expect(decided.decision).toBe("rejected");
  expect(decided.items.find((item) => item.id === "typecheck")?.state).toBe("passed");
  const check = decided.items.find((item) => item.id === POLICY_VALID_ID);
  expect(check?.kind).toBe("rule");
  expect(check?.state).toBe("failed");
  expect(check?.message).toContain(`.agents/closeout.yaml: ${TOO_LONG}`);
}, 20_000);

test("a candidate that leaves the policy alone has no policy-valid item", async () => {
  const decided = await closeout(policy("Acme checks"), { "README.md": "acme widgets\n" });
  expect(decided.decision).toBe("accepted");
  expect(decided.items.map((item) => item.id)).toEqual(["typecheck"]);
}, 20_000);

test("a valid policy change passes and has no effect until it merges", async () => {
  const decided = await closeout(policy("Acme checks"), {
    ".agents/closeout.yaml": policy("Acme checks, now failing", 1),
  });
  expect(decided.decision).toBe("accepted");
  expect(decided.items.map((item) => [item.id, item.state])).toEqual([["typecheck", "passed"]]);
}, 20_000);

test("an invalid main policy that the branch fixes says so", async () => {
  const decided = await closeout(policy("x".repeat(539)), {
    ".agents/closeout.yaml": policy("Acme checks"),
  });
  expect(decided.decision).toBe("blocked");
  expect(decided.message).toBe(
    `main's .agents/closeout.yaml is invalid (.agents/closeout.yaml: ${TOO_LONG}); this branch fixes it, and Closeout can run once it merges`,
  );
}, 20_000);

test("an invalid main policy the branch does not fix keeps the parser message", async () => {
  const decided = await closeout(policy("x".repeat(539)), { "README.md": "acme widgets\n" });
  expect(decided.decision).toBe("blocked");
  expect(decided.message).toBe(`.agents/closeout.yaml: ${TOO_LONG}`);
}, 20_000);

test("policy-valid cannot be bypassed", () => {
  const failed = { id: POLICY_VALID_ID, kind: "rule", state: "failed" as const, message: TOO_LONG };
  expect(bypassable(failed)).toBe(false);
  expect(bypassable({ ...failed, id: "typecheck" })).toBe(true);
  const decision: DecisionDocument = {
    specVersion: "0.1",
    decision: "rejected",
    gate: "beforePR",
    base: "a".repeat(40),
    head: "b".repeat(40),
    candidate: { session: "s", model: "m", provider: "p", task: "DEP-687" },
    policy: { path: ".agents/closeout.yaml", digest: "sha256:abc", absent: false },
    items: [failed],
    warnings: [],
  };
  const approval: CloseoutBypass = {
    questionId: "q",
    taskId: "DEP-687",
    base: decision.base,
    head: decision.head,
    policyDigest: "sha256:abc",
    checkIds: [POLICY_VALID_ID],
    actor: "person",
    reason: "ship it",
  };
  const evaluation = {
    outcome: "rejected" as const,
    exitCode: 1,
    decision,
    reviewFindings: [],
    head: decision.head,
  };
  expect(applyBypasses(evaluation, [approval]).outcome).toBe("rejected");
});
