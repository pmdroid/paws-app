import { expect, test } from "bun:test";
import {
  type EarlierFinding,
  reaskArgv,
  REVIEW_COMMAND_RULE,
  REVIEW_INSTRUCTIONS_BYTES,
  reviewArgv,
  reviewInstructions,
} from "../src/closeout-spec";

const base = "a".repeat(40);
const head = "b".repeat(40);
const brief = "Issue: PAS-1 Clear `cancel_requested` when the item resumes.";
const common = { model: "review-model", base, head, schemaPath: "/tmp/s.json", schema: "{}" };

const finding = (index: number, explanation = `problem ${index}`): EarlierFinding => ({
  severity: "P1",
  location: `src/app.ts:${index}`,
  explanation,
  head: "c".repeat(40),
  status: index === 0 ? "open" : "fixed",
});

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

test("a first round's instructions carry only the brief and the rule", () => {
  const instructions = reviewInstructions({ brief, earlier: [] });
  expect(instructions).toBe(`# Issue brief\n${brief}\n\n# Review rule\n${REVIEW_COMMAND_RULE}`);
  expect(reviewInstructions({})).toBe(`# Review rule\n${REVIEW_COMMAND_RULE}`);
});

test("a later round's instructions list the earlier findings after the brief and the rule", () => {
  const instructions = reviewInstructions({ brief, earlier: [finding(0), finding(1)] });
  expect(instructions).toStartWith(`# Issue brief\n${brief}\n\n# Review rule\n`);
  expect(instructions).toContain("# Earlier findings");
  expect(instructions).toContain(`- open, P1 at src/app.ts:0 (head cccccccccccc): problem 0`);
  expect(instructions).toContain(`- fixed, P1 at src/app.ts:1 (head cccccccccccc): problem 1`);
});

test("instructions stay under 8 KiB and keep the latest round's findings when trimming", () => {
  const long = "é".repeat(300);
  const earlier = Array.from({ length: 50 }, (_, index) => finding(index, long));
  const instructions = reviewInstructions({ brief: "ü".repeat(10_000), earlier });
  expect(bytes(instructions)).toBeLessThanOrEqual(REVIEW_INSTRUCTIONS_BYTES);
  expect(instructions).toContain(REVIEW_COMMAND_RULE);
  expect(instructions).toContain("src/app.ts:0 ");
  expect(instructions).not.toContain("src/app.ts:49 ");
  const kept = instructions.split("\n")[1]!;
  expect(kept).toEndWith("…");
  expect(bytes(kept)).toBeGreaterThanOrEqual(4 * 1024);
  expect(kept).not.toContain("�");

  const roomy = reviewInstructions({ brief: "x".repeat(10_000), earlier: [finding(0)] });
  expect(bytes(roomy)).toBeLessThanOrEqual(REVIEW_INSTRUCTIONS_BYTES);
  expect(bytes(roomy)).toBeGreaterThan(REVIEW_INSTRUCTIONS_BYTES - 8);
  expect(roomy).toContain("src/app.ts:0 ");
});

test("Codex gets the instructions as its review prompt, with the range in place of --base", () => {
  const instructions = reviewInstructions({ brief });
  const argv = reviewArgv({ agent: "codex", ...common, instructions });
  expect(argv.slice(0, 3)).toEqual(["codex", "exec", "review"]);
  expect(argv).not.toContain("--base");
  const prompt = argv.at(-1)!;
  expect(prompt).toStartWith(
    `Review the code changes from base commit ${base} to head commit ${head}.`,
  );
  expect(prompt).toContain(`git diff ${base}..${head}`);
  expect(prompt).toEndWith(instructions);
  expect(argv.at(-2)).toBe("/tmp/s.json");

  expect(reviewArgv({ agent: "codex", ...common })).toEqual([
    "codex",
    "exec",
    "review",
    "--base",
    base,
    "--model",
    "review-model",
    "--json",
    "--output-schema",
    "/tmp/s.json",
  ]);
});

test("Claude gets the instructions with --append-system-prompt on the review and the re-ask", () => {
  const instructions = reviewInstructions({ brief, earlier: [finding(0)] });
  const argv = reviewArgv({ agent: "claude", ...common, instructions });
  const flag = argv.indexOf("--append-system-prompt");
  expect(flag).toBeGreaterThan(0);
  expect(argv[flag + 1]).toBe(instructions);
  expect(argv.at(-1)).toBe(`/code-review ${base}..${head}`);

  const reask = reaskArgv({
    agent: "claude",
    ...common,
    session: "session-1",
    prompt: "Return the findings array.",
    instructions,
  });
  expect(reask[reask.indexOf("--append-system-prompt") + 1]).toBe(instructions);
  expect(reask.at(-1)).toBe("Return the findings array.");

  const resumed = reaskArgv({
    agent: "codex",
    ...common,
    session: "thread-1",
    prompt: "Return the findings array.",
    instructions,
  });
  expect(resumed.join(" ")).not.toContain(REVIEW_COMMAND_RULE);
  expect(reviewArgv({ agent: "claude", ...common })).not.toContain("--append-system-prompt");
});
