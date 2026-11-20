import { journalCaught } from "../journal";

export function incompleteReport(report: string, skipped: readonly string[]): string | undefined {
  try {
    const parsed = JSON.parse(report) as {
      required?: { id?: string; kind?: string; result?: { exitCode?: unknown } }[];
      rules?: unknown[];
      blocked?: unknown;
    };
    const required = Array.isArray(parsed.required) ? parsed.required : [];
    if (required.length === 0 && !(Array.isArray(parsed.rules) && parsed.rules.length > 0))
      return typeof parsed.blocked === "string"
        ? `the policy was unavailable: ${parsed.blocked}`
        : "the runner's Closeout listed no checks";
    if (required.some((entry) => entry.result && entry.result.exitCode !== 0)) return undefined;
    const unstarted = required.find(
      (entry) => entry.kind === "command" && !entry.result && !skipped.includes(entry.id ?? ""),
    );
    return unstarted ? `no result for ${unstarted.id} (it never started)` : undefined;
  } catch (caughtError18) {
    journalCaught(caughtError18, "orchestrator.incompleteReport.parse", null);
    return "the runner's Closeout report is unreadable";
  }
}
