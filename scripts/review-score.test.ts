import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Finding } from "../src/closeout-spec";
import { gitIn, type Candidate, type MergedPull } from "./review-escapes";
import {
  blockingFindings,
  cleanOutcome,
  codexAgent,
  costOf,
  escapeOutcome,
  nearSeverity,
  parseCodexEvents,
  parsePrice,
  pickClean,
  readClean,
  readReviewItem,
  renderReport,
  replayRange,
  spread,
  summarize,
  type CaseResult,
  type ScoreReport,
} from "./review-score";

const ESCAPE = { file: "src/a.ts", line: 40 };

function finding(severity: Finding["severity"], location: string): Finding {
  return { severity, location, explanation: "wrong", evidence: "seen" };
}

function result(overrides: Partial<CaseResult>): CaseResult {
  return {
    id: "case",
    kind: "escape",
    pr: 1,
    diff: "candidate",
    outcome: "missed",
    durationMs: 1000,
    usage: { input: 100, cached: 40, output: 10 },
    blocking: [],
    findings: 0,
    ...overrides,
  };
}

function report(
  results: CaseResult[],
  overrides: Partial<ScoreReport["config"]> = {},
): ScoreReport {
  return {
    version: 1,
    generatedAt: "2026-10-27T00:00:00.000Z",
    config: {
      id: "independent-review",
      skill: ".agents/skills/review-paws/SKILL.md",
      failOn: "P1",
      scope: "diff",
      skillDigest: "a".repeat(64),
      model: "gpt-test",
      effort: "medium",
      tolerance: 5,
      ...overrides,
    },
    results,
  };
}

test("the repository's independent-review item and clean set parse", () => {
  const root = join(import.meta.dir, "..");
  const item = readReviewItem(
    readFileSync(join(root, ".agents/closeout.yaml"), "utf8"),
    "independent-review",
  );
  expect(item).toEqual({
    id: "independent-review",
    skill: ".agents/skills/review-paws/SKILL.md",
    failOn: "P1",
    scope: "diff",
  });
  const clean = readClean(join(root, "evals/review-clean.jsonl"));
  expect(clean.length).toBeGreaterThan(0);
  for (const entry of clean) {
    expect(entry.id).toBe(`clean-${entry.original.pr}`);
    expect(entry.original.base).toMatch(/^[0-9a-f]{40}$/);
    expect(entry.original.head).toMatch(/^[0-9a-f]{40}$/);
    expect(entry.original.mergeCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(entry.changedLines).toBeGreaterThanOrEqual(20);
    expect(entry.quietDays).toBe(entry.author === "paws" ? 7 : 14);
  }
  expect(clean.filter((entry) => entry.author === "paws").length).toBe(4);
  expect(clean.filter((entry) => entry.author === "human").length).toBe(12);
});

test("readReviewItem applies defaults and rejects other kinds", () => {
  const policy = [
    "items:",
    "  - id: r",
    "    kind: review",
    "    skill: s/SKILL.md",
    "  - id: c",
    "    kind: command",
  ].join("\n");
  expect(readReviewItem(policy, "r")).toEqual({
    id: "r",
    skill: "s/SKILL.md",
    failOn: "P1",
    scope: "candidate",
  });
  expect(() => readReviewItem(policy, "c")).toThrow("not a review");
  expect(() => readReviewItem(policy, "x")).toThrow("no item x");
});

test("an escape is caught only by a blocking finding near the bug", () => {
  const near = finding("P1", "src/a.ts:44");
  const far = finding("P0", "src/a.ts:60");
  const minor = finding("P2", "src/a.ts:40");
  expect(escapeOutcome([near], ESCAPE, 5)).toBe("caught");
  expect(escapeOutcome([far], ESCAPE, 5)).toBe("elsewhere");
  expect(escapeOutcome([], ESCAPE, 5)).toBe("missed");
  expect(escapeOutcome([finding("P1", "src/b.ts:40")], ESCAPE, 5)).toBe("elsewhere");
  expect(escapeOutcome([finding("P1", "./src/a.ts:35-38")], ESCAPE, 5)).toBe("caught");
  expect(nearSeverity([minor, far], ESCAPE, 5)).toBe("P2");
  expect(nearSeverity([far], ESCAPE, 5)).toBeUndefined();
});

test("blocking findings are at or above failOn and not pre-existing", () => {
  const p0 = finding("P0", "src/a.ts:1");
  const p1 = finding("P1", "src/a.ts:2");
  const p2 = finding("P2", "src/a.ts:3");
  const old = finding("P0", "src/a.ts:4");
  expect(blockingFindings([p0, p1, p2, old], [old], "P1")).toEqual([p0, p1]);
  expect(blockingFindings([p0, p1, p2], [], "P0")).toEqual([p0]);
  expect(cleanOutcome([p0])).toBe("rejected");
  expect(cleanOutcome([])).toBe("passed");
});

test("cost uses the uncached, cached and output prices", () => {
  expect(costOf({ input: 1_000_000, cached: 400_000, output: 100_000 }, undefined)).toBeUndefined();
  expect(
    costOf({ input: 1_000_000, cached: 400_000, output: 100_000 }, parsePrice("1,0.1,10")),
  ).toBeCloseTo(0.6 + 0.04 + 1);
  expect(() => parsePrice("1,2")).toThrow("--price");
});

test("spread keeps the first and last and spaces the rest", () => {
  expect(spread([1, 2, 3, 4, 5, 6, 7, 8, 9], 3)).toEqual([1, 5, 9]);
  expect(spread([1, 2], 16)).toEqual([1, 2]);
});

test("summary keeps likely escapes and errors apart", () => {
  const summary = summarize([
    result({ id: "a", outcome: "caught" }),
    result({ id: "b", outcome: "missed", nearSeverity: "P2" }),
    result({ id: "c", outcome: "caught", confidence: "likely" }),
    result({ id: "d", outcome: "error", durationMs: 5000 }),
    result({ id: "e", kind: "clean", outcome: "rejected", quietDays: 7, author: "paws" }),
    result({ id: "f", kind: "clean", outcome: "passed", quietDays: 7, author: "paws" }),
    result({ id: "g", kind: "clean", outcome: "passed", quietDays: 14, author: "human" }),
  ]);
  expect(summary.recall).toEqual({ hits: 1, total: 2 });
  expect(summary.recallLikely).toEqual({ hits: 1, total: 1 });
  expect(summary.belowFailOn).toBe(1);
  expect(summary.falsePositives).toEqual({ hits: 1, total: 3 });
  expect(summary.falsePositivesPaws).toEqual({ hits: 1, total: 2 });
  expect(summary.falsePositivesHuman).toEqual({ hits: 0, total: 1 });
  expect(summary.errors).toBe(1);
  expect(summary.medianMs).toBe(1000);
  expect(summary.usage).toEqual({ input: 700, cached: 280, output: 70 });
  expect(summary.costUsd).toBeUndefined();
});

test("a report against the baseline names the changed setting and the flipped cases", () => {
  const baseline = report([
    result({ id: "a", outcome: "missed" }),
    result({ id: "gone", outcome: "missed" }),
    result({ id: "clean-1", kind: "clean", outcome: "passed", quietDays: 7 }),
  ]);
  const current = report(
    [
      result({ id: "a", outcome: "caught", blocking: [finding("P2", "src/a.ts:41")] }),
      result({ id: "clean-1", kind: "clean", outcome: "passed", quietDays: 7 }),
      result({ id: "new", outcome: "missed" }),
    ],
    { failOn: "P2" },
  );
  const text = renderReport(current, baseline);
  expect(text).toContain("## Compared with the baseline");
  expect(text).toContain("Changed: `failOn` P1 → P2.");
  expect(text).toContain("| a | missed | caught |");
  expect(text).toContain("| gone | missed | not run |");
  expect(text).toContain("| new | not in the baseline | missed |");
  expect(text).not.toContain("| clean-1 | passed | passed |");
  expect(text).toContain(
    "| Clean pull requests | 1 Paws squashes, quiet for 7 days; 0 merged by hand |",
  );
  expect(text).toContain("| clean-1 | paws | 7 | candidate | passed |");
  expect(text).toContain("- **P2** `src/a.ts:41`: wrong");
  expect(renderReport(current)).not.toContain("Compared with the baseline");
  expect(renderReport(baseline, baseline)).toContain(
    "Every case has the same outcome as in the baseline.",
  );
});

test("codex events give the final message, the session and the tokens", () => {
  const events = [
    '{"type":"thread.started","thread_id":"t-1"}',
    "not json",
    '{"type":"item.completed","item":{"type":"agent_message","text":"draft"}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"[]"}}',
    '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":4,"output_tokens":2,"reasoning_output_tokens":3}}',
  ].join("\n");
  expect(parseCodexEvents(events)).toEqual({
    sessionId: "t-1",
    text: "[]",
    usage: { input: 10, cached: 4, output: 5 },
  });
  expect(parseCodexEvents('{"type":"turn.failed","error":{"message":"quota"}}').error).toBe(
    "quota",
  );
});

test("the codex agent runs read-only in the checkout and adds up usage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "review-score-codex-"));
  const bin = join(dir, "codex");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > "${dir}/args"`,
      `cat > "${dir}/stdin"`,
      `echo '{"type":"thread.started","thread_id":"t-9"}'`,
      `echo '{"type":"item.completed","item":{"type":"agent_message","text":"[]"}}'`,
      `echo '{"type":"turn.completed","usage":{"input_tokens":7,"cached_input_tokens":1,"output_tokens":2}}'`,
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  const usage = { input: 0, cached: 0, output: 0 };
  const agent = codexAgent({ bin, model: "gpt-x", effort: "high", timeoutMs: 10_000, usage });
  const reply = await agent.run({ itemId: "r", worktree: dir, prompt: "review", readOnly: true });
  expect(reply).toEqual({ sessionId: "t-9", model: "gpt-x", text: "[]" });
  await agent.run({
    itemId: "r",
    worktree: dir,
    prompt: "again",
    readOnly: true,
    sessionId: "t-9",
  });
  expect(usage).toEqual({ input: 14, cached: 2, output: 4 });
  const args = readFileSync(join(dir, "args"), "utf8").split("\n");
  expect(args.slice(0, 3)).toEqual(["exec", "resume", "t-9"]);
  expect(args).toContain("read-only");
  expect(args).toContain('model_reasoning_effort="high"');
  expect(args[args.indexOf("-C") + 1]).toBe(dir);
  expect(readFileSync(join(dir, "stdin"), "utf8")).toBe("again");
});

function repo(): { dir: string; commits: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "review-score-repo-"));
  const run = (args: string[]) =>
    spawnSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    }).stdout.trim();
  run(["init", "-q", "-b", "main"]);
  run(["commit", "-q", "--allow-empty", "-m", "root"]);
  const commits: string[] = [];
  for (const [index, lines] of [5, 30, 3].entries()) {
    writeFileSync(join(dir, `f${index}.ts`), "x\n".repeat(lines));
    writeFileSync(join(dir, "bun.lock"), "lock\n".repeat(100 * (index + 1)));
    run(["add", "."]);
    run(["commit", "-q", "-m", `c${index}`]);
    commits.push(run(["rev-parse", "HEAD"]));
  }
  return { dir, commits };
}

test("replayRange falls back to the squash when the candidate head is missing", () => {
  const { dir, commits } = repo();
  const git = gitIn(dir);
  const [first, second] = commits as [string, string];
  expect(replayRange(git, { pr: 1, base: first, head: second, mergeCommit: second })).toEqual({
    base: first,
    head: second,
    diff: "candidate",
  });
  expect(
    replayRange(git, { pr: 1, base: first, head: "f".repeat(40), mergeCommit: second }),
  ).toEqual({ base: first, head: second, diff: "squash" });
  expect(() =>
    replayRange(git, { pr: 1, base: first, head: "f".repeat(40), mergeCommit: "e".repeat(40) }),
  ).toThrow("not in this clone");
});

test("pickClean keeps old, large Paws squashes that no fix touched in the quiet window", () => {
  const { dir, commits } = repo();
  const git = gitIn(dir);
  const now = new Date("2026-10-27T00:00:00Z");
  const body = (n: number) => `Base: ${"a".repeat(39)}${n}\nHead: ${"b".repeat(39)}${n}`;
  const pull = (number: number, commit: string, mergedAt: string, author = "paws-helper[bot]") =>
    ({
      number,
      title: `PR ${number}`,
      body: body(number),
      author,
      mergedAt,
      mergeCommit: commit,
    }) satisfies MergedPull;
  const pulls = [
    pull(1, commits[0]!, "2026-10-10T00:00:00Z"), // 5 lines: too small
    pull(2, commits[1]!, "2026-10-11T00:00:00Z"), // 30 lines
    pull(3, commits[1]!, "2026-10-12T00:00:00Z"), // fixed two days later
    pull(4, commits[1]!, "2026-10-13T00:00:00Z"), // changed, not fixed
    pull(5, commits[1]!, "2026-10-14T00:00:00Z", "Pascal Matthiesen"),
    pull(6, commits[1]!, "2026-10-25T00:00:00Z"), // too recent
    pull(7, commits[1]!, "2026-10-15T00:00:00Z"), // an escape original
  ];
  const candidate = (original: number, kind: Candidate["kind"], mergedAt: string): Candidate => ({
    original: { pr: original, title: "", base: "", head: "", mergeCommit: "" },
    fix: { pr: 99, title: "", mergeCommit: "", mergedAt },
    kind,
    bug: "",
    lines: [],
  });
  const picked = pickClean(
    git,
    pulls,
    [
      candidate(2, "fix", "2026-10-20T00:00:00Z"),
      candidate(3, "fix", "2026-10-14T00:00:00Z"),
      candidate(4, "change", "2026-10-14T00:00:00Z"),
    ],
    {
      app: "paws-helper",
      author: "paws",
      now,
      quietDays: 7,
      minLines: 20,
      count: 16,
      exclude: new Set([7]),
    },
  );
  expect(picked.map((entry) => entry.id)).toEqual(["clean-2", "clean-4"]);
  expect(picked[0]).toMatchObject({
    changedLines: 30,
    quietDays: 7,
    pickedAt: "2026-10-27",
    author: "paws",
    original: { base: `${"a".repeat(39)}2`, head: `${"b".repeat(39)}2` },
  });
  const human = pickClean(git, pulls, [], {
    app: "paws-helper",
    author: "human",
    from: "2026-10-14",
    to: "2026-10-14",
    now,
    quietDays: 7,
    minLines: 20,
    count: 16,
    exclude: new Set(),
  });
  expect(human).toEqual([
    expect.objectContaining({
      id: "clean-5",
      author: "human",
      original: expect.objectContaining({ base: commits[0], head: commits[1] }),
    }),
  ]);
  const outside = pickClean(git, pulls, [], {
    app: "paws-helper",
    author: "human",
    from: "2026-10-15",
    now,
    quietDays: 7,
    minLines: 20,
    count: 16,
    exclude: new Set(),
  });
  expect(outside).toEqual([]);
});
