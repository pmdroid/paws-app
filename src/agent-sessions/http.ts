import { SQLiteError } from "bun:sqlite";
import { RunnerWorkFencedError } from "../runner-work";
import { AgentSessionStorageError, type AgentSessions } from "./store";
import {
  AgentSessionChunkSchema,
  AgentSessionFinishSchema,
  AgentSessionReadSchema,
} from "./schema";

/** `POST /v1/runs/:id/session/{chunks,finish,read}` on the runner channel, under the run grant. */
export function createAgentSessionsHttp(sessions: AgentSessions) {
  return async (request: Request, runnerId: string): Promise<Response | null> => {
    const match = /^\/v1\/runs\/([^/]+)\/session\/(chunks|finish|read)$/.exec(
      new URL(request.url).pathname,
    );
    if (!match) return null;
    try {
      const authorization = request.headers.get("authorization");
      if (
        request.method !== "POST" ||
        !authorization ||
        !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization) ||
        request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json"
      )
        throw new Error("Agent session grant and JSON are required");
      const raw = await boundedJson(request);
      const access = {
        runnerId,
        runId: decodeURIComponent(match[1]!),
        token: authorization.slice(7),
      };
      if (match[2] === "read") {
        const body = AgentSessionReadSchema.parse(raw);
        const chunks = sessions.read(
          { ...access, generation: body.generation },
          body.snapshotGeneration,
        );
        const snapshot = sessions.snapshot(access.runId, body.snapshotGeneration)!;
        const first = await chunks.next();
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              if (first.done) controller.close();
              else controller.enqueue(first.value);
            },
            async pull(controller) {
              if (first.done) return;
              try {
                const part = await chunks.next();
                if (part.done) controller.close();
                else controller.enqueue(part.value);
              } catch (error) {
                controller.error(error);
              }
            },
            async cancel() {
              await chunks.return(undefined);
            },
          }),
          {
            headers: {
              "cache-control": "no-store",
              "content-type": "application/octet-stream",
              "content-length": String(snapshot.sealedSize),
              "x-paws-session-sha256": snapshot.sha256!,
            },
          },
        );
      }
      const result =
        match[2] === "chunks"
          ? await sessions.upload(access, AgentSessionChunkSchema.parse(raw))
          : await sessions.finish(access, AgentSessionFinishSchema.parse(raw));
      return Response.json(result, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      return Response.json(
        { error: "Agent session request failed" },
        {
          status:
            error instanceof RunnerWorkFencedError
              ? 409
              : error instanceof AgentSessionStorageError ||
                  (error instanceof SQLiteError && [5, 6, 10, 13].includes(error.errno & 255))
                ? 503
                : 403,
          headers: { "cache-control": "no-store" },
        },
      );
    }
  };
}

async function boundedJson(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Agent session body is required");
  const deadline = AbortSignal.timeout(10_000);
  const abort = () => void reader.cancel().catch(() => undefined);
  request.signal.addEventListener("abort", abort, { once: true });
  deadline.addEventListener("abort", abort, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      request.signal.throwIfAborted();
      deadline.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 737_280) throw new Error("Agent session request is too large");
      chunks.push(part.value);
    }
    request.signal.throwIfAborted();
    deadline.throwIfAborted();
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    request.signal.removeEventListener("abort", abort);
    deadline.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
