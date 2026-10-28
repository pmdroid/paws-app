import { createRunFileHttp } from "../run-files";
import type { AgentSessions } from "./store";
import {
  AgentSessionChunkSchema,
  AgentSessionFinishSchema,
  AgentSessionReadSchema,
} from "./schema";

/** `POST /v1/runs/:id/session/{chunks,finish,read}` on the runner channel, under the run grant. */
export function createAgentSessionsHttp(sessions: AgentSessions) {
  return createRunFileHttp({
    kind: "agent_session",
    segment: "session",
    actions: ["chunks", "finish", "read"],
    failure: "Agent session request failed",
    async handle(action, raw, access) {
      if (action === "read") {
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
        action === "chunks"
          ? await sessions.upload(access, AgentSessionChunkSchema.parse(raw))
          : await sessions.finish(access, AgentSessionFinishSchema.parse(raw));
      return Response.json(result, { headers: { "cache-control": "no-store" } });
    },
  });
}
