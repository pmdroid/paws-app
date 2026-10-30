import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

type Span = { start: number; end: number };

export function commentSpans(source: string): Span[] {
  const lines = source.split("\n");
  const spans: Span[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trimStart();
    if (line.startsWith("//")) {
      const start = i;
      while (lines[i + 1]?.trimStart().startsWith("//")) i++;
      spans.push({ start: start + 1, end: i + 1 });
    } else if (line.startsWith("/*")) {
      const start = i;
      while (!lines[i]!.includes("*/") && i + 1 < lines.length) i++;
      spans.push({ start: start + 1, end: i + 1 });
    }
  }
  return spans;
}

function git(args: string[], cwd: string): string | null {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return result.status === 0 ? result.stdout : null;
}

function addedLines(path: string, source: string): Set<number> | null {
  const cwd = dirname(path);
  if (git(["rev-parse", "--show-toplevel"], cwd) === null) return null;
  if (git(["ls-files", "--error-unmatch", path], cwd) === null)
    return new Set(source.split("\n").map((_, index) => index + 1));
  const diff = git(["diff", "-U0", "HEAD", "--", path], cwd);
  if (diff === null) return null;
  const added = new Set<number>();
  let line = 0;
  for (const raw of diff.split("\n")) {
    const hunk = HUNK.exec(raw);
    if (hunk) line = Number(hunk[1]);
    else if (raw.startsWith("+") && !raw.startsWith("+++")) added.add(line++);
  }
  return added;
}

function violations(path: string): string[] {
  if (!CODE_FILE.test(path) || !existsSync(path)) return [];
  const source = readFileSync(path, "utf8");
  const added = addedLines(path, source);
  if (added === null) return [];
  return commentSpans(source)
    .filter(({ start, end }) => [...added].some((line) => line >= start && line <= end))
    .map(({ start }) => `${path}:${start}`);
}

if (import.meta.main) {
  const event = JSON.parse(await Bun.stdin.text()) as { tool_input?: { file_path?: string } };
  const found = violations(event.tool_input?.file_path ?? "");
  if (found.length > 0) {
    console.error(
      `No code comments or docstrings. Delete these and let names and types say it:\n${found
        .map((place) => `  ${place}`)
        .join("\n")}\nA genuine why belongs in the commit message or the PR description.`,
    );
    process.exit(2);
  }
}
