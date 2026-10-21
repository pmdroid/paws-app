import { repoApiPath } from "./client";
import type { CiCheck, GitHubClient } from "./types";

/** Lines of a failed check's log kept for the run page and the agent's handoff. */
export const LOG_TAIL_LINES = 60;
const LOG_TAIL_CHARS = 8_000;

type LogTailInput = {
  client: GitHubClient;
  token: string;
  owner: string;
  repo: string;
  actionsJob: number | null;
  summary: string | null;
};

/**
 * The tail of a failed check's log: the GitHub Actions job log when the check
 * is an Actions job, otherwise the check's summary text. Null when neither is
 * readable; a failed read never fails the CI round.
 */
export async function readLogTail(
  input: LogTailInput,
): Promise<Pick<CiCheck, "logTail" | "logSource">> {
  if (input.actionsJob !== null) {
    try {
      const response = await input.client.request({
        method: "GET",
        path: repoApiPath(input.owner, input.repo, `/actions/jobs/${input.actionsJob}/logs`),
        token: input.token,
      });
      const log = response.status === 200 ? (response.text ?? "") : "";
      if (log.trim() !== "") return { logTail: tail(stripTimestamps(log)), logSource: "actions" };
    } catch {
      // Fall back to the summary below.
    }
  }
  return input.summary === null
    ? { logTail: null, logSource: null }
    : { logTail: tail(input.summary), logSource: "summary" };
}

/** Actions prefixes every line with an ISO timestamp. */
function stripTimestamps(log: string): string {
  return log.replace(/^﻿?\d{4}-\d{2}-\d{2}T[\d:.]+Z ?/gm, "");
}

function tail(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").trimEnd().split("\n");
  const kept = lines.slice(-LOG_TAIL_LINES).join("\n");
  return redactTokens(kept.length > LOG_TAIL_CHARS ? kept.slice(-LOG_TAIL_CHARS) : kept);
}

function redactTokens(text: string): string {
  return text.replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, "[redacted]");
}
