import type { Db } from "../db";
import type { ContextAccess, ContextRequester } from "./policy";
import {
  CONTEXT_VIEW_LIMITS,
  contextViewSupported,
  readContextRecord,
  readContextView,
} from "./view";

const NO_STORE = { "cache-control": "no-store, private", vary: "cookie" };

function answer(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

const UNAVAILABLE = { status: "unavailable", error: "This context is not available." };

export function createProjectContextHttp(options: {
  db: Db;
  access: ContextAccess;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  return async (request: Request, requester: ContextRequester): Promise<Response | null> => {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").slice(1);
    if (parts[0] !== "api" || parts[1] !== "context") return null;
    if (request.method !== "GET") return answer({ error: "Context is read-only." }, 405);
    const [kind = "", id = "", records, recordId, ...rest] = parts.slice(2).map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return "";
      }
    });
    if (!contextViewSupported(kind))
      return answer(
        { status: "unsupported", error: "This kind of context is not available." },
        400,
      );
    const scope = { kind, id };
    try {
      if (records === undefined) {
        const number = (name: string, fallback: number) => {
          const value = Number(url.searchParams.get(name) ?? fallback);
          return Number.isFinite(value) ? value : fallback;
        };
        const view = await readContextView(options.db, options.access, {
          requester,
          scope,
          now: now(),
          offset: number("offset", 0),
          limit: number("limit", CONTEXT_VIEW_LIMITS.pageDefault),
          search: url.searchParams.get("q") ?? "",
        });
        return view ? answer({ status: "ok", view }) : answer(UNAVAILABLE, 404);
      }
      if (records !== "records" || recordId === undefined || rest.length)
        return answer(UNAVAILABLE, 404);
      const detail = await readContextRecord(options.db, options.access, {
        requester,
        scope,
        now: now(),
        recordId,
      });
      return detail ? answer({ status: "ok", detail }) : answer(UNAVAILABLE, 404);
    } catch {
      return answer({ status: "error", error: "Context could not be read. Try again." }, 503);
    }
  };
}
