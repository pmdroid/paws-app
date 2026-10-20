import { z } from "zod";
import { RunnerHostStatusSchema } from "../runner-protocol";
import { RunnerEventSchema, RunnerWorkFencedError, type RunnerWork } from "./control";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const generation = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const empty = z.strictObject({});
const heartbeat = RunnerHostStatusSchema.extend({
  capacity: z.number().int().min(1).max(16).optional(),
  ceiling: z.number().int().min(1).max(16).optional(),
});
const grant = z.strictObject({ commandId: id, generation });
const event = z.strictObject({
  runId: id,
  generation,
  sequence: generation,
  event: RunnerEventSchema,
});

export function createRunnerWorkHttp(work: RunnerWork) {
  return async (request: Request, runnerId: string): Promise<Response | null> => {
    const path = new URL(request.url).pathname;
    try {
      if (path === "/v1/commands" && request.method === "GET")
        return json({ commands: work.commands(runnerId) });
      if (path === "/v1/heartbeat" && request.method === "POST") {
        const { capacity, ceiling, ...host } = heartbeat.parse(await body(request));
        return json(work.heartbeat(runnerId, capacity ?? 1, host, ceiling));
      }
      const acknowledgment = /^\/v1\/commands\/([^/]+)\/ack$/.exec(path);
      if (acknowledgment && request.method === "POST") {
        empty.parse(await body(request));
        work.acknowledge(runnerId, id.parse(decodeURIComponent(acknowledgment[1]!)));
        return json({ ok: true });
      }
      const permission = /^\/v1\/runs\/([^/]+)\/grant$/.exec(path);
      if (permission && request.method === "POST") {
        const input = grant.parse(await body(request));
        return json(
          work.issueGrant({
            ...input,
            runnerId,
            runId: id.parse(decodeURIComponent(permission[1]!)),
          }),
        );
      }
      if (path === "/v1/events" && request.method === "POST") {
        const authorization = request.headers.get("authorization");
        if (!authorization || !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization))
          return json({ error: "A run grant is required." }, 403);
        const input = event.parse(await body(request, 1_048_576));
        return json(work.event({ ...input, runnerId, token: authorization.slice(7) }));
      }
      return null;
    } catch (error) {
      if (error instanceof RunnerWorkFencedError)
        return json({ error: "Runner work is fenced.", code: "fenced" }, 409);
      return json({ error: "Runner work request is denied or invalid." }, 403);
    }
  };
}

async function body(request: Request, limit = 73_728) {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json")
    throw new Error("JSON is required.");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("JSON is required");
  const timeout = AbortSignal.timeout(10_000);
  const cancel = () => void reader.cancel().catch(() => undefined);
  timeout.addEventListener("abort", cancel, { once: true });
  request.signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      timeout.throwIfAborted();
      request.signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > limit) throw new Error("Runner work input is too large");
      chunks.push(part.value);
    }
    timeout.throwIfAborted();
    request.signal.throwIfAborted();
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    timeout.removeEventListener("abort", cancel);
    request.signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}
