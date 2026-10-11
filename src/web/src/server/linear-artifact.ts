export type ReadLinearArtifact = (
  id: string,
  signal?: AbortSignal,
) => Promise<{
  bytes: Uint8Array;
  mimeType: string;
  displayName: string;
} | null>;

const PATH = "/api/linear/artifacts/";
const RASTER = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export async function handleLinearArtifactRequest(
  request: Request,
  read: ReadLinearArtifact | undefined,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(PATH)) return null;
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    (request.headers.has("host") &&
      request.headers.get("host")?.toLowerCase() !== url.host.toLowerCase()) ||
    (request.headers.has("origin") && request.headers.get("origin") !== url.origin) ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    return response("Forbidden", 403);
  if (request.method !== "GET" && request.method !== "HEAD")
    return response("Method not allowed", 405);
  const id = url.pathname.slice(PATH.length);
  if (
    read === undefined ||
    !/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(id)
  )
    return response("Not found", 404);
  try {
    const artifact = await read(id, request.signal);
    if (artifact === null || artifact.bytes.byteLength > 10 * 1024 * 1024)
      return response("Not found", 404);
    const mimeType = /^[\w.+-]+\/[\w.+-]+$/.test(artifact.mimeType)
      ? artifact.mimeType
      : "application/octet-stream";
    const inline = RASTER.has(mimeType) && url.searchParams.get("download") !== "1";
    const filename = artifact.displayName.replace(/[\r\n\0]/g, "").slice(0, 180) || "artifact";
    const encoded = encodeURIComponent(filename).replace(
      /['()*]/g,
      (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    return new Response(request.method === "HEAD" ? null : new Uint8Array(artifact.bytes), {
      headers: {
        "Content-Type": mimeType,
        "Content-Length": String(artifact.bytes.byteLength),
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${filename.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encoded}`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'",
        "Cross-Origin-Resource-Policy": "same-origin",
      },
    });
  } catch {
    return response("Not found", 404);
  }
}

function response(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}
