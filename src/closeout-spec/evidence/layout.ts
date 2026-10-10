import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

const SEGMENT = /^[A-Za-z0-9._-]+$/;
const HEAD = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * `~/.paws/closeout/<owner>/<repo>`.
 * `home` overrides `PAWS_HOME` and then `~/.paws`, for tests.
 */
export function evidenceRoot(input: { owner: string; repo: string; home?: string }): string {
  return join(
    pawsHome(input.home),
    "closeout",
    pathSegment(input.owner, "owner"),
    pathSegment(input.repo, "repo"),
  );
}

export function pawsHome(home?: string): string {
  if (home !== undefined) return home;
  const configured = process.env.PAWS_HOME;
  if (configured !== undefined && configured.length > 0) return configured;
  return join(homedir(), ".paws");
}

/** Hex directory name. The `sha256:` prefix is not a path segment, matching `.closeout/`. */
export function digestHex(digest: string): string {
  if (!DIGEST.test(digest)) throw new Error("evidence path is invalid");
  return digest.slice("sha256:".length);
}

export function evidenceRelative(input: {
  policyDigest: string;
  head: string;
  itemId: string;
  attempt: number;
}): string {
  return relativeLeaf("evidence", input, `${assertAttempt(input.attempt)}.json`);
}

export function logRelative(input: {
  policyDigest: string;
  head: string;
  itemId: string;
  attempt: number;
}): string {
  return relativeLeaf("logs", input, `${assertAttempt(input.attempt)}.log`);
}

export function itemDirectory(input: {
  policyDigest: string;
  head: string;
  itemId: string;
}): string {
  assertHead(input.head);
  return [
    "evidence",
    digestHex(input.policyDigest),
    input.head,
    ...itemSegments(input.itemId),
  ].join("/");
}

export function absoluteInside(root: string, portable: string): string {
  return join(root, ...portable.split("/"));
}

export function relativePosix(root: string, file: string): string {
  const rel = relative(root, file);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return file.split(sep).join("/");
  return rel.split(sep).join("/");
}

function relativeLeaf(
  folder: "evidence" | "logs",
  input: { policyDigest: string; head: string; itemId: string; attempt: number },
  leaf: string,
): string {
  assertHead(input.head);
  assertAttempt(input.attempt);
  return [
    folder,
    digestHex(input.policyDigest),
    input.head,
    ...itemSegments(input.itemId),
    leaf,
  ].join("/");
}

function itemSegments(itemId: string): string[] {
  if (
    itemId.length === 0 ||
    itemId.length > 256 ||
    itemId.includes("\\") ||
    itemId.includes("\0")
  ) {
    throw new Error("evidence path is invalid");
  }
  const segments = itemId.split("/");
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      throw new Error("evidence path is invalid");
    }
  }
  return segments;
}

function assertHead(head: string): void {
  if (!HEAD.test(head)) throw new Error("evidence path is invalid");
}

function assertAttempt(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 100_000) {
    throw new Error("evidence path is invalid");
  }
  return attempt;
}

function pathSegment(value: string, label: string): string {
  if (!SEGMENT.test(value) || value === "." || value === "..") {
    throw new Error(`${label} is not a single path segment`);
  }
  return value;
}
