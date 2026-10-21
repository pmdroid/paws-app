import { expect, test } from "bun:test";
import { LOG_TAIL_CHARS, LOG_TAIL_LINES, logTail, readLogTail } from "./check-logs";
import { createFetchGitHubClient } from "./client";

test("a log tail keeps the last lines without timestamps, colour codes or tokens", () => {
  const lines = Array.from(
    { length: LOG_TAIL_LINES + 5 },
    (_, i) => `2026-10-21T10:00:00.0000000Z \u001b[32mline ${i}\u001b[0m`,
  );
  lines.push("2026-10-21T10:00:01Z token ghs_abcdefghijklmnopqrstuvwxyz0123", "", "");
  const tail = logTail(lines.join("\r\n")).split("\n");
  expect(tail).toHaveLength(LOG_TAIL_LINES);
  expect(tail[0]).toBe("line 6");
  expect(tail.at(-1)).toBe("token [redacted]");
});

test("a long log tail is cut to whole lines under the character cap", () => {
  const tail = logTail(Array.from({ length: 50 }, () => "x".repeat(200)).join("\n"));
  expect(tail.length).toBeLessThanOrEqual(LOG_TAIL_CHARS);
  expect(tail.split("\n").every((line) => line.length === 200)).toBe(true);
});

test("an Actions log redirect is followed without the token", async () => {
  const calls: { url: string; auth: string | null; redirect: string | undefined }[] = [];
  const client = createFetchGitHubClient(async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      auth: new Headers(init?.headers).get("authorization"),
      redirect: init?.redirect,
    });
    if (url.startsWith("https://api.github.com/"))
      return new Response(null, {
        status: 302,
        headers: { location: "https://logs.example/job/12?sig=1" },
      });
    return new Response("2026-10-21T10:00:00Z error: boom\n");
  });
  const log = await readLogTail({
    client,
    token: "synthetic-token",
    owner: "o",
    repo: "r",
    actionsJob: 12,
    summary: "summary",
  });
  expect(log).toEqual({ source: "actions", text: "error: boom" });
  expect(calls).toEqual([
    {
      url: "https://api.github.com/repos/o/r/actions/jobs/12/logs",
      auth: "Bearer synthetic-token",
      redirect: "manual",
    },
    { url: "https://logs.example/job/12?sig=1", auth: null, redirect: undefined },
  ]);
});

test("a check without a log or summary has no tail", async () => {
  const client = createFetchGitHubClient(async () => new Response("", { status: 403 }));
  expect(
    await readLogTail({ client, token: "t", owner: "o", repo: "r", actionsJob: 1, summary: null }),
  ).toBeNull();
  expect(
    await readLogTail({
      client,
      token: "t",
      owner: "o",
      repo: "r",
      actionsJob: null,
      summary: " ",
    }),
  ).toBeNull();
});
