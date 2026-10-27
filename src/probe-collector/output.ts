import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { validate } from "../closeout-spec";
import { refLabel } from "./check";
import type { Candidate, ProposedRule, SkippedCandidate } from "./types";

export const DEFAULT_OUT = "probes.proposed.yaml";

/** Where the probe scripts go next to `out`: `probes.proposed.yaml` → `probes.proposed/`. */
export function probesDir(out: string): string {
  const ext = extname(out);
  return join(dirname(out), basename(out, ext === ".yaml" || ext === ".yml" ? ext : ""));
}

/**
 * The proposed `rules:` list in the Closeout policy format. Every entry carries `# source:`
 * notes with the comment or doc line it came from and `# check:` notes with what its probe did.
 */
export function renderProposal(input: {
  repository: string;
  main: string;
  scriptsDir: string;
  rules: readonly ProposedRule[];
  skipped: readonly SkippedCandidate[];
}): string {
  const lines = [
    `# Probe rules proposed by \`paws probes collect\` for ${input.repository} at ${input.main.slice(0, 12)}.`,
    "# Nothing here holds a pull request yet. Review each rule, copy its probe script from",
    `# ${input.scriptsDir}/ to the path its \`probe:\` names, and add the entry to .agents/closeout.yaml.`,
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
  }
  if (input.skipped.length) {
    lines.push("", "# Skipped:");
    for (const { candidate, reason } of input.skipped)
      lines.push(`# - ${candidate.id}: ${oneLine(candidate.summary)} (${oneLine(reason)})`);
  }
  return `${lines.join("\n")}\n`;
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
  if (status === "unverified") notes.push("no source names a commit that broke the rule");
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
      return "passes on origin/main, no breaking commit named";
  }
}

/**
 * Validate the proposal as a Closeout policy with the probes at their `probe:` paths.
 * Returns null when it validates, else the policy error.
 */
export function validateProposal(yaml: string, rules: readonly ProposedRule[]): string | null {
  const root = mkdtempSync(join(tmpdir(), "paws-probes-validate-"));
  try {
    const repo = join(root, "repo");
    const home = join(root, "home");
    mkdirSync(join(repo, ".agents"), { recursive: true });
    mkdirSync(home);
    writeFileSync(join(repo, ".agents", "closeout.yaml"), `specVersion: "0.1"\n${yaml}`);
    for (const rule of rules) {
      mkdirSync(dirname(join(repo, rule.probe)), { recursive: true });
      writeFileSync(join(repo, rule.probe), rule.bytes);
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
