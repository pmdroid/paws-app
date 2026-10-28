import { journalCaught } from "../journal";
import { runnerFailureStatus } from "../runner-work";
import { RUN_FILE_KINDS, type RunFileKind } from "./kinds";
import { RunFileStorageError } from "./store";

export type RunFileAccess = { runnerId: string; runId: string; token: string };

/**
 * `POST /v1/runs/:id/<segment>/<action>` on the runner channel, under the run grant. Fences map
 * to 409, storage, a busy database and a timed-out body to 503, and everything else to 403.
 */
export function createRunFileHttp(options: {
  kind: RunFileKind;
  segment: string;
  actions: readonly string[];
  failure: string;
  handle(action: string, raw: unknown, access: RunFileAccess): Promise<Response>;
  /** Journal every failure under this event. */
  journal?: string;
}) {
  const { noun } = RUN_FILE_KINDS[options.kind];
  const Noun = noun[0]!.toUpperCase() + noun.slice(1);
  const pattern = new RegExp(
    `^\\/v1\\/runs\\/([^/]+)\\/${options.segment}\\/(${options.actions.join("|")})$`,
  );
  return async (request: Request, runnerId: string): Promise<Response | null> => {
    const match = pattern.exec(new URL(request.url).pathname);
    if (!match) return null;
    try {
      const authorization = request.headers.get("authorization");
      if (
        request.method !== "POST" ||
        !authorization ||
        !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization) ||
        request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json"
      )
        throw new Error(`${Noun} grant and JSON are required`);
      const raw = await boundedJson(request, Noun);
      const access = {
        runnerId,
        runId: decodeURIComponent(match[1]!),
        token: authorization.slice(7),
      };
      return await options.handle(match[2]!, raw, access);
    } catch (error) {
      if (options.journal) journalCaught(error, options.journal, null);
      return Response.json(
        { error: options.failure },
        {
          status: error instanceof RunFileStorageError ? 503 : runnerFailureStatus(error),
          headers: { "cache-control": "no-store" },
        },
      );
    }
  };
}

async function boundedJson(request: Request, Noun: string): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error(`${Noun} body is required`);
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
      if (size > 737_280) throw new Error(`${Noun} request is too large`);
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
