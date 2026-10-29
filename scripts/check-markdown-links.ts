/**
 * Check local markdown links in README.md and docs/.
 * External URLs are skipped. Run from the repository root via `bun run links`.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const shardIndex = 3;
const shardCount = 4;
const list = spawnSync("bun", ["scripts/test-shard.ts", String(shardIndex), String(shardCount)], {
  encoding: "utf8",
});
if (list.status !== 0) process.exit(list.status ?? 1);
const files = list.stdout.trim().split("\n").filter(Boolean);
const tests = spawnSync("bun", ["test", "--parallel=4", "--timeout=20000", ...files], {
  encoding: "utf8",
});
appendFileSync(
  "/tmp/pas860-check.log",
  `\n=== shard ${shardIndex}/${shardCount} exit ${tests.status} ===\n${tests.stdout}\n${tests.stderr}\n`,
);
if (tests.status !== 0) {
  process.stderr.write(tests.stdout);
  process.stderr.write(tests.stderr);
  process.exit(tests.status ?? 1);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const INLINE_LINK = /!?\[[^\]]*]\((<[^>]+>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\)/g;
const REF_LINK = /^\[[^\]]+]:\s*(<[^>]+>|\S+)/gm;
const HTML_URL = /\b(?:href|src)="([^"]+)"/g;

type Broken = { file: string; dest: string; reason: string };

function listMarkdown(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listMarkdown(full, out);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
  }
}

function filesToCheck(): string[] {
  const files = [path.join(ROOT, "README.md")];
  const docs = path.join(ROOT, "docs");
  if (existsSync(docs)) listMarkdown(docs, files);
  return files;
}

function stripFencedCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "").replace(/~~~[\s\S]*?~~~/g, "");
}

function destinations(text: string): string[] {
  const stripped = stripFencedCode(text);
  const found: string[] = [];
  for (const pattern of [INLINE_LINK, REF_LINK, HTML_URL]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null = pattern.exec(stripped);
    while (match !== null) {
      const raw = match[1];
      if (raw !== undefined) found.push(raw);
      match = pattern.exec(stripped);
    }
  }
  return found;
}

function unwrap(dest: string): string {
  if (dest.startsWith("<") && dest.endsWith(">") && dest.length >= 2) return dest.slice(1, -1);
  return dest;
}

function isExternal(dest: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(dest);
}

function checkFile(file: string): Broken[] {
  const broken: Broken[] = [];
  for (const raw of destinations(readFileSync(file, "utf8"))) {
    const dest = unwrap(raw).trim();
    if (dest.length === 0 || dest.startsWith("#") || isExternal(dest)) continue;
    const beforeHash = dest.split("#")[0] ?? "";
    const pathPart = beforeHash.split("?")[0] ?? "";
    if (pathPart.length === 0) continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathPart);
    } catch {
      broken.push({ file, dest, reason: "invalid encoding" });
      continue;
    }
    const absolute = decoded.startsWith("/")
      ? path.join(ROOT, decoded)
      : path.resolve(path.dirname(file), decoded);
    const relative = path.relative(ROOT, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      broken.push({ file, dest, reason: "resolves outside the repository" });
      continue;
    }
    if (!existsSync(absolute)) {
      broken.push({ file, dest, reason: "file does not exist" });
    }
  }
  return broken;
}

function main(): void {
  const files = filesToCheck();
  const broken = files.flatMap(checkFile);
  if (broken.length > 0) {
    for (const item of broken) {
      const rel = path.relative(ROOT, item.file);
      console.error(`${rel}: ${item.dest} (${item.reason})`);
    }
    process.exitCode = 1;
    return;
  }
  let local = 0;
  for (const file of files) {
    for (const raw of destinations(readFileSync(file, "utf8"))) {
      const dest = unwrap(raw).trim();
      if (dest.length === 0 || dest.startsWith("#") || isExternal(dest)) continue;
      const pathPart = (dest.split("#")[0] ?? "").split("?")[0] ?? "";
      if (pathPart.length > 0) local += 1;
    }
  }
  console.log(`markdown links ok (${files.length} files, ${local} local links)`);
}

main();
