import { repoApiPath } from "./client";
import type { GitHubClient } from "./types";

export type CiCheckState = "passed" | "failed" | "running" | "pending" | "skipped";

/** The end of a failing check's output: the Actions job log, or the check's summary text. */
export type CiCheckLog = { source: "actions" | "summary"; text: string };

/** One check on a pull request's head commit, as Paws shows it and hands it to the agent. */
export type CiCheck = {
  name: string;
  state: CiCheckState;
  url: string | null;
  startedAt: string | null;
  completedAt: string | null;
  log: CiCheckLog | null;
};

export const LOG_TAIL_LINES = 60;
export const LOG_TAIL_CHARS = 6000;

/**
 * Reads the tail of an Actions job log. The App token may lack `actions: read`,
 * and other CI apps have no log API, so anything else falls back to the summary.
 */
export async function readLogTail(input: {
  client: GitHubClient;
  token: string;
  owner: string;
  repo: string;
  actionsJob: number | null;
  summary: string | null;
}): Promise<CiCheckLog | null> {
  if (input.actionsJob !== null) {
    try {
      const response = await input.client.request({
        method: "GET",
        path: repoApiPath(input.owner, input.repo, `/actions/jobs/${input.actionsJob}/logs`),
        token: input.token,
        responseType: "text",
      });
      if (response.status === 200 && typeof response.body === "string") {
        const text = logTail(response.body);
        if (text !== "") return { source: "actions", text };
      }
    } catch {
      // Fall through to the summary.
    }
  }
  const summary = logTail(input.summary ?? "");
  return summary === "" ? null : { source: "summary", text: summary };
}

/** The last {@link LOG_TAIL_LINES} lines without Actions timestamps, colour codes or tokens. */
export function logTail(text: string): string {
  const lines = text
    .replaceAll("\r\n", "\n")
    // oxlint-disable-next-line no-control-regex -- colour codes in CI logs are the input
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, "[redacted]")
    .split("\n")
    .map((line) => line.replace(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z ?/, "").trimEnd());
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  const tail = lines.slice(-LOG_TAIL_LINES).join("\n");
  if (tail.length <= LOG_TAIL_CHARS) return tail;
  const cut = tail.slice(-LOG_TAIL_CHARS);
  const newline = cut.indexOf("\n");
  return newline === -1 ? cut : cut.slice(newline + 1);
}
