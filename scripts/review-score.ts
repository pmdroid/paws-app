/**
 * Score the independent reviewer against review escapes and clean pull requests.
 *
 * Replays one review item from `.agents/closeout.yaml` (skill, `scope` and
 * `failOn`) with Paws's own reviewer port, so the prompt, the re-ask and the
 * finding schema are the ones the gate uses. The skill is read from the
 * working tree, so an edited skill is scored before it is committed. The model
 * runs through `codex exec`, the reviewer's default agent.
 *
 * Cases come from evals/review-escapes.jsonl (recall) and
 * evals/review-clean.jsonl (false positives). The report goes to `reports/`
 * as Markdown and JSON, and compares against reports/review-score-baseline.json
 * when that exists. It calls real models, so it is a script, not a test; see
 * docs/closeout.md.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  createReviewer,
  parseLocation,
  preExistingFindings,
  type Finding,
  type ResolvedReview,
  type ReviewAgent,
  type ReviewScope,
  type Severity,
} from "../src/closeout-spec";
import {
  closeoutTrailer,
  findCandidates,
  gitIn,
  isAppAuthor,
  listPulls,
  readEscapes,
  type Candidate,
  type Git,
  type MergedPull,
  type ReviewEscape,
} from "./review-escapes";

export type CleanCase = {
  id: string;
  original: { pr: number; title: string; base: string; head: string; mergeCommit: string };
  mergedAt: string;
  /** Added plus removed lines in the squash, lockfiles and snapshots left out. */
  changedLines: number;
  /** No later fix or revert changed or removed its lines for this many days after the merge. */
  quietDays: number;
  pickedAt: string;
};

export type ReviewItem = {
  id: string;
  skill: string;
  failOn: Severity;
  scope: ReviewScope;
};

export type ReviewerConfig = ReviewItem & {
  /** sha256 of the skill folder's files, so a report names the exact skill text. */
  skillDigest: string;
  model: string;
  effort: string;
  tolerance: number;
};

export type Usage = { input: number; cached: number; output: number };

export type Price = { input: number; cached: number; output: number };

export type CaseKind = "escape" | "clean";

/**
 * `caught`: a blocking finding within `tolerance` lines of the bug.
 * `elsewhere`: the review would have rejected, but not at the bug.
 * `missed`: nothing at or above failOn. `rejected` and `passed` are the clean outcomes.
 * `error`: the review did not record findings; it is left out of the rates.
 */
export type Outcome = "caught" | "elsewhere" | "missed" | "rejected" | "passed" | "error";

export type CaseResult = {
  id: string;
  kind: CaseKind;
  pr: number;
  confidence?: "confirmed" | "likely";
  quietDays?: number;
  /** `candidate` replays base..head as Closeout saw it; `squash` replays the merge commit. */
  diff: "candidate" | "squash";
  outcome: Outcome;
  reason?: string;
  durationMs: number;
  usage: Usage;
  costUsd?: number;
  blocking: Finding[];
  findings: number;
  /** Escapes only: the most severe finding on a changed line near the bug, at any severity. */
  nearSeverity?: Severity;
};

export type ScoreReport = {
  version: 1;
  generatedAt: string;
  config: ReviewerConfig;
  price?: Price;
  results: CaseResult[];
};

const SEVERITY_RANK: Record<Severity, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
const SKIPPED_FILES = [/(^|\/)bun\.lockb?$/, /(^|\/)package-lock\.json$/, /\.snap$/];
const DAY = 86_400_000;

export function meetsFailOn(severity: Severity, failOn: Severity): boolean {
  return SEVERITY_RANK[severity] <= SEVERITY_RANK[failOn];
}

/** The review item named `id`, with the defaults the policy resolver applies. */
export function readReviewItem(policyText: string, id: string): ReviewItem {
  const policy = parseYaml(policyText) as { items?: Array<Record<string, unknown>> };
  const item = policy.items?.find((entry) => entry.id === id);
  if (!item) throw new Error(`no item ${id} in the Closeout policy`);
  if (item.kind !== "review") throw new Error(`item ${id} is ${String(item.kind)}, not a review`);
  if (typeof item.skill !== "string") throw new Error(`item ${id} has no skill`);
  const failOn = (item.failOn ?? "P1") as Severity;
  if (!(failOn in SEVERITY_RANK)) throw new Error(`item ${id} has failOn ${String(failOn)}`);
  const scope = (item.scope ?? "candidate") as ReviewScope;
  return { id, skill: item.skill, failOn, scope };
}

/** Every file in the skill's folder, keyed by repository path, read from the working tree. */
export function readSkillFiles(root: string, skill: string): Map<string, Uint8Array> {
  const folder = join(root, skill.slice(0, skill.lastIndexOf("/")));
  const files = new Map<string, Uint8Array>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.set(relative(root, path), readFileSync(path));
    }
  };
  walk(folder);
  if (!files.has(skill)) throw new Error(`${skill} is not in the working tree`);
  return files;
}

export function skillDigest(files: ReadonlyMap<string, Uint8Array>): string {
  const hash = createHash("sha256");
  for (const path of [...files.keys()].sort()) {
    hash.update(path).update("\0").update(files.get(path)!).update("\0");
  }
  return hash.digest("hex");
}

export function readClean(path: string): CleanCase[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as CleanCase);
}

/** Findings that would fail the review: at or above failOn and on a line the change touched. */
export function blockingFindings(
  findings: readonly Finding[],
  preExisting: readonly Finding[],
  failOn: Severity,
): Finding[] {
  const skipped = new Set(preExisting);
  return findings.filter(
    (finding) => meetsFailOn(finding.severity, failOn) && !skipped.has(finding),
  );
}

/** True when a finding names the escape's file within `tolerance` lines of its line. */
export function findsEscape(
  finding: Finding,
  escape: Pick<ReviewEscape, "file" | "line">,
  tolerance: number,
): boolean {
  const location = parseLocation(finding.location);
  if (!location) return false;
  return location.path === escape.file && Math.abs(location.line - escape.line) <= tolerance;
}

export function escapeOutcome(
  blocking: readonly Finding[],
  escape: Pick<ReviewEscape, "file" | "line">,
  tolerance: number,
): Outcome {
  if (blocking.some((finding) => findsEscape(finding, escape, tolerance))) return "caught";
  return blocking.length > 0 ? "elsewhere" : "missed";
}

/** The most severe finding near the escape, so a lower failOn can be judged without a rerun. */
export function nearSeverity(
  findings: readonly Finding[],
  escape: Pick<ReviewEscape, "file" | "line">,
  tolerance: number,
): Severity | undefined {
  return findings
    .filter((finding) => findsEscape(finding, escape, tolerance))
    .map((finding) => finding.severity)
    .sort((a, b) => SEVERITY_RANK[a] - SEVERITY_RANK[b])[0];
}

export function cleanOutcome(blocking: readonly Finding[]): Outcome {
  return blocking.length > 0 ? "rejected" : "passed";
}

export function costOf(usage: Usage, price: Price | undefined): number | undefined {
  if (!price) return undefined;
  const fresh = Math.max(0, usage.input - usage.cached);
  return (fresh * price.input + usage.cached * price.cached + usage.output * price.output) / 1e6;
}

/** Added plus removed lines between two commits, without lockfiles or snapshots. */
export function changedLines(git: Git, from: string, to: string): number {
  let total = 0;
  for (const row of git(["diff", "--numstat", "--no-renames", from, to]).split("\n")) {
    const [added, removed, path] = row.split("\t");
    if (!path || SKIPPED_FILES.some((pattern) => pattern.test(path))) continue;
    total += (Number(added) || 0) + (Number(removed) || 0);
  }
  return total;
}

/**
 * Paws squashes that make a clean set: merged at least `quietDays` ago, with a
 * Closeout trailer, at least `minLines` changed lines, not the original of an
 * escape, and no later fix or revert changing or removing their lines within
 * `quietDays` of the merge. `count` of them, spread evenly over the range.
 */
export function pickClean(
  git: Git,
  pulls: readonly MergedPull[],
  candidates: readonly Candidate[],
  options: {
    app: string;
    now: Date;
    quietDays: number;
    minLines: number;
    count: number;
    exclude: ReadonlySet<number>;
  },
): CleanCase[] {
  const touched = new Set<number>();
  const merged = new Map(pulls.map((pull) => [pull.number, pull.mergedAt]));
  for (const candidate of candidates) {
    // A refactor or a new requirement on the same lines is not a fix.
    if (candidate.kind === "change") continue;
    const at = merged.get(candidate.original.pr);
    if (!at) continue;
    const gap = Date.parse(candidate.fix.mergedAt) - Date.parse(at);
    if (gap <= options.quietDays * DAY) touched.add(candidate.original.pr);
  }
  const cutoff = options.now.getTime() - options.quietDays * DAY;
  const eligible: CleanCase[] = [];
  for (const pull of [...pulls].sort((a, b) => a.mergedAt.localeCompare(b.mergedAt))) {
    if (!isAppAuthor(pull.author, options.app)) continue;
    if (Date.parse(pull.mergedAt) > cutoff) continue;
    if (touched.has(pull.number) || options.exclude.has(pull.number)) continue;
    const trailer = closeoutTrailer(pull.body);
    if (!trailer.base || !trailer.head) continue;
    const lines = changedLines(git, `${pull.mergeCommit}^1`, pull.mergeCommit);
    if (lines < options.minLines) continue;
    eligible.push({
      id: `clean-${pull.number}`,
      original: {
        pr: pull.number,
        title: pull.title,
        base: trailer.base,
        head: trailer.head,
        mergeCommit: pull.mergeCommit,
      },
      mergedAt: pull.mergedAt,
      changedLines: lines,
      quietDays: options.quietDays,
      pickedAt: options.now.toISOString().slice(0, 10),
    });
  }
  return spread(eligible, options.count);
}

/** `count` items at evenly spaced positions, first and last included. */
export function spread<T>(items: readonly T[], count: number): T[] {
  if (items.length <= count) return [...items];
  if (count <= 1) return items.slice(0, count);
  const picked: T[] = [];
  for (let index = 0; index < count; index += 1) {
    picked.push(items[Math.round((index * (items.length - 1)) / (count - 1))]!);
  }
  return picked;
}

type Rate = { hits: number; total: number };

export type Summary = {
  recall: Rate;
  recallLikely: Rate;
  elsewhere: number;
  belowFailOn: number;
  falsePositives: Rate;
  errors: number;
  reviews: number;
  medianMs: number;
  totalMs: number;
  usage: Usage;
  costUsd?: number;
};

export function summarize(results: readonly CaseResult[]): Summary {
  const scored = results.filter((result) => result.outcome !== "error");
  const escapes = scored.filter((result) => result.kind === "escape");
  const confirmed = escapes.filter((result) => result.confidence !== "likely");
  const likely = escapes.filter((result) => result.confidence === "likely");
  const clean = scored.filter((result) => result.kind === "clean");
  const durations = results.map((result) => result.durationMs).sort((a, b) => a - b);
  const usage = results.reduce(
    (sum, result) => ({
      input: sum.input + result.usage.input,
      cached: sum.cached + result.usage.cached,
      output: sum.output + result.usage.output,
    }),
    { input: 0, cached: 0, output: 0 },
  );
  const priced = results.every((result) => result.costUsd !== undefined);
  return {
    recall: { hits: confirmed.filter(caught).length, total: confirmed.length },
    recallLikely: { hits: likely.filter(caught).length, total: likely.length },
    elsewhere: escapes.filter((result) => result.outcome === "elsewhere").length,
    belowFailOn: escapes.filter((result) => !caught(result) && result.nearSeverity).length,
    falsePositives: {
      hits: clean.filter((result) => result.outcome === "rejected").length,
      total: clean.length,
    },
    errors: results.length - scored.length,
    reviews: results.length,
    medianMs: median(durations),
    totalMs: durations.reduce((sum, value) => sum + value, 0),
    usage,
    ...(priced && results.length > 0
      ? { costUsd: results.reduce((sum, result) => sum + (result.costUsd ?? 0), 0) }
      : {}),
  };
}

function caught(result: CaseResult): boolean {
  return result.outcome === "caught";
}

function median(sorted: readonly number[]): number {
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function rate(value: Rate): string {
  if (value.total === 0) return "–";
  return `${value.hits} of ${value.total} (${Math.round((100 * value.hits) / value.total)}%)`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(0)} s`;
}

function tokens(usage: Usage): string {
  return `${usage.input.toLocaleString("en-US")} in (${usage.cached.toLocaleString("en-US")} cached), ${usage.output.toLocaleString("en-US")} out`;
}

function dollars(value: number | undefined): string {
  return value === undefined ? "not priced" : `$${value.toFixed(2)}`;
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

const OUTCOME_TEXT: Record<Outcome, string> = {
  caught: "caught",
  elsewhere: "rejected elsewhere",
  missed: "missed",
  rejected: "rejected",
  passed: "passed",
  error: "error",
};

export function renderReport(report: ScoreReport, baseline?: ScoreReport): string {
  const { config } = report;
  const summary = summarize(report.results);
  const perReview = summary.reviews > 0 ? summary.totalMs / summary.reviews : 0;
  const quiet = [
    ...new Set(report.results.flatMap((result) => (result.quietDays ? [result.quietDays] : []))),
  ];
  const lines = [
    `# Reviewer score: ${config.id}`,
    "",
    `Generated ${report.generatedAt} by \`bun scripts/review-score.ts\`. See [Reviewer score](../docs/closeout.md#reviewer-score).`,
    "",
    "| Setting | Value |",
    "| --- | --- |",
    `| Skill | \`${config.skill}\` (sha256 \`${config.skillDigest.slice(0, 12)}\`) |`,
    `| Model | \`${config.model}\`, effort \`${config.effort}\` |`,
    `| Scope | \`${config.scope}\` |`,
    `| failOn | \`${config.failOn}\` |`,
    `| Caught when | a finding at or above \`${config.failOn}\` is within ${config.tolerance} lines of the bug |`,
    `| Clean pull requests | quiet for ${quiet.length ? quiet.join(", ") : "–"} days after the merge |`,
    `| Price per million tokens | ${report.price ? `$${report.price.input} in, $${report.price.cached} cached, $${report.price.output} out` : "not set (pass --price)"} |`,
    "",
    "## Summary",
    "",
    "| Measure | Value |",
    "| --- | --- |",
    `| Recall, confirmed escapes | ${rate(summary.recall)} |`,
    `| Recall, likely escapes | ${rate(summary.recallLikely)} |`,
    `| Escapes rejected, but not at the bug | ${summary.elsewhere} |`,
    `| Escapes found at the bug below failOn | ${summary.belowFailOn} |`,
    `| False positives, clean pull requests rejected | ${rate(summary.falsePositives)} |`,
    `| Reviews that recorded no findings (left out) | ${summary.errors} |`,
    `| Time per review | median ${seconds(summary.medianMs)}, mean ${seconds(perReview)} |`,
    `| Tokens, all ${summary.reviews} reviews | ${tokens(summary.usage)} |`,
    `| Cost | ${summary.costUsd === undefined ? "not priced" : `${dollars(summary.costUsd)} in all, ${dollars(summary.costUsd / Math.max(1, summary.reviews))} per review`} |`,
    "",
  ];
  if (baseline) lines.push(...comparison(report, baseline), "");
  lines.push(
    "## Escapes",
    "",
    "| Case | Confidence | Diff | Outcome | Near the bug | Time | Tokens | Blocking findings |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...report.results
      .filter((result) => result.kind === "escape")
      .map((result) =>
        caseRow(
          result,
          `${result.confidence ?? "confirmed"} | ${result.diff} | ${OUTCOME_TEXT[result.outcome]} | ${result.nearSeverity ?? "–"}`,
        ),
      ),
    "",
    "## Clean pull requests",
    "",
    "| Case | Quiet days | Diff | Outcome | Time | Tokens | Blocking findings |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...report.results
      .filter((result) => result.kind === "clean")
      .map((result) =>
        caseRow(
          result,
          `${result.quietDays ?? "–"} | ${result.diff} | ${OUTCOME_TEXT[result.outcome]}`,
        ),
      ),
    "",
  );
  const rejected = report.results.filter(
    (result) => result.blocking.length > 0 || result.outcome === "error",
  );
  if (rejected.length > 0) {
    lines.push("## Findings", "");
    for (const result of rejected) {
      lines.push(`### ${result.id} (${OUTCOME_TEXT[result.outcome]})`, "");
      if (result.reason) lines.push(`Error: ${cell(result.reason)}`, "");
      for (const finding of result.blocking) {
        lines.push(
          `- **${finding.severity}** \`${finding.location}\`: ${cell(finding.explanation).slice(0, 600)}`,
        );
      }
      lines.push("");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function caseRow(result: CaseResult, columns: string): string {
  const where = result.blocking.map((finding) => `${finding.severity} \`${finding.location}\``);
  return `| ${result.id} | ${columns} | ${seconds(result.durationMs)} | ${(result.usage.input + result.usage.output).toLocaleString("en-US")} | ${where.join(", ") || "–"} |`;
}

function comparison(report: ScoreReport, baseline: ScoreReport): string[] {
  const now = summarize(report.results);
  const before = summarize(baseline.results);
  const changes: string[] = [];
  for (const key of ["skillDigest", "model", "effort", "scope", "failOn", "tolerance"] as const) {
    if (report.config[key] !== baseline.config[key]) {
      changes.push(`\`${key}\` ${String(baseline.config[key])} → ${String(report.config[key])}`);
    }
  }
  const lines = [
    `## Compared with the baseline`,
    "",
    `Baseline generated ${baseline.generatedAt}. ${changes.length ? `Changed: ${changes.join(", ")}.` : "Same skill, model, scope and failOn."}`,
    "",
    "| Measure | Baseline | This run |",
    "| --- | --- | --- |",
    `| Recall, confirmed escapes | ${rate(before.recall)} | ${rate(now.recall)} |`,
    `| Recall, likely escapes | ${rate(before.recallLikely)} | ${rate(now.recallLikely)} |`,
    `| Escapes found at the bug below failOn | ${before.belowFailOn} | ${now.belowFailOn} |`,
    `| False positives | ${rate(before.falsePositives)} | ${rate(now.falsePositives)} |`,
    `| Reviews that recorded no findings | ${before.errors} | ${now.errors} |`,
    `| Median time per review | ${seconds(before.medianMs)} | ${seconds(now.medianMs)} |`,
    `| Tokens per review | ${perReviewTokens(before)} | ${perReviewTokens(now)} |`,
    `| Cost per review | ${before.costUsd === undefined ? "not priced" : dollars(before.costUsd / Math.max(1, before.reviews))} | ${now.costUsd === undefined ? "not priced" : dollars(now.costUsd / Math.max(1, now.reviews))} |`,
  ];
  const previous = new Map(baseline.results.map((result) => [result.id, result]));
  const flips = report.results.flatMap((result) => {
    const old = previous.get(result.id);
    if (!old) return [`| ${result.id} | not in the baseline | ${OUTCOME_TEXT[result.outcome]} |`];
    return old.outcome === result.outcome
      ? []
      : [`| ${result.id} | ${OUTCOME_TEXT[old.outcome]} | ${OUTCOME_TEXT[result.outcome]} |`];
  });
  const current = new Set(report.results.map((result) => result.id));
  for (const old of baseline.results) {
    if (!current.has(old.id)) flips.push(`| ${old.id} | ${OUTCOME_TEXT[old.outcome]} | not run |`);
  }
  lines.push("");
  if (flips.length === 0) lines.push("Every case has the same outcome as in the baseline.");
  else lines.push("| Case | Baseline | This run |", "| --- | --- | --- |", ...flips);
  return lines;
}

function perReviewTokens(summary: Summary): string {
  if (summary.reviews === 0) return "–";
  const total = summary.usage.input + summary.usage.output;
  return Math.round(total / summary.reviews).toLocaleString("en-US");
}

/** One `codex exec` turn, read-only, with its token usage. */
export function codexAgent(options: {
  bin: string;
  model?: string;
  effort: string;
  timeoutMs: number;
  usage: Usage;
}): ReviewAgent & { lastModel?: string } {
  const agent: ReviewAgent & { lastModel?: string } = {
    async run(request) {
      const args = [
        "exec",
        ...(request.sessionId ? ["resume", request.sessionId] : []),
        "--json",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "-C",
        request.worktree,
        "-c",
        `model_reasoning_effort=${JSON.stringify(options.effort)}`,
        ...(options.model ? ["-m", options.model] : []),
        "-",
      ];
      const output = await runProcess(options.bin, args, request.prompt, options.timeoutMs);
      const turn = parseCodexEvents(output);
      options.usage.input += turn.usage.input;
      options.usage.cached += turn.usage.cached;
      options.usage.output += turn.usage.output;
      if (turn.error && !turn.text) throw new Error(`codex: ${turn.error}`);
      const model = options.model ?? sessionModel(turn.sessionId);
      if (model) agent.lastModel = model;
      return { sessionId: turn.sessionId, ...(model ? { model } : {}), text: turn.text };
    },
  };
  return agent;
}

export function parseCodexEvents(output: string): {
  sessionId: string;
  text: string;
  usage: Usage;
  error?: string;
} {
  let sessionId = "";
  let text = "";
  let error: string | undefined;
  const usage: Usage = { input: 0, cached: 0, output: 0 };
  for (const line of output.split("\n")) {
    if (!line.startsWith("{")) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === "thread.started" && typeof event.thread_id === "string") {
      sessionId = event.thread_id;
    }
    const item = event.item as { type?: string; text?: string } | undefined;
    if (event.type === "item.completed" && item?.type === "agent_message") {
      text = item.text ?? "";
    }
    if (event.type === "turn.completed") {
      const reported = event.usage as Record<string, number> | undefined;
      usage.input += reported?.input_tokens ?? 0;
      usage.cached += reported?.cached_input_tokens ?? 0;
      usage.output += (reported?.output_tokens ?? 0) + (reported?.reasoning_output_tokens ?? 0);
    }
    if (event.type === "turn.failed" || event.type === "error") {
      const message = (event.error as { message?: string } | undefined)?.message ?? event.message;
      error = typeof message === "string" ? message : JSON.stringify(event);
    }
  }
  return { sessionId, text, usage, ...(error ? { error } : {}) };
}

/** The model Codex recorded for a session, from its rollout file. */
function sessionModel(sessionId: string): string | undefined {
  if (!sessionId) return undefined;
  const home = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const sessions = join(home, "sessions");
  if (!existsSync(sessions)) return undefined;
  const stack = [sessions];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.name.includes(sessionId)) {
        return /"model":"([^"]+)"/.exec(readFileSync(path, "utf8"))?.[1];
      }
    }
  }
  return undefined;
}

function runProcess(bin: string, args: string[], input: string, timeoutMs: number) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`codex timed out after ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 || stdout.includes('"turn.completed"')) resolve(stdout);
      else reject(new Error(`codex exited ${code}: ${stderr.trim().slice(-500)}`));
    });
    child.stdin.end(input);
  });
}

type ReplayCase = {
  id: string;
  kind: CaseKind;
  original: { pr: number; base: string; head: string; mergeCommit: string };
  escape?: ReviewEscape;
  quietDays?: number;
};

/** base..head when both are in the clone; otherwise the squash, which is the patch as merged. */
export function replayRange(
  git: Git,
  original: ReplayCase["original"],
): { base: string; head: string; diff: CaseResult["diff"] } {
  const present = (commit: string) => {
    try {
      git(["cat-file", "-e", `${commit}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  };
  if (present(original.base) && present(original.head)) {
    return { base: original.base, head: original.head, diff: "candidate" };
  }
  if (!present(original.mergeCommit)) {
    throw new Error(`${original.mergeCommit} is not in this clone; fetch main first`);
  }
  const base = git(["rev-parse", `${original.mergeCommit}^1`]).trim();
  return { base, head: original.mergeCommit, diff: "squash" };
}

async function replay(
  root: string,
  git: Git,
  item: ReviewItem,
  config: ReviewerConfig,
  skillFiles: ReadonlyMap<string, Uint8Array>,
  agentOptions: { bin: string; model?: string; timeoutMs: number },
  price: Price | undefined,
  entry: ReplayCase,
): Promise<CaseResult & { model?: string }> {
  const usage: Usage = { input: 0, cached: 0, output: 0 };
  const agent = codexAgent({ ...agentOptions, effort: config.effort, usage });
  const started = Date.now();
  const base = {
    id: entry.id,
    kind: entry.kind,
    pr: entry.original.pr,
    ...(entry.escape ? { confidence: entry.escape.confidence } : {}),
    ...(entry.quietDays ? { quietDays: entry.quietDays } : {}),
  };
  let range: ReturnType<typeof replayRange>;
  try {
    range = replayRange(git, entry.original);
  } catch (error) {
    return failed(base, "squash", error, 0, usage, price);
  }
  const resolved: ResolvedReview = {
    id: item.id,
    kind: "review",
    gate: "beforePR",
    skill: item.skill,
    independence: { differentSession: true, differentModel: true },
    failOn: item.failOn,
    scope: item.scope,
  };
  const reviewer = createReviewer(agent, { model: config.model });
  let result: Awaited<ReturnType<typeof reviewer.review>>;
  try {
    result = await reviewer.review({
      skillFiles,
      item: resolved,
      candidate: { session: "review-score", model: "review-score", provider: "paws" },
      base: range.base,
      head: range.head,
      policyDigest: "review-score",
      worktree: root,
    });
  } catch (error) {
    return failed(base, range.diff, error, Date.now() - started, usage, price);
  }
  const durationMs = Date.now() - started;
  const costUsd = costOf(usage, price);
  if (result.status === "invalid") {
    return {
      ...base,
      diff: range.diff,
      outcome: "error",
      reason: result.reason,
      durationMs,
      usage,
      ...(costUsd !== undefined ? { costUsd } : {}),
      blocking: [],
      findings: 0,
      ...(agent.lastModel ? { model: agent.lastModel } : {}),
    };
  }
  const preExisting = await preExistingFindings(root, range.base, range.head, result.findings);
  const blocking = blockingFindings(result.findings, preExisting, item.failOn);
  const skipped = new Set(preExisting);
  const near = entry.escape
    ? nearSeverity(
        result.findings.filter((finding) => !skipped.has(finding)),
        entry.escape,
        config.tolerance,
      )
    : undefined;
  return {
    ...base,
    diff: range.diff,
    outcome: entry.escape
      ? escapeOutcome(blocking, entry.escape, config.tolerance)
      : cleanOutcome(blocking),
    durationMs,
    usage,
    ...(costUsd !== undefined ? { costUsd } : {}),
    blocking,
    findings: result.findings.length,
    ...(near ? { nearSeverity: near } : {}),
    ...(agent.lastModel ? { model: agent.lastModel } : {}),
  };
}

function failed(
  base: Pick<CaseResult, "id" | "kind" | "pr" | "confidence" | "quietDays">,
  diff: CaseResult["diff"],
  error: unknown,
  durationMs: number,
  usage: Usage,
  price: Price | undefined,
): CaseResult {
  const costUsd = costOf(usage, price);
  return {
    ...base,
    diff,
    outcome: "error",
    reason: error instanceof Error ? error.message : String(error),
    durationMs,
    usage,
    ...(costUsd !== undefined ? { costUsd } : {}),
    blocking: [],
    findings: 0,
  };
}

async function pool<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>) {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export function parsePrice(value: string | undefined): Price | undefined {
  if (value === undefined) return undefined;
  const parts = value.split(",").map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part) || part < 0)) {
    throw new Error(
      "--price is input,cached,output in USD per million tokens, such as 1.25,0.125,10",
    );
  }
  const [input, cached, output] = parts as [number, number, number];
  return { input, cached, output };
}

function argValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

const HELP = [
  "bun scripts/review-score.ts [--item independent-review] [--model <codex model>] [--effort medium]",
  "                            [--tolerance 5] [--only id,id] [--concurrency 4] [--timeout-min 20]",
  "                            [--price in,cached,out] [--baseline] [--out reports/<name>]",
  "bun scripts/review-score.ts --pick-clean [--quiet-days 7] [--min-lines 20] [--count 16]",
  "                            [--days 30] [--source git|gh] [--branch origin/main] [--app paws-helper]",
  "",
  "--baseline writes reports/review-score-baseline.{md,json}. Any other run writes",
  "reports/review-score-<time>.{md,json} and compares against the baseline.",
  "--pick-clean prints clean cases for evals/review-clean.jsonl and runs no model.",
].join("\n");

async function main(args: readonly string[]): Promise<void> {
  if (args.includes("--help")) {
    console.log(HELP);
    return;
  }
  const root = join(import.meta.dir, "..");
  const git = gitIn(root);
  const escapes = readEscapes(join(root, "evals/review-escapes.jsonl"));
  if (args.includes("--pick-clean")) {
    const source = argValue(args, "--source") ?? "git";
    if (source !== "gh" && source !== "git") throw new Error("--source is gh or git");
    const now = new Date();
    const app = argValue(args, "--app") ?? "paws-helper";
    const options = {
      repo: argValue(args, "--repo") ?? "pmdroid/paws-app",
      app,
      days: Number(argValue(args, "--days") ?? 30),
      branch: argValue(args, "--branch") ?? (source === "git" ? "origin/main" : "main"),
      source,
      now,
      known: new Set<string>(),
    } as const;
    const pulls = listPulls(git, options);
    const candidates = findCandidates(git, pulls, options);
    const picked = pickClean(git, pulls, candidates, {
      app,
      now,
      quietDays: Number(argValue(args, "--quiet-days") ?? 7),
      minLines: Number(argValue(args, "--min-lines") ?? 20),
      count: Number(argValue(args, "--count") ?? 16),
      exclude: new Set(escapes.map((escape) => escape.original.pr)),
    });
    for (const entry of picked) console.log(JSON.stringify(entry));
    return;
  }

  const item = readReviewItem(
    readFileSync(join(root, ".agents/closeout.yaml"), "utf8"),
    argValue(args, "--item") ?? "independent-review",
  );
  const skillFiles = readSkillFiles(root, item.skill);
  const price = parsePrice(argValue(args, "--price"));
  const requestedModel = argValue(args, "--model");
  const config: ReviewerConfig = {
    ...item,
    skillDigest: skillDigest(skillFiles),
    model: requestedModel ?? "codex default",
    effort: argValue(args, "--effort") ?? "medium",
    tolerance: Number(argValue(args, "--tolerance") ?? 5),
  };
  const only = argValue(args, "--only")?.split(",");
  const cases: ReplayCase[] = [
    ...escapes.map((escape) => ({
      id: escape.id,
      kind: "escape" as const,
      original: escape.original,
      escape,
    })),
    ...readClean(join(root, "evals/review-clean.jsonl")).map((clean) => ({
      id: clean.id,
      kind: "clean" as const,
      original: clean.original,
      quietDays: clean.quietDays,
    })),
  ].filter((entry) => !only || only.includes(entry.id));
  const agentOptions = {
    bin: argValue(args, "--codex") ?? process.env.CODEX_BIN ?? "codex",
    ...(requestedModel ? { model: requestedModel } : {}),
    timeoutMs: Number(argValue(args, "--timeout-min") ?? 20) * 60_000,
  };
  console.error(
    `replaying ${item.id} (${item.skill}, failOn ${item.failOn}, scope ${item.scope}) on ${cases.length} cases`,
  );
  const results = await pool(cases, Number(argValue(args, "--concurrency") ?? 4), async (entry) => {
    const result = await replay(root, git, item, config, skillFiles, agentOptions, price, entry);
    console.error(
      `${entry.id}: ${result.outcome} in ${seconds(result.durationMs)}${result.reason ? ` (${result.reason})` : ""}`,
    );
    return result;
  });
  const models = [...new Set(results.flatMap((result) => (result.model ? [result.model] : [])))];
  if (!requestedModel && models.length > 0) config.model = models.join(", ");
  const report: ScoreReport = {
    version: 1,
    generatedAt: new Date().toISOString(),
    config,
    ...(price ? { price } : {}),
    results: results.map(({ model: _model, ...result }) => result),
  };
  const reports = join(root, "reports");
  mkdirSync(reports, { recursive: true });
  const baselinePath = join(reports, "review-score-baseline.json");
  const writeBaseline = args.includes("--baseline");
  const baseline =
    !writeBaseline && existsSync(baselinePath)
      ? (JSON.parse(readFileSync(baselinePath, "utf8")) as ScoreReport)
      : undefined;
  const stem =
    argValue(args, "--out") ??
    join(
      "reports",
      writeBaseline
        ? "review-score-baseline"
        : `review-score-${report.generatedAt.slice(0, 16).replace(/[:]/g, "")}`,
    );
  writeFileSync(join(root, `${stem}.json`), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(root, `${stem}.md`), renderReport(report, baseline));
  // The repository's formatter checks reports/ too.
  const formatted = spawnSync(process.execPath, ["x", "oxfmt", `${stem}.md`, `${stem}.json`], {
    cwd: root,
    encoding: "utf8",
  });
  if (formatted.status !== 0) console.error(`oxfmt failed: ${formatted.stderr.trim()}`);
  const summary = summarize(report.results);
  console.log(
    `recall ${rate(summary.recall)}, false positives ${rate(summary.falsePositives)}; wrote ${stem}.md`,
  );
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
