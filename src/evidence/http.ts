import type { Database } from "bun:sqlite";
import { lstatSync } from "node:fs";
import { getEvidence, getWorkItem, type EvidenceRecord } from "../db";
import { evidenceFile } from "./store";

export const EVIDENCE_API_PREFIX = "/api/evidence/";

const ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const PRIVATE = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};

export type EvidenceRequestOptions = {
  db: Database;
  dir: string;
  /**
   * Linear sessions the signed-in member may see. They already apply the
   * workspace's repository-to-team mapping, so evidence on a work item outside
   * them belongs to a repository the member cannot open.
   */
  sessionIds: readonly string[];
};

/**
 * `GET /api/evidence/:id`. The caller has already required a Paws session.
 * Evidence the member may not see answers exactly like an unknown id.
 */
export function handleEvidenceRequest(request: Request, options: EvidenceRequestOptions): Response {
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405, headers: { ...PRIVATE, Allow: "GET, HEAD" } });
  const id = new URL(request.url).pathname.slice(EVIDENCE_API_PREFIX.length);
  const record = ID.test(id) ? getEvidence(options.db, id) : null;
  if (record === null || !visible(options, record)) return notFound();
  const file = evidenceFile(options.dir, record.id);
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size !== record.size) return notFound();
  } catch {
    return notFound();
  }
  const headers = new Headers({
    ...PRIVATE,
    "Content-Type": record.mediaType,
    "Content-Disposition": inline(record.displayName),
    "Accept-Ranges": "bytes",
  });
  const range = parseRange(request.headers.get("range"), record.size);
  if (range === "unsatisfiable") {
    headers.set("Content-Range", `bytes */${record.size}`);
    headers.delete("Content-Type");
    headers.delete("Content-Disposition");
    return new Response(null, { status: 416, headers });
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? record.size - 1;
  headers.set("Content-Length", String(end - start + 1));
  if (range !== null) headers.set("Content-Range", `bytes ${start}-${end}/${record.size}`);
  const body =
    request.method === "HEAD"
      ? null
      : range === null
        ? Bun.file(file)
        : Bun.file(file).slice(start, end + 1);
  return new Response(body, { status: range === null ? 200 : 206, headers });
}

function visible(options: EvidenceRequestOptions, record: EvidenceRecord): boolean {
  const sessionKey = getWorkItem(options.db, record.itemId)?.sessionKey ?? null;
  return sessionKey !== null && options.sessionIds.includes(sessionKey);
}

function notFound(): Response {
  return Response.json({ error: "Not found." }, { status: 404, headers: PRIVATE });
}

/**
 * One `bytes=` range, or null for the whole file. Several ranges, other units
 * and malformed values are ignored and served whole, as RFC 9110 allows.
 */
export function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | "unsatisfiable" | null {
  if (header === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return null;
  const [, first = "", last = ""] = match;
  if (first === "" && last === "") return null;
  if (first === "") {
    const suffix = Number(last);
    if (suffix === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  if (start >= size) return "unsatisfiable";
  const end = last === "" ? size - 1 : Number(last);
  if (end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}

function inline(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `inline; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
