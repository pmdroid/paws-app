import type { Database } from "bun:sqlite";
import { getEvidence, getWorkItem } from "../db";
import { evidencePath } from "./store";
import { ULID_PATTERN } from "./ulid";

export const EVIDENCE_API_PATH = "/api/evidence/";

export type EvidenceRequestOptions = {
  db: Database;
  root: string;
  sessionIds: readonly string[] | undefined;
};

const PRIVATE = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
};

export async function handleEvidenceRequest(
  request: Request,
  options: EvidenceRequestOptions,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith(EVIDENCE_API_PATH)) return null;
  if (options.sessionIds === undefined)
    return Response.json({ error: "Sign in to Paws." }, { status: 401, headers: PRIVATE });
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405, headers: { ...PRIVATE, allow: "GET, HEAD" } });
  const id = path.slice(EVIDENCE_API_PATH.length);
  if (!ULID_PATTERN.test(id)) return notFound();
  const evidence = getEvidence(options.db, id);
  if (evidence === null) return notFound();
  const item = getWorkItem(options.db, evidence.itemId);
  if (item?.sessionKey == null || !options.sessionIds.includes(item.sessionKey)) return notFound();
  const file = Bun.file(evidencePath(options.root, id));
  if (!(await file.exists()) || file.size !== evidence.sizeBytes) return notFound();
  const size = evidence.sizeBytes;
  const headers: Record<string, string> = {
    ...PRIVATE,
    "content-type": evidence.mediaType,
    "content-disposition": disposition(evidence.displayName),
    "accept-ranges": "bytes",
  };
  const header = request.headers.get("range");
  const range = header === null ? null : parseRange(header, size);
  if (range === "unsatisfiable")
    return new Response(null, {
      status: 416,
      headers: { ...headers, "content-range": `bytes */${size}` },
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

function notFound(): Response {
  return Response.json({ error: "Not found." }, { status: 404, headers: PRIVATE });
}

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
  const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
  if (last !== "" && Number(last) < start) return null;
  if (start >= size) return "unsatisfiable";
  return { start, end };
}

function disposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `inline; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
