import { z } from "zod";
import { RunnerCheckResultSchema } from "../runner-check";
import { RunnerWorkFencedError } from "../runner-work";
import type { RunnerChecks } from "./control";

const delivery = z.strictObject({
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  result: RunnerCheckResultSchema,
  verifierSignature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
});
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);

export function createRunnerChecksHttp(checks: RunnerChecks) {
  return async (request: Request, runnerId: string): Promise<Response | null> => {
    const route = /^\/v1\/runs\/([^/]+)\/check-result$/.exec(new URL(request.url).pathname);
    if (!route) return null;
    try {
      if (
        request.method !== "POST" ||
        request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json"
      )
        throw new Error("JSON POST is required.");
      const authorization = request.headers.get("authorization");
      if (!authorization || !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization))
        throw new Error("A run grant is required.");
      const input = delivery.parse(await body(request));
      return json(
        checks.receive({
          ...input,
          runnerId,
          runId: id.parse(decodeURIComponent(route[1]!)),
          token: authorization.slice(7),
        }),
      );
    } catch (error) {
      if (error instanceof RunnerWorkFencedError)
        return json({ error: "Runner work is fenced.", code: "fenced" }, 409);
      return json({ error: "Runner verification request is denied or invalid." }, 403);
    }
  };
}

async function body(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("JSON is required.");
  const deadline = AbortSignal.timeout(30_000);
  const cancel = () => void reader.cancel().catch(() => undefined);
  deadline.addEventListener("abort", cancel, { once: true });
  request.signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      deadline.throwIfAborted();
      request.signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 13 * 1024 * 1024) throw new Error("Runner verification input is too large.");
      chunks.push(part.value);
    }
    deadline.throwIfAborted();
    request.signal.throwIfAborted();
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    deadline.removeEventListener("abort", cancel);
    request.signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}
