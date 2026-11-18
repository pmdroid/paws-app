import type { Db } from "../db";
import type { ContextAccess, ContextRequester } from "./policy";
import {
  CONTEXT_VIEW_LIMITS,
  contextViewSupported,
  forgetViewedContextRecord,
  listContextProjects,
  readContextRecord,
  readContextView,
} from "./view";

const NO_STORE = { "cache-control": "no-store, private", vary: "cookie" };

function answer(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

const UNAVAILABLE = { status: "unavailable", error: "This context is not available." };

const ADMIN_ONLY = { status: "forbidden", error: "Only workspace admins can forget context." };

export function createProjectContextHttp(options: {
  db: Db;
  access: ContextAccess;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  return async (
    request: Request,
    requester: ContextRequester,
    currentAdmin?: () => Promise<boolean>,
  ): Promise<Response | null> => {
    const admin = async () => {
      try {
        return (await currentAdmin?.()) === true;
      } catch {
        return false;
      }
    };
    const url = new URL(request.url);
    const parts = url.pathname.split("/").slice(1);
    if (parts[0] !== "api" || parts[1] !== "context") return null;
    const forget = parts.length === 7 && parts[4] === "records" && parts[6] === "forget";
    if (request.method !== (forget ? "POST" : "GET"))
      return answer({ error: forget ? "Forget with POST." : "Context is read-only here." }, 405);
    if (parts[2] === "projects" && parts.length === 3) {
      try {
        const projects = await listContextProjects(options.db, options.access, { requester });
        return answer({ status: "ok", projects });
      } catch {
        return answer({ status: "error", error: "Projects could not be read. Try again." }, 503);
      }
    }
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
    if (forget) {
      if (!(await admin())) return answer(ADMIN_ONLY, 403);
      try {
        const forgotten = await forgetViewedContextRecord(options.db, options.access, {
          requester,
          scope,
          now: now(),
          recordId: recordId ?? "",
        });
        return forgotten
          ? answer({ status: "forgotten", forgotten: { entries: 1 } })
          : answer(UNAVAILABLE, 404);
      } catch {
        return answer(
          { status: "error", error: "The entry could not be forgotten. Try again." },
          503,
        );
      }
    }
    try {
      const isAdmin = await admin();
      if (records === undefined) {
        const number = (name: string, fallback: number) => {
          const value = Number(url.searchParams.get(name) ?? fallback);
          return Number.isFinite(value) ? value : fallback;
        };
        const view = await readContextView(options.db, options.access, {
          requester,
          scope,
          now: now(),
          admin: isAdmin,
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
        admin: isAdmin,
        recordId,
      });
      return detail ? answer({ status: "ok", detail }) : answer(UNAVAILABLE, 404);
    } catch {
      return answer({ status: "error", error: "Context could not be read. Try again." }, 503);
    }
  };
}
