import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "bun:test";
import {
  earlierFindings,
  FINDING_FORMAT,
  isPreExisting,
  parseChangedLines,
  parseLocation,
  preExistingFindings,
  renderReviewPrompt,
  reviewRoundFindings,
  type Finding,
  type ResolvedPolicyPresent,
  type ReviewMaterial,
  type ReviewRecord,
} from "../src/closeout-spec";
import { evaluate } from "../src/closeout-spec/evaluate";
import { createEvidenceStore } from "../src/closeout-spec/evidence/store";
import { PAWS_CLOSEOUT_NAME, PAWS_CLOSEOUT_VERSION } from "../src/closeout-spec/evaluate";

const exec = promisify(execFile);
const DIGEST = `sha256:${"ab".repeat(32)}`;
const BASE = "11".repeat(20);
const HEAD = "22".repeat(20);
const EARLIER_HEAD = "33".repeat(20);
const OLDEST_HEAD = "44".repeat(20);
const paws = { name: PAWS_CLOSEOUT_NAME, version: PAWS_CLOSEOUT_VERSION };

const DIFF = [
  "diff --git a/src/edit.ts b/src/edit.ts",
  "index 1111111..2222222 100644",
  "--- a/src/edit.ts",
  "+++ b/src/edit.ts",
  "@@ -10,2 +10,3 @@ function edited() {",
  "-old",
  "-old",
  "+new",
  "+new",
  "+new",
  "@@ -40 +41 @@",
  "-x",
  "+y",
  "@@ -60,2 +61,0 @@",
  "-gone",
  "-gone",
  "diff --git a/src/added.ts b/src/added.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/added.ts",
  "@@ -0,0 +1,4 @@",
  "+a",
  "+b",
  "+c",
  "+d",
  "diff --git a/src/removed.ts b/src/removed.ts",
  "deleted file mode 100644",
  "--- a/src/removed.ts",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-a",
  "-b",
  "",
].join("\n");

const at = (location: string, severity: Finding["severity"] = "P1"): Finding => ({
  severity,
  location,
  explanation: `unchecked null at ${location}`,
  evidence: "observed",
});

describe("changed lines", () => {
  test("reads the head lines each hunk added or changed", () => {
    const changed = parseChangedLines(DIFF);
    expect([...changed.keys()].sort()).toEqual(["src/added.ts", "src/edit.ts"]);
    expect(changed.get("src/edit.ts")).toEqual([
      [10, 12],
      [41, 41],
      [61, 62],
    ]);
    expect(changed.get("src/added.ts")).toEqual([[1, 4]]);
  });

  test("reads path:line, path:line:column and path:first-last locations", () => {
    expect(parseLocation("src/edit.ts:41")).toEqual({ path: "src/edit.ts", line: 41 });
    expect(parseLocation(" ./src/edit.ts:41:7 ")).toEqual({ path: "src/edit.ts", line: 41 });
    expect(parseLocation("`src/edit.ts`:10-12")).toEqual({ path: "src/edit.ts", line: 10 });
    expect(parseLocation("src/edit.ts")).toBeUndefined();
    expect(parseLocation("the edit function")).toBeUndefined();
    expect(parseLocation("src/edit.ts:0")).toBeUndefined();
    expect(parseLocation("/etc/passwd:3")).toBeUndefined();
  });
});

describe("pre-existing findings", () => {
  const changed = parseChangedLines(DIFF);

  test("a line the change added or edited is in the diff", () => {
    expect(isPreExisting(at("src/edit.ts:11"), changed)).toBe(false);
    expect(isPreExisting(at("src/edit.ts:41"), changed)).toBe(false);
    expect(isPreExisting(at("src/added.ts:4"), changed)).toBe(false);
  });

  test("the lines around a deletion are in the diff", () => {
    expect(isPreExisting(at("src/edit.ts:61"), changed)).toBe(false);
    expect(isPreExisting(at("src/edit.ts:62"), changed)).toBe(false);
  });

  test("an untouched line of a changed file is pre-existing", () => {
    expect(isPreExisting(at("src/edit.ts:9"), changed)).toBe(true);
    expect(isPreExisting(at("src/edit.ts:13"), changed)).toBe(true);
    expect(isPreExisting(at("src/edit.ts:80"), changed)).toBe(true);
  });

  test("a line in a file the change did not touch is pre-existing", () => {
    expect(isPreExisting(at("src/other.ts:3"), changed)).toBe(true);
  });

  test("a location without a readable path:line stays in the diff", () => {
    expect(isPreExisting(at("src/edit.ts"), changed)).toBe(false);
    expect(isPreExisting(at("the retry loop"), changed)).toBe(false);
  });

  test("unknown changed lines keep every finding in the diff", () => {
    expect(isPreExisting(at("src/edit.ts:9"), undefined)).toBe(false);
  });

  test("a path missing its directory prefix matches the one changed file it ends", () => {
    expect(isPreExisting(at("edit.ts:11"), changed)).toBe(false);
    expect(isPreExisting(at("edit.ts:9"), changed)).toBe(true);
  });
});

describe("evaluator", () => {
  const changed = parseChangedLines(DIFF);
  const changedLineRanges = new Map([
    [`${BASE}..${HEAD}`, changed],
    [`${BASE}..${EARLIER_HEAD}`, changed],
  ]);
  const decide = (findings: Finding[], head = HEAD) =>
    evaluate(policy(), [record(findings, { head })], {
      base: BASE,
      head: HEAD,
      gate: "beforePR",
      candidate: { session: "implementer", model: "model-a", provider: "codex" },
      changedLineRanges,
    });

  test("a pre-existing finding at failOn does not fail the item and is named in the message", () => {
    const decision = decide([at("src/edit.ts:9", "P0"), at("src/other.ts:2", "P1")]);
    expect(decision.decision).toBe("accepted");
    expect(decision.items[0]).toMatchObject({
      state: "passed",
      message:
        "review findings satisfy the policy; 2 findings are in pre-existing code and do not block",
    });
  });

  test("a finding on a changed line still fails the item", () => {
    const decision = decide([at("src/edit.ts:9", "P0"), at("src/edit.ts:11", "P1")]);
    expect(decision.decision).toBe("rejected");
    expect(decision.items[0]?.message).toBe(
      "finding at P1 meets failOn P1; 1 finding is in pre-existing code and does not block",
    );
  });

  test("a finding without path:line fails as before", () => {
    expect(decide([at("src/edit.ts", "P1")]).decision).toBe("rejected");
  });

  test("without changed lines every finding counts", () => {
    const decision = evaluate(policy(), [record([at("src/edit.ts:9", "P0")])], {
      base: BASE,
      head: HEAD,
      gate: "beforePR",
      candidate: { session: "implementer", model: "model-a", provider: "codex" },
    });
    expect(decision.decision).toBe("rejected");
  });

  test("a repeated pre-existing finding does not use the retry budget", () => {
    const retried: ResolvedPolicyPresent = {
      ...policy(),
      retry: { maxFailedAttemptsPerItem: 2, maxFailedReviewAttempts: 9, scope: "task" },
    };
    const request = {
      base: BASE,
      head: HEAD,
      gate: "beforePR" as const,
      task: "PAS-1",
      candidate: { session: "implementer", model: "model-a", provider: "codex" },
      changedLineRanges,
    };
    const repeated = (head: string, fresh: string) =>
      record([at("src/edit.ts:9", "P0"), at(fresh, "P1")], { head, task: "PAS-1" });
    const old = evaluate(
      retried,
      [repeated(EARLIER_HEAD, "src/edit.ts:11"), repeated(HEAD, "src/added.ts:2")],
      request,
    );
    expect(old.items[0]?.message).toBe(
      "finding at P1 meets failOn P1; 1 finding is in pre-existing code and does not block",
    );
    const unknown = evaluate(
      retried,
      [repeated(OLDEST_HEAD, "src/edit.ts:11"), repeated(HEAD, "src/added.ts:2")],
      { ...request, changedLineRanges: new Map() },
    );
    expect(unknown.items[0]?.state).toBe("exhausted");
  });
});

describe("second review round", () => {
  const records = [
    record([at("src/a.ts:3"), at("src/b.ts:8", "P0")], { head: OLDEST_HEAD, task: "PAS-1" }),
    record([at("src/b.ts:8", "P0"), at("src/c.ts:5", "P2")], { head: EARLIER_HEAD, task: "PAS-1" }),
    record([at("src/other-task.ts:1")], { head: EARLIER_HEAD, task: "PAS-2", attempt: 2 }),
  ];
  const order = (head: string) => (head === EARLIER_HEAD ? 2 : head === OLDEST_HEAD ? 1 : 0);
  const scope = { itemId: "adversarial-review", policyDigest: DIGEST, base: BASE, task: "PAS-1" };

  test("the last round's findings are open and older ones it did not repeat are fixed", () => {
    expect(earlierFindings(records, scope, order)).toEqual([
      {
        severity: "P0",
        location: "src/b.ts:8",
        explanation: "unchecked null at src/b.ts:8",
        head: EARLIER_HEAD,
        status: "open",
      },
      {
        severity: "P2",
        location: "src/c.ts:5",
        explanation: "unchecked null at src/c.ts:5",
        head: EARLIER_HEAD,
        status: "open",
      },
      {
        severity: "P1",
        location: "src/a.ts:3",
        explanation: "unchecked null at src/a.ts:3",
        head: OLDEST_HEAD,
        status: "fixed",
      },
    ]);
  });

  test("stored rounds read back with the latest round open and older ones fixed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paws-review-rounds-"));
    try {
      const store = createEvidenceStore({ root });
      for (const stored of records.slice(0, 2)) await store.add(stored);
      expect(await reviewRoundFindings(root, order)).toEqual(
        earlierFindings(records, scope, order).map((finding) => ({
          ...finding,
          itemId: "adversarial-review",
        })),
      );
      expect(await reviewRoundFindings(path.join(root, "missing"), order)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the first round has no earlier findings", () => {
    expect(earlierFindings([], scope, order)).toEqual([]);
    expect(renderReviewPrompt(material(), BASE, HEAD)).not.toContain("# Earlier findings");
  });

  test("the prompt lists earlier findings and tells the reviewer not to repeat them", () => {
    const prompt = renderReviewPrompt(
      material(),
      BASE,
      HEAD,
      "candidate",
      earlierFindings(records, scope, order),
    );
    const section = prompt.slice(
      prompt.indexOf("# Earlier findings"),
      prompt.indexOf("# Finding format"),
    );
    expect(section).toBe(
      [
        "# Earlier findings",
        "Earlier review rounds of this item reported these findings. An open finding was reported in the last round and the fixer has changed the code since. A fixed finding was not reported again in a later round.",
        "Do not report an earlier finding again unless the problem is still present at this head. When an open finding is still present, report it again with its current path:line. Report new problems as usual.",
        `- open, P0 at src/b.ts:8 (head ${EARLIER_HEAD.slice(0, 12)}): unchecked null at src/b.ts:8`,
        `- open, P2 at src/c.ts:5 (head ${EARLIER_HEAD.slice(0, 12)}): unchecked null at src/c.ts:5`,
        `- fixed, P1 at src/a.ts:3 (head ${OLDEST_HEAD.slice(0, 12)}): unchecked null at src/a.ts:3`,
        "",
        "",
      ].join("\n"),
    );
    expect(prompt.indexOf("# Diff ")).toBeLessThan(prompt.indexOf("# Earlier findings"));
  });

  test("the finding format asks for path:line, every place, and defines severities", () => {
    expect(FINDING_FORMAT).toContain("location: path:line in the head commit");
    expect(FINDING_FORMAT).toContain("No label prefix.");
    expect(FINDING_FORMAT).toContain(
      "Name every place in the change where the same problem occurs",
    );
    expect(FINDING_FORMAT).toContain(
      "P3: style, duplication, efficiency, naming and documentation.",
    );
    expect(renderReviewPrompt(material(), BASE, HEAD)).toContain(FINDING_FORMAT);
  });
});

describe("pre-existing findings from git", () => {
  test("classifies against the real base..head diff", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paws-converge-"));
    try {
      const git = (...args: string[]) => exec("git", args, { cwd: dir });
      await git("init", "-q");
      await git("config", "user.email", "test@example.com");
      await git("config", "user.name", "Test");
      await writeFile(path.join(dir, "lib.ts"), "one\ntwo\nthree\nfour\n");
      await writeFile(path.join(dir, "old.ts"), "old\n");
      await git("add", ".");
      await git("commit", "-qm", "base");
      const base = (await git("rev-parse", "HEAD")).stdout.trim();
      await writeFile(path.join(dir, "lib.ts"), "one\nTWO\nthree\nfour\nfive\n");
      await git("commit", "-qam", "head");
      const head = (await git("rev-parse", "HEAD")).stdout.trim();
      const findings = [
        at("lib.ts:2"),
        at("lib.ts:3"),
        at("lib.ts:5"),
        at("old.ts:1"),
        at("lib.ts"),
      ];
      const old = await preExistingFindings(dir, base, head, findings);
      expect(old.map((entry) => entry.location)).toEqual(["lib.ts:3", "old.ts:1"]);
      expect(await preExistingFindings(dir, base, "f".repeat(40), findings)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function policy(): ResolvedPolicyPresent {
  return {
    source: "repo",
    digest: DIGEST,
    entryPath: ".agents/closeout.yaml",
    setup: [],
    items: [
      {
        id: "adversarial-review",
        kind: "review",
        gate: "beforePR",
        skill: ".agents/skills/adversarial-review/SKILL.md",
        independence: { differentSession: true, differentModel: true },
        failOn: "P1",
      },
    ],
    files: [{ path: ".agents/closeout.yaml", sha256: "ef".repeat(32) }],
  };
}

function record(
  findings: Finding[],
  overrides: { head?: string; task?: string; attempt?: number } = {},
): ReviewRecord {
  return {
    specVersion: "0.1",
    recordType: "review",
    ...(overrides.task ? { task: overrides.task } : {}),
    itemId: "adversarial-review",
    base: BASE,
    head: overrides.head ?? HEAD,
    policyDigest: DIGEST,
    attempt: overrides.attempt ?? 1,
    evaluator: paws,
    producer: { session: "reviewer", model: "model-b", provider: "other" },
    findings,
    artifacts: [],
  };
}

function material(): ReviewMaterial {
  return {
    skillPath: ".agents/skills/adversarial-review/SKILL.md",
    skill: "Review skill.",
    references: [],
    files: ["src/b.ts"],
    diff: "diff --git a/src/b.ts b/src/b.ts",
  };
}
