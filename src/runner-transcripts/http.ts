import { SQLiteError } from "bun:sqlite";
import { RunnerTranscriptStorageError, type RunnerTranscripts } from "./store";
import { RunnerWorkFencedError } from "../runner-work";
import { RunnerTranscriptChunkSchema, RunnerTranscriptFinishSchema } from "./schema";

export function createRunnerTranscriptsHttp(transcripts: RunnerTranscripts) {
  return async (request: Request, runnerId: string): Promise<Response | null> => {
    const match = /^\/v1\/runs\/([^/]+)\/transcript\/(chunks|finish)$/.exec(
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
        throw new Error("Transcript grant and JSON are required");
      const reader = request.body?.getReader();
      if (!reader) throw new Error("Transcript body is required");
      const deadline = AbortSignal.timeout(10_000);
      const abort = () => void reader.cancel().catch(() => undefined);
      request.signal.addEventListener("abort", abort, { once: true });
      deadline.addEventListener("abort", abort, { once: true });
      let raw: unknown;
      try {
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
          request.signal.throwIfAborted();
          deadline.throwIfAborted();
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 737_280) throw new Error("Transcript request is too large");
          chunks.push(part.value);
        }
        request.signal.throwIfAborted();
        deadline.throwIfAborted();
        raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } finally {
        request.signal.removeEventListener("abort", abort);
        deadline.removeEventListener("abort", abort);
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      const access = {
        runnerId,
        runId: decodeURIComponent(match[1]!),
        token: authorization.slice(7),
      };
      const result =
        match[2] === "chunks"
          ? await transcripts.upload(access, RunnerTranscriptChunkSchema.parse(raw))
          : await transcripts.finish(access, RunnerTranscriptFinishSchema.parse(raw));
      return Response.json(result, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      return Response.json(
        { error: "Runner transcript request failed" },
        {
          status:
            error instanceof RunnerWorkFencedError
              ? 409
              : error instanceof RunnerTranscriptStorageError ||
                  (error instanceof SQLiteError && [5, 6, 10, 13].includes(error.errno & 255))
                ? 503
                : 403,
          headers: { "cache-control": "no-store" },
        },
      );
    }
  };
}
