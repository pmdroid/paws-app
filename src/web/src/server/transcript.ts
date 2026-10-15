import { getRun, getWorkItem, linearSessionForEpic } from "../../../db";
import { fullAgentTranscript } from "../live/transcript";
import { dashboardOrigin } from "./request-origin";
import type { StatusServerOptions } from "./handler";

export function handleAgentTranscriptRequest(
  request: Request,
  options: StatusServerOptions,
): Response | null {
  const url = new URL(request.url);
  if (url.pathname !== "/api/runs/transcript") return null;
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Type": "text/plain; charset=utf-8",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
  if (!dashboardOrigin(request, options.trustedOrigin))
    return new Response("Forbidden", { status: 403, headers });
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response("Method not allowed", { status: 405, headers });
  const runId = url.searchParams.get("run") ?? "";
  if (!options.db || !/^[A-Za-z0-9_-]{1,128}$/.test(runId))
    return new Response("Not found", { status: 404, headers });
  const run = getRun(options.db, runId);
  const item = run ? getWorkItem(options.db, run.itemId) : null;
  const session = item ? (item.sessionKey ?? linearSessionForEpic(options.db, item.epicId)) : null;
  if (
    !run ||
    !item ||
    (options.sessionIds !== undefined && (!session || !options.sessionIds.includes(session)))
  )
    return new Response("Not found", { status: 404, headers });
  if (request.method === "HEAD") return new Response(null, { headers });
  const entries = fullAgentTranscript(
    options.closeoutHome ?? options.env?.PAWS_HOME,
    runId,
    new Date(run.createdAt).toISOString(),
    options.env ?? process.env,
  );
  const iterator = entries[Symbol.iterator]();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      try {
        const entry = iterator.next();
        if (entry.done) controller.close();
        else
          controller.enqueue(
            encoder.encode(`${entry.value.at} ${entry.value.kind}\n${entry.value.text}\n\n`),
          );
      } catch (error) {
        iterator.return(undefined);
        controller.error(error);
      }
    },
    cancel() {
      iterator.return(undefined);
    },
  });
  return new Response(stream, { headers });
}
