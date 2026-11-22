import type { FailedTest } from "./types";

export const MAX_GO_REPORT_BYTES = 64 * 1024 * 1024;

const KEPT_OUTPUT = 4096;
const NOISE = /^(=== (RUN|PAUSE|CONT|NAME)|--- (FAIL|PASS|SKIP)|PASS$|FAIL$|FAIL\t|ok\s)/;

type GoEvent = {
  Action?: string;
  Package?: string;
  Test?: string;
  Output?: string;
  ImportPath?: string;
  FailedBuild?: string;
};

export type GoJsonReport =
  | { ok: true; cases: number; failures: FailedTest[] }
  | { ok: false; message: string };

export function parseGoJson(text: string): GoJsonReport {
  if (text.length > 0 && !text.endsWith("\n")) return { ok: false, message: "ends early" };
  const outputs = new Map<string, string[]>();
  const seen = new Set<string>();
  const finished = new Set<string>();
  const builds = new Set<string>();
  const failures: FailedTest[] = [];
  const failedTests = new Map<string, string[]>();
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    let event: GoEvent;
    try {
      event = JSON.parse(line) as GoEvent;
    } catch {
      return { ok: false, message: "is not a go test -json stream" };
    }
    const { Action: action, Package: pkg, Test: name } = event;
    if (action === "build-output" || action === "build-fail") {
      if (action === "build-fail" && event.ImportPath) builds.add(event.ImportPath);
      keep(outputs, `build ${event.ImportPath}`, event.Output);
      continue;
    }
    if (pkg === undefined) continue;
    seen.add(pkg);
    const key = name === undefined ? pkg : `${pkg} ${name}`;
    if (action === "output") keep(outputs, key, event.Output);
    if (name !== undefined) {
      if (action === "fail") {
        failedTests.set(pkg, [...(failedTests.get(pkg) ?? []), name]);
        failures.push({ file: pkg, name, message: messageOf(outputs.get(key)), kind: "failed" });
      }
      continue;
    }
    if (action !== "pass" && action !== "fail" && action !== "skip") continue;
    finished.add(pkg);
    if (event.FailedBuild) builds.delete(event.FailedBuild);
    if (action === "fail" && !failedTests.has(pkg)) {
      const build = event.FailedBuild ? outputs.get(`build ${event.FailedBuild}`) : undefined;
      failures.push({ file: pkg, message: messageOf(build ?? outputs.get(key)), kind: "error" });
    }
  }
  for (const build of builds) {
    failures.push({
      file: build,
      message: messageOf(outputs.get(`build ${build}`)),
      kind: "error",
    });
  }
  for (const pkg of seen) {
    if (finished.has(pkg)) continue;
    failures.push({
      file: pkg,
      message: "ended without a final pass or fail",
      kind: "skipped-crash",
    });
  }
  const leaves = failures.filter(
    (failure) =>
      failure.name === undefined ||
      !(failedTests.get(failure.file!) ?? []).some((other) => other.startsWith(`${failure.name}/`)),
  );
  return { ok: true, cases: finished.size, failures: leaves };
}

function keep(outputs: Map<string, string[]>, key: string, output: string | undefined): void {
  if (output === undefined) return;
  const lines = outputs.get(key) ?? [];
  if (lines.reduce((size, entry) => size + entry.length, 0) < KEPT_OUTPUT) lines.push(output);
  outputs.set(key, lines);
}

function messageOf(lines: readonly string[] | undefined): string {
  const all = (lines ?? []).map((line) => line.trim()).filter((line) => line.length > 0);
  const kept = all.filter((line) => !NOISE.test(line));
  return (kept.length > 0 ? kept : all).join("\n") || "failed";
}
