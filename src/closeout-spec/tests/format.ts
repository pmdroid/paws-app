import type { FailedTest, StoredFailedTests, StoredTestSelection, TestSelection } from "./types";

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

export function scrubFailures(
  failures: readonly FailedTest[],
  scrub: (text: string) => string,
): FailedTest[] {
  return failures.map(({ file, name, message, kind }) => ({
    ...(file !== undefined ? { file: scrub(file) } : {}),
    ...(name !== undefined ? { name: scrub(name) } : {}),
    message: scrub(message),
    kind,
  }));
}

const STORED_FAILED_TESTS = 200;
const STORED_MESSAGE_CHARS = 4_000;
const STORED_NAME_CHARS = 1_000;
const STORED_REASONS = 200;

export function storedFailedTests(failures: readonly FailedTest[]): StoredFailedTests {
  return {
    total: failures.length,
    shown: failures.slice(0, STORED_FAILED_TESTS).map(({ file, name, message, kind }) => ({
      ...(file !== undefined ? { file: file.slice(0, STORED_NAME_CHARS) } : {}),
      ...(name !== undefined ? { name: name.slice(0, STORED_NAME_CHARS) } : {}),
      message: message.slice(0, STORED_MESSAGE_CHARS),
      kind,
    })),
  };
}

export function storedTestSelection(selection: TestSelection, base: string): StoredTestSelection {
  return {
    mode: selection.mode,
    reasons: selection.reasons
      .slice(0, STORED_REASONS)
      .map((reason) => reason.slice(0, STORED_NAME_CHARS)),
    selected: selection.mode === "selected" ? selection.targets.length : 0,
    base,
  };
}

export function fittedTests(
  failedTests: StoredFailedTests,
  testSelection: StoredTestSelection,
  room: number,
): { failedTests: StoredFailedTests; testSelection: StoredTestSelection } {
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value)) + 1;
  let left = room - bytes({ ...failedTests, shown: [] }) - bytes({ ...testSelection, reasons: [] });
  const take = <T>(items: readonly T[]): T[] => {
    const kept: T[] = [];
    for (const item of items) {
      const size = bytes(item);
      if (size > left) break;
      left -= size;
      kept.push(item);
    }
    return kept;
  };
  const reasons = take(testSelection.reasons);
  return {
    failedTests: { ...failedTests, shown: take(failedTests.shown) },
    testSelection: { ...testSelection, reasons },
  };
}
