import { journalCaught } from "../journal";
import { existsSync, readFileSync } from "node:fs";
import { join, posix, sep } from "node:path";
import type { Database } from "bun:sqlite";
import {
  parseStatusItemDetail,
  parseStatusSnapshot,
  STATUS_API_PATH,
  STATUS_ITEM_API_PATH,
  STATUS_PAGE_PATH,
  type StatusItemDetail,
  type StatusSnapshot,
} from "../contract";
import {
  createLiveStatusProvider,
  emptyLiveSnapshot,
  type LiveStatusOptions,
} from "../live/provider";
import { ARTIFACT_API_PATH, readCloseoutArtifact } from "./artifact";
import { handleLinearArtifactRequest, type ReadLinearArtifact } from "./linear-artifact";
import { injectCsrf } from "./csrf";
import { handleSessionStartRequest, type StartLinearSession } from "./session-start";
import { handleAgentTranscriptRequest } from "./transcript";

export interface StatusProvider {
  snapshot(): StatusSnapshot | Promise<StatusSnapshot>;
  /** One issue for its page. Null, or no reader, answers 404. */
  item?(id: string): StatusItemDetail | null | Promise<StatusItemDetail | null>;
}

export interface StatusServerOptions {
  sessionIds?: readonly string[];
  trustedOrigin?: string;
  /**
   * Live reader for `/api/status`.
   * Omit it and pass `db` to read the engine database. Omit both for an empty
   * live snapshot (`source: "live"`, no items).
   */
  provider?: StatusProvider;
  /** Opened engine database. Ignored when `provider` is set. */
  db?: Database;
  /**
   * Directory from `bun run build:status` (`index.html`, `assets/`).
   * Omit it to use `src/web/dist` when that build exists. Pass `null` to skip files.
   */
  staticDir?: string | null;
  /** Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  csrfToken?: string;
  closeoutHome?: string;
  evidenceRoot?: string;
  readLinearArtifact?: ReadLinearArtifact;
  startLinearSession?: StartLinearSession;
  linearUsage?: LiveStatusOptions["linearUsage"];
}

export function fakeStatusProvider(): StatusProvider {
  return {
    snapshot() {
      return emptyLiveSnapshot();
    },
    item() {
      return null;
    },
  };
}

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Accept, Content-Type, ngrok-skip-browser-warning",
  "Access-Control-Max-Age": "86400",
};

/**
 * Status routes only. Returns null for every other path so the engine can
 * keep routing webhooks itself.
 */
export async function handleStatusRequest(
  request: Request,
  options: StatusServerOptions,
): Promise<Response | null> {
  const url = new URL(request.url);
  const { pathname } = url;
  if (pathname === "/") {
    if (request.method !== "GET" && request.method !== "HEAD")
      return text("Method not allowed", 405);
    return new Response(null, {
      status: 307,
      headers: { Location: `${STATUS_PAGE_PATH}/${url.search}`, "Cache-Control": "no-store" },
    });
  }
  const evidence = /^\/evidence\/([0-9A-HJKMNP-TV-Z]{26})\/?$/.exec(pathname);
  if (evidence) {
    if (request.method !== "GET" && request.method !== "HEAD")
      return text("Method not allowed", 405);
    return new Response(null, {
      status: 307,
      headers: {
        Location: `${STATUS_PAGE_PATH}/evidence/${evidence[1]}${url.search}`,
        "Cache-Control": "no-store",
      },
    });
  }
  const transcript = handleAgentTranscriptRequest(request, options);
  if (transcript !== null) return transcript;
  const artifact = await handleLinearArtifactRequest(
    request,
    options.readLinearArtifact,
    options.trustedOrigin,
  );
  if (artifact !== null) return artifact;
  const session = await handleSessionStartRequest(request, options);
  if (session !== null) return session;
  if (pathname === STATUS_API_PATH) return apiResponse(request, providerFor(options));
  if (pathname.startsWith(`${STATUS_ITEM_API_PATH}/`))
    return itemResponse(request, providerFor(options), pathname);
  if (pathname === ARTIFACT_API_PATH) return artifactResponse(request, options);
  if (pathname === STATUS_PAGE_PATH || pathname.startsWith(`${STATUS_PAGE_PATH}/`)) {
    const staticDir = options.staticDir === undefined ? defaultStaticDir() : options.staticDir;
    return pageResponse(request, staticDir, options.csrfToken);
  }
  return null;
}

/** HTML for `GET /status`, including the fallback when the static build is missing. */
export function statusResponse(): Response {
  return pageResponse(new Request("http://127.0.0.1/status"), defaultStaticDir());
}

export function startStatusServer(options?: {
  port?: number;
  hostname?: string;
  provider?: StatusProvider;
  db?: Database;
  staticDir?: string | null;
  env?: Record<string, string | undefined>;
  closeoutHome?: string;
  evidenceRoot?: string;
}): ReturnType<typeof Bun.serve> {
  const hostname = options?.hostname ?? "127.0.0.1";
  const port = options?.port ?? 8787;
  const provider = liveProvider(options);
  const staticDir = options && "staticDir" in options ? options.staticDir : defaultStaticDir();
  const env = options?.env;
  return Bun.serve({
    hostname,
    port,
    async fetch(request) {
      const response = await handleStatusRequest(request, {
        provider,
        ...(options?.db ? { db: options.db } : {}),
        staticDir: staticDir ?? null,
        ...(env ? { env } : {}),
        ...(options?.closeoutHome ? { closeoutHome: options.closeoutHome } : {}),
        ...(options?.evidenceRoot ? { evidenceRoot: options.evidenceRoot } : {}),
      });
      if (response) return response;
      return text("Not found", 404);
    },
  });
}

/** The serving process is the dashboard's only data source. */
export function providerFor(options: StatusServerOptions): StatusProvider {
  return liveProvider(options);
}

function liveProvider(options?: {
  sessionIds?: readonly string[];
  provider?: StatusProvider;
  db?: Database;
  env?: Record<string, string | undefined>;
  closeoutHome?: string;
  linearUsage?: LiveStatusOptions["linearUsage"];
}): StatusProvider {
  if (options?.provider) return options.provider;
  if (options?.db) {
    return createLiveStatusProvider(options.db, {
      ...(options.sessionIds === undefined ? {} : { sessionIds: options.sessionIds }),
      ...(options.env ? { env: options.env } : {}),
      ...(options.closeoutHome ? { pawsHome: options.closeoutHome } : {}),
      ...(options.linearUsage ? { linearUsage: options.linearUsage } : {}),
    });
  }
  return { snapshot: () => emptyLiveSnapshot(), item: () => null };
}

function artifactResponse(request: Request, options: StatusServerOptions): Response {
  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers: { ...CORS } });
  if (request.method !== "GET" && request.method !== "HEAD") return text("Method not allowed", 405);
  const home = artifactHome(options);
  if (options.db === undefined || home === null) return text("Not found", 404);
  const url = new URL(request.url);
  const read = readCloseoutArtifact({
    ...(options.sessionIds === undefined ? {} : { sessionIds: options.sessionIds }),
    db: options.db,
    itemId: url.searchParams.get("item") ?? "",
    checkId: url.searchParams.get("check") ?? "",
    kind: url.searchParams.get("kind") ?? "",
    head: url.searchParams.get("head") ?? "",
    policy: url.searchParams.get("policy") ?? "",
    evidenceRoot: home,
    ...(options.env ? { env: options.env } : {}),
  });
  return new Response(read.status === 200 ? read.body : "Not found", {
    status: read.status,
    headers: {
      ...CORS,
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function artifactHome(options: StatusServerOptions): string | null {
  if (options.evidenceRoot !== undefined && options.evidenceRoot.length > 0)
    return options.evidenceRoot;
  const home =
    options.closeoutHome !== undefined && options.closeoutHome.length > 0
      ? options.closeoutHome
      : (options.env ?? process.env).PAWS_HOME;
  if (home !== undefined && home.length > 0) return join(home, "closeout", "evidence");
  return null;
}

async function apiResponse(request: Request, provider: StatusProvider): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...CORS } });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ error: "Method not allowed" }, 405);
  }
  try {
    const snapshot = await provider.snapshot();
    const parsed = parseStatusSnapshot(snapshot);
    if (!parsed.ok) return json({ error: parsed.error }, 500);
    return json(parsed.snapshot, 200);
  } catch (caughtError1) {
    journalCaught(caughtError1, "handler.apiResponse.snapshot", null);
    return json({ error: "status unavailable" }, 500);
  }
}

async function itemResponse(
  request: Request,
  provider: StatusProvider,
  pathname: string,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...CORS } });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ error: "Method not allowed" }, 405);
  }
  const id = itemId(pathname.slice(STATUS_ITEM_API_PATH.length + 1));
  if (id === null || provider.item === undefined) return json({ error: "Not found" }, 404);
  try {
    const detail = await provider.item(id);
    // An item outside the reader's sessions answers like one that does not exist.
    if (detail === null) return json({ error: "Not found" }, 404);
    const parsed = parseStatusItemDetail(detail);
    if (!parsed.ok) return json({ error: parsed.error }, 500);
    return json(parsed.detail, 200);
  } catch (caughtError3) {
    journalCaught(caughtError3, "handler.itemResponse.item", null);
    return json({ error: "status unavailable" }, 500);
  }
}

function itemId(raw: string): string | null {
  try {
    const id = decodeURIComponent(raw);
    return /^[^/\\\0]{1,128}$/.test(id) && id.trim() === id ? id : null;
  } catch (caughtError4) {
    journalCaught(caughtError4, "handler.itemId.decodeURIComponent", null);
    return null;
  }
}

function pageResponse(request: Request, staticDir: string | null, csrfToken?: string): Response {
  if (request.method !== "GET" && request.method !== "HEAD") return text("Method not allowed", 405);
  const url = new URL(request.url);
  const relative =
    url.pathname === STATUS_PAGE_PATH ? "index.html" : relativePagePath(url.pathname);
  if (!relative || removedPage(relative)) return text("Not found", 404);
  if (/^runs\/[A-Za-z0-9_-]{1,128}\/transcript\/?$/.test(relative))
    return pageHtml(staticDir, "transcript.html", csrfToken);
  if (relative === "index.html" || !isPublicFile(relative)) return indexHtml(staticDir, csrfToken);
  if (!staticDir) return text("Not found", 404);
  const file = safeFile(staticDir, relative);
  if (!file || !existsSync(file)) {
    if (relative.startsWith("assets/")) return text("Not found", 404);
    return indexHtml(staticDir, csrfToken);
  }
  const cache = relative.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-store";
  return new Response(Bun.file(file), {
    headers: {
      "Content-Type": contentType(file),
      "Cache-Control": cache,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** Pages the dashboard no longer has. They 404 instead of falling back to the app. */
const REMOVED_PAGES = ["projects"];

function removedPage(relative: string): boolean {
  const head = relative.split("/")[0];
  return head !== undefined && REMOVED_PAGES.includes(head);
}

function relativePagePath(pathname: string): string | null {
  const prefix = `${STATUS_PAGE_PATH}/`;
  if (!pathname.startsWith(prefix)) return null;
  const raw = pathname.slice(prefix.length);
  if (!raw) return "index.html";
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch (caughtError2) {
    journalCaught(caughtError2, "handler.relativePagePath.decodeURIComponent", null);
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const normalized = posix.normalize(decoded).replace(/^\.\//, "");
  if (normalized === "" || normalized === ".") return "index.html";
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../"))
    return null;
  return normalized;
}

function isPublicFile(relative: string): boolean {
  return relative === "index.html" || /^assets\/[A-Za-z0-9._-]+$/.test(relative);
}

function safeFile(staticDir: string, relative: string): string | null {
  const root = join(staticDir);
  const target = join(root, relative);
  if (target !== root && !target.startsWith(root + sep)) return null;
  return target;
}

function indexHtml(staticDir: string | null, csrfToken?: string): Response {
  return pageHtml(staticDir, "index.html", csrfToken);
}

function pageHtml(staticDir: string | null, name: string, csrfToken?: string): Response {
  const file = staticDir ? safeFile(staticDir, name) : null;
  const body = file && existsSync(file) ? readFileSync(file, "utf8") : MISSING_PAGE;
  return html(injectCsrf(withBase(body), csrfToken));
}

/** Engine pages live at `/status`, so relative asset URLs need that base. */
function withBase(body: string): string {
  const tag = '<base href="/status/" />';
  if (body.includes('<base href="/" />')) return body.replace('<base href="/" />', tag);
  if (body.includes("<base ")) return body;
  if (body.includes("<head>")) return body.replace("<head>", `<head>\n    ${tag}`);
  return `${tag}\n${body}`;
}

function defaultStaticDir(): string | null {
  const dir = join(import.meta.dir, "../../dist");
  return existsSync(join(dir, "index.html")) ? dir : null;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function text(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" },
  });
}

function html(body: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function contentType(file: string): string {
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".woff2")) return "font/woff2";
  return "text/html; charset=utf-8";
}

const MISSING_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Paws status</title>
</head>
<body>
<p>Paws status dashboard is not built. From the repo root run <code>bun run build:status</code>.</p>
</body>
</html>
`;
