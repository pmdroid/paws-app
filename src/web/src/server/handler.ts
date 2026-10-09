import { existsSync, readFileSync } from "node:fs";
import { join, posix, sep } from "node:path";
import {
  parseStatusSnapshot,
  STATUS_API_PATH,
  STATUS_PAGE_PATH,
  type StatusSnapshot,
} from "../contract";
import { demoStatus } from "../demo";

export interface StatusProvider {
  snapshot(): StatusSnapshot | Promise<StatusSnapshot>;
}

export interface StatusServerOptions {
  provider: StatusProvider;
  /**
   * Directory from `bun run build:status` (`index.html`, `config.json`, `assets/`).
   * Omit it to use `src/web/dist` when that build exists. Pass `null` to skip files.
   */
  staticDir?: string | null;
}

export function fakeStatusProvider(): StatusProvider {
  return {
    snapshot() {
      return demoStatus();
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
  if (pathname === STATUS_API_PATH) return apiResponse(request, options.provider);
  if (pathname === STATUS_PAGE_PATH || pathname.startsWith(`${STATUS_PAGE_PATH}/`)) {
    const staticDir = options.staticDir === undefined ? defaultStaticDir() : options.staticDir;
    return pageResponse(request, staticDir);
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
  staticDir?: string | null;
}): ReturnType<typeof Bun.serve> {
  const hostname = options?.hostname ?? "127.0.0.1";
  const port = options?.port ?? 8787;
  const provider = options?.provider ?? fakeStatusProvider();
  const staticDir = options && "staticDir" in options ? options.staticDir : defaultStaticDir();
  return Bun.serve({
    hostname,
    port,
    async fetch(request) {
      const response = await handleStatusRequest(request, {
        provider,
        staticDir: staticDir ?? null,
      });
      if (response) return response;
      return text("Not found", 404);
    },
  });
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
  } catch {
    return json({ error: "status unavailable" }, 500);
  }
}

function pageResponse(request: Request, staticDir: string | null): Response {
  if (request.method !== "GET" && request.method !== "HEAD") return text("Method not allowed", 405);
  const url = new URL(request.url);
  const relative =
    url.pathname === STATUS_PAGE_PATH ? "index.html" : relativePagePath(url.pathname);
  if (!relative) return text("Not found", 404);
  if (relative === "index.html" || !isPublicFile(relative)) return indexHtml(staticDir);
  if (!staticDir) return text("Not found", 404);
  const file = safeFile(staticDir, relative);
  if (!file || !existsSync(file)) {
    if (relative.startsWith("assets/")) return text("Not found", 404);
    return indexHtml(staticDir);
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

function relativePagePath(pathname: string): string | null {
  const prefix = `${STATUS_PAGE_PATH}/`;
  if (!pathname.startsWith(prefix)) return null;
  const raw = pathname.slice(prefix.length);
  if (!raw) return "index.html";
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
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
  return (
    relative === "index.html" ||
    relative === "config.json" ||
    /^assets\/[A-Za-z0-9._-]+$/.test(relative)
  );
}

function safeFile(staticDir: string, relative: string): string | null {
  const root = join(staticDir);
  const target = join(root, relative);
  if (target !== root && !target.startsWith(root + sep)) return null;
  return target;
}

function indexHtml(staticDir: string | null): Response {
  const file = staticDir ? safeFile(staticDir, "index.html") : null;
  const body = file && existsSync(file) ? readFileSync(file, "utf8") : MISSING_PAGE;
  return html(withBase(body));
}

/** Engine pages live at `/status`, so relative asset URLs need that base. The Vercel build does not. */
function withBase(body: string): string {
  if (body.includes("<base ")) return body;
  const tag = '<base href="/status/" />';
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
