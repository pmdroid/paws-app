import type { Database } from "bun:sqlite";
import { getEvidence, type EvidenceRow } from "../db";
import { evidenceFile } from "./store";

export const EVIDENCE_PATH_PREFIX = "/api/evidence/";

export type EvidenceRequestOptions = {
  db: Database;
  dir: string;
  /** Whether the signed-in member may see this evidence's repository. */
  canRead: (row: EvidenceRow) => boolean;
};

const BASE_HEADERS = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

/**
 * `GET /api/evidence/:id`. The caller has already checked the Paws session.
 * An unknown id, a missing file and a repository the member cannot see all get the same 404.
 */
export async function handleEvidenceRequest(
  request: Request,
  options: EvidenceRequestOptions,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD")
    return Response.json(
      { error: "Method not allowed." },
      { status: 405, headers: { ...BASE_HEADERS, allow: "GET, HEAD" } },
    );
  const id = new URL(request.url).pathname.slice(EVIDENCE_PATH_PREFIX.length);
  const path = evidenceFile(options.dir, id);
  const row = path === null ? null : getEvidence(options.db, id);
  if (path === null || row === null || !options.canRead(row)) return notFound();
  const file = Bun.file(path);
  if (!(await file.exists()) || file.size !== row.sizeBytes) return notFound();

  const size = row.sizeBytes;
  const etag = `"sha256-${row.sha256}"`;
  const headers: Record<string, string> = {
    ...BASE_HEADERS,
    "content-type": row.mediaType,
    "content-disposition": inline(row.displayName),
    "accept-ranges": "bytes",
    etag,
  };
  const ifRange = request.headers.get("if-range");
  const header = ifRange === null || ifRange === etag ? request.headers.get("range") : null;
  const range = header === null ? null : parseRange(header, size);
  if (range === "unsatisfiable")
    return new Response(null, {
      status: 416,
      headers: { ...BASE_HEADERS, "content-range": `bytes */${size}` },
    });
  const head = request.method === "HEAD";
  if (range === null)
    return new Response(head ? null : file, {
      status: 200,
      headers: { ...headers, "content-length": String(size) },
    });
  return new Response(head ? null : file.slice(range.start, range.end + 1), {
    status: 206,
    headers: {
      ...headers,
      "content-length": String(range.end - range.start + 1),
      "content-range": `bytes ${range.start}-${range.end}/${size}`,
    },
  });
}

/**
 * One `bytes=` range, inclusive. Null means serve the whole file: no header, a malformed
 * one, or several ranges (allowed by RFC 9110).
 */
export function parseRange(
  header: string,
  size: number,
): { start: number; end: number } | "unsatisfiable" | null {
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
  if (last === "") return { start, end: size - 1 };
  const end = Number(last);
  if (end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}

function notFound(): Response {
  return Response.json({ error: "Evidence not found." }, { status: 404, headers: BASE_HEADERS });
}

function inline(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `inline; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
