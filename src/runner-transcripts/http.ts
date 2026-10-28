import { createRunFileHttp } from "../run-files";
import type { RunnerTranscripts } from "./store";
import { RunnerTranscriptChunkSchema, RunnerTranscriptFinishSchema } from "./schema";

/** `POST /v1/runs/:id/transcript/{chunks,finish}` on the runner channel, under the run grant. */
export function createRunnerTranscriptsHttp(transcripts: RunnerTranscripts) {
  return createRunFileHttp({
    kind: "transcript",
    segment: "transcript",
    actions: ["chunks", "finish"],
    failure: "Runner transcript request failed",
    journal: "http.createRunnerTranscriptsHttp.get",
    async handle(action, raw, access) {
      const result =
        action === "chunks"
          ? await transcripts.upload(access, RunnerTranscriptChunkSchema.parse(raw))
          : await transcripts.finish(access, RunnerTranscriptFinishSchema.parse(raw));
      return Response.json(result, { headers: { "cache-control": "no-store" } });
    },
  });
}
