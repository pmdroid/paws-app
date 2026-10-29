/**
 * Check the repository's documentation:
 * - local markdown links resolve, in README.md, the root guides, docs/ and src/web/README.md
 * - every doc under docs/ is linked from another checkable document
 * - inline code paths such as `src/loop` name a file or directory that exists
 *
 * External URLs are skipped. Run from the repository root via `bun run links`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ROOT_DOCS = [
  "README.md",
  "AGENTS.md",
  "CHANGELOG.md",
  "DESIGN.md",
  "GLOSSARY.md",
  "PRODUCT.md",
  "src/web/README.md",
];

/** Docs that describe a separate demo repository, so their `src/...` paths are not ours. */
const DEMO_DOCS = new Set(["docs/local-closeout.md", "docs/smoke-test.md"]);

const INLINE_LINK = /!?\[[^\]]*]\((<[^>]+>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\)/g;
const REF_LINK = /^\[[^\]]+]:\s*(<[^>]+>|\S+)/gm;
const HTML_URL = /\b(?:href|src)="([^"]+)"/g;
const CODE_SPAN = /`([^`\n]+)`/g;
const SOURCE_PATH = /^(?:src|scripts|deploy|test|evals|\.agents|\.paws|\.github)\//;

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

function docsUnder(dir: string): string[] {
  const docs = path.join(ROOT, dir);
  if (!existsSync(docs)) return [];
  const found: string[] = [];
  listMarkdown(docs, found);
  return found;
}

function filesToCheck(): string[] {
  const files = ROOT_DOCS.map((file) => path.join(ROOT, file)).filter((file) => existsSync(file));
  return [...files, ...docsUnder("docs")].sort();
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
    // A leading slash is a site route such as `/status/`, not a repository path.
    if (decoded.startsWith("/")) continue;
    const absolute = path.resolve(path.dirname(file), decoded);
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

function resolves(raw: string, file: string): boolean {
  const token = raw.replace(/[.,;:)]+$/, "").replace(/#.*$/, "");
  if (token.includes("*") || token.includes("<") || token.includes(">") || token.includes("{"))
    return true;
  if (!SOURCE_PATH.test(token)) return true;
  const fromRoot = path.join(ROOT, token);
  if (existsSync(fromRoot)) return true;
  return existsSync(path.resolve(path.dirname(file), token));
}

function checkSourcePaths(file: string): Broken[] {
  const relative = path.relative(ROOT, file);
  if (DEMO_DOCS.has(relative)) return [];
  const broken: Broken[] = [];
  for (const match of stripFencedCode(readFileSync(file, "utf8")).matchAll(CODE_SPAN)) {
    const token = match[1]?.trim();
    if (token === undefined || token.length === 0) continue;
    if (!resolves(token, file)) {
      broken.push({ file, dest: token, reason: "source path does not exist" });
    }
  }
  return broken;
}

function inboundLinks(files: string[]): Map<string, Set<string>> {
  const inbound = new Map<string, Set<string>>();
  for (const file of files) {
    for (const raw of destinations(readFileSync(file, "utf8"))) {
      const dest = unwrap(raw).trim();
      if (dest.length === 0 || dest.startsWith("#") || isExternal(dest)) continue;
      const pathPart = (dest.split("#")[0] ?? "").split("?")[0] ?? "";
      if (pathPart.length === 0) continue;
      const target = path.resolve(path.dirname(file), decodeURIComponent(pathPart));
      const links = inbound.get(target) ?? new Set<string>();
      links.add(file);
      inbound.set(target, links);
    }
  }
  return inbound;
}

function main(): void {
  const files = filesToCheck();
  const broken = [...files.flatMap(checkFile), ...files.flatMap(checkSourcePaths)];

  const inbound = inboundLinks(files);
  const docs = docsUnder("docs");
  for (const doc of docs) {
    const links = [...(inbound.get(doc) ?? [])].filter((source) => source !== doc);
    if (links.length === 0) {
      broken.push({
        file: doc,
        dest: path.relative(ROOT, doc),
        reason: "not linked from any document",
      });
    }
  }

  if (broken.length > 0) {
    for (const item of broken) {
      console.error(`${path.relative(ROOT, item.file)}: ${item.dest} (${item.reason})`);
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
  console.log(`docs ok (${files.length} files, ${local} local links, ${docs.length} docs)`);
}

main();
