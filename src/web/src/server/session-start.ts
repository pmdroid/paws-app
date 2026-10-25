import { timingSafeEqual } from "node:crypto";
import {
  LINEAR_SESSION_API_PATH,
  parseLinearSessionTarget,
  type LinearSessionTarget,
  type StartedLinearSession,
} from "../session-start";
import { processCsrfToken } from "./csrf";
import { dashboardOrigin } from "./request-origin";

export type StartLinearSession = (
  target: LinearSessionTarget,
  dashboardUrl: string,
  signal?: AbortSignal,
) => Promise<StartedLinearSession>;

export async function handleSessionStartRequest(
  request: Request,
  options: {
    startLinearSession?: StartLinearSession;
    csrfToken?: string;
    trustedOrigin?: string;
  },
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== LINEAR_SESSION_API_PATH) return null;
  if (!dashboardOrigin(request, options.trustedOrigin))
    return json({ error: "Start sessions from the local Paws dashboard." }, 403);
  if (request.method === "GET")
    return json({ available: options.startLinearSession !== undefined });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const received = Buffer.from(request.headers.get("x-paws-csrf") ?? "");
  const expected = Buffer.from(options.csrfToken ?? processCsrfToken());
  if (received.length !== expected.length || !timingSafeEqual(received, expected))
    return json({ error: "Reload the local dashboard and try again." }, 403);
  if (options.startLinearSession === undefined)
    return json(
      { error: "Connect your Linear workspace through the Paws website, then try again." },
      503,
    );
  let target: LinearSessionTarget;
  try {
    if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json")
      throw new Error("Expected a JSON session target.");
    const reader = request.body?.getReader();
    if (!reader) throw new Error("Enter a Linear issue or comment link.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 4096) {
          await reader.cancel();
          throw new Error("The Linear link is too long.");
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !("target" in body) ||
      typeof body.target !== "string"
    )
      throw new Error("Enter a Linear issue identifier or comment link.");
    target = parseLinearSessionTarget(body.target);
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : "Invalid Linear session target." },
      400,
    );
  }
  try {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]);
    return json(
      await options.startLinearSession(target, new URL("/status/", url.origin).href, signal),
      201,
    );
  } catch {
    return json(
      {
        error:
          "Linear could not start the session. Check the issue or root comment link and your connection.",
      },
      502,
    );
  }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}
