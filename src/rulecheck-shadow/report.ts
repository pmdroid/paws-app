import type { ShadowComparison, ShadowSideReport } from "./compare";

const HEADLINE = {
  agree: "CI and Paws agree",
  disagree: "CI and Paws disagree",
  incomplete: "Not comparable yet",
} as const;

export function formatShadowReport(comparison: ShadowComparison): string {
  const lines = [
    `# Rulecheck shadow comparison: ${HEADLINE[comparison.status]}`,
    "",
    `Head: \`${comparison.head}\``,
    "",
    "Shadow only. Closeout's decision stands, and nothing here blocks or merges the pull request.",
    "",
  ];
  section(lines, "Missing or stale evidence", comparison.gaps);
  section(lines, "Differences", comparison.mismatches);
  section(lines, "Notes", comparison.notes);
  side(lines, "CI", comparison.ci);
  side(lines, "Paws", comparison.paws);
  return `${lines.join("\n").trimEnd()}\n`;
}

function section(lines: string[], title: string, entries: readonly string[]): void {
  if (entries.length === 0) return;
  lines.push(`## ${title}`, "", ...entries.map((entry) => `- ${entry}`), "");
}

function side(lines: string[], title: string, report: ShadowSideReport): void {
  lines.push(`## ${title}`, "", `Source: ${report.source}`);
  if (report.candidateSha !== null)
    lines.push(`Candidate: \`${report.candidateSha}\`, base: \`${report.baseSha ?? "none"}\``);
  if (report.verdict !== null) lines.push(`Required phases: ${report.verdict}`);
  if (report.outcome !== null) lines.push(`Receipt outcome: ${report.outcome}`);
  lines.push("");
  for (const failure of report.failures)
    lines.push(`- ${failure.phase} (${failure.outcome}, ${failure.kind}): ${failure.remediation}`);
  if (report.failures.length > 0) lines.push("");
}
