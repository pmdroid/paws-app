import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { validate } from "../closeout-spec";
import { refLabel } from "./check";
import type { Candidate, ProposedRule, SkippedCandidate } from "./types";

export const DEFAULT_OUT = "probes.proposed.yaml";

/** Marks the commented copy of a probe script under its rule. */
const SCRIPT_START = "# probe script begin";
const SCRIPT_END = "# probe script end";

/**
 * The proposed `rules:` list in the Closeout policy format, as one file. Every entry carries
 * `# source:` notes with the comment or doc line it came from, `# check:` notes with what its
 * probe did, and the probe script itself as a comment block, since a rule is nothing without it.
 */
export function renderProposal(input: {
  repository: string;
  main: string;
  rules: readonly ProposedRule[];
  skipped: readonly SkippedCandidate[];
}): string {
  const lines = [
    `# Probe rules proposed by \`paws probes collect\` for ${input.repository} at ${input.main.slice(0, 12)}.`,
    "# Nothing here holds a pull request yet. Review each rule, save the script between its",
    `# "${SCRIPT_START}" and "${SCRIPT_END}" lines, without the leading "#   ", at the path its`,
    "# `probe:` names, and add the entry to .agents/closeout.yaml.",
    "rules:",
  ];
  for (const rule of input.rules) {
    for (const link of rule.candidate.sources)
      lines.push(`  # source: ${link.url} ${JSON.stringify(link.quote)}`);
    for (const note of checkNotes(rule)) lines.push(`  # check: ${note}`);
    lines.push(`  - id: ${rule.candidate.id}`);
    lines.push(`    summary: ${JSON.stringify(rule.candidate.summary)}`);
    lines.push(`    probe: ${rule.probe}`);
    if (rule.entry.exec) lines.push(`    exec: ${JSON.stringify(rule.entry.exec)}`);
    if (rule.entry.paths) lines.push(`    paths: ${JSON.stringify(rule.entry.paths)}`);
    lines.push(`    failOn: ${rule.entry.failOn}`);
    if (rule.entry.onFail) lines.push(`    onFail: ${rule.entry.onFail}`);
    lines.push(...scriptComment(rule.bytes));
  }
  if (input.skipped.length) {
    lines.push("", "# Skipped:");
    for (const { candidate, reason } of input.skipped)
      lines.push(`# - ${candidate.id}: ${oneLine(candidate.summary)} (${oneLine(reason)})`);
  }
  return `${lines.join("\n")}\n`;
}

function scriptComment(bytes: Uint8Array): string[] {
  const text = new TextDecoder().decode(bytes).replace(/\r\n?/g, "\n").replace(/\n$/, "");
  return [
    `    ${SCRIPT_START}`,
    ...text.split("\n").map((line) => (line ? `    #   ${line}` : "    #")),
    `    ${SCRIPT_END}`,
  ];
}

/** The probe scripts in a proposal file, by the `probe:` path of the rule above each one. */
export function proposalScripts(yaml: string): Map<string, string> {
  const scripts = new Map<string, string>();
  let probe: string | null = null;
  let body: string[] | null = null;
  for (const line of yaml.split("\n")) {
    const trimmed = line.trim();
    const named = /^probe: (.+)$/.exec(trimmed);
    if (named && body === null) probe = named[1]!;
    else if (trimmed === SCRIPT_START) body = [];
    else if (trimmed === SCRIPT_END && body !== null && probe !== null) {
      scripts.set(probe, `${body.join("\n")}\n`);
      body = null;
    } else if (body !== null) body.push(line.startsWith("    #   ") ? line.slice(8) : "");
  }
  return scripts;
}

export function checkNotes(rule: Pick<ProposedRule, "check">): string[] {
  const { main, breaks, status } = rule.check;
  const notes = [
    main.passed
      ? "passes on origin/main"
      : `fails on origin/main, so the rule may already be broken: ${firstLine(main.output)}`,
  ];
  for (const entry of breaks) {
    const label =
      "pull" in entry.ref && entry.commit
        ? `${refLabel(entry.ref)} (${entry.commit.slice(0, 12)})`
        : refLabel(entry.ref);
    if (!entry.run) notes.push(`not checked on ${label}: ${entry.note ?? "no commit"}`);
    else if (entry.run.passed) notes.push(`passes on ${label}, so it does not see the bug`);
    else notes.push(`fails on ${label}, as it should`);
  }
  if (breaks.length === 0) notes.push("no source names a commit that broke the rule");
  else if (status === "unverified")
    notes.push("not every commit its sources name could be checked");
  return notes;
}

/** The status line the CLI prints for a rule. */
export function statusLabel(rule: Pick<ProposedRule, "check">): string {
  switch (rule.check.status) {
    case "checked":
      return "checked";
    case "misses_bug":
      return "does not see the bug";
    case "fails_on_main":
      return "fails on origin/main";
    case "unverified":
      return "passes on origin/main, no breaking commit checked";
  }
}

/**
 * Validate the proposal as a Closeout policy, with each probe saved from its commented copy
 * in the file. Returns null when it validates, else what is wrong.
 */
export function validateProposal(yaml: string, rules: readonly ProposedRule[]): string | null {
  const scripts = proposalScripts(yaml);
  for (const rule of rules)
    if (scripts.get(rule.probe) !== new TextDecoder().decode(rule.bytes).replace(/\r\n?/g, "\n"))
      return `the copy of ${rule.probe} in the file does not match the probe that was checked`;
  const root = mkdtempSync(join(tmpdir(), "paws-probes-validate-"));
  try {
    const repo = join(root, "repo");
    const home = join(root, "home");
    mkdirSync(join(repo, ".agents"), { recursive: true });
    mkdirSync(home);
    writeFileSync(join(repo, ".agents", "closeout.yaml"), `specVersion: "0.1"\n${yaml}`);
    for (const [probe, text] of scripts) {
      mkdirSync(dirname(join(repo, probe)), { recursive: true });
      writeFileSync(join(repo, probe), text);
    }
    const result = validate(repo, home, repo);
    return result.ok ? null : result.message;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A line per candidate, for `--dry-run` and for the person choosing which to keep. */
export function formatCandidate(candidate: Candidate): string {
  const head = `${candidate.decidable ? "+" : "-"} ${candidate.id}: ${candidate.summary}`;
  const lines = [candidate.decidable ? head : `${head}\n    skipped: ${candidate.reason}`];
  for (const link of candidate.sources) lines.push(`    ${link.url}`);
  if (candidate.breaks.length)
    lines.push(`    broke in: ${candidate.breaks.map(refLabel).join(", ")}`);
  return lines.join("\n");
}

function firstLine(text: string): string {
  return oneLine(text.split("\n").find((line) => line.trim()) ?? "no output");
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
}
