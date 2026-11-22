import type { FailedTest } from "./types";

const SHOWN = 50;

export function failedTestsText(failures: readonly FailedTest[]): string {
  if (failures.length === 0) return "";
  const lines = failures.slice(0, SHOWN).map((failure) => {
    const where = [failure.file, failure.name].filter(Boolean).join(": ");
    const message = (failure.message.trim().split("\n")[0] ?? "").slice(0, 200);
    const label = failure.kind === "failed" ? "" : ` (${failure.kind})`;
    return `- ${where || "unnamed test"}${label}: ${message}`;
  });
  const rest = failures.length - SHOWN;
  if (rest > 0) lines.push(`- and ${rest} more`);
  return [`Failed tests (${failures.length}):`, ...lines].join("\n");
}
