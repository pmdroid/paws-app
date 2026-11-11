import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pullRequestReadyResponse } from "./pull-request-response";
import {
  PULL_REQUEST_SUMMARY_LIMIT,
  readTurnSummary,
  transcriptOffset,
  turnSummaryLine,
} from "./turn-summary";

const START = Date.parse("2026-11-10T05:00:00.000Z");

function record(seconds: number, update: Record<string, unknown>): string {
  const t = new Date(START + seconds * 1000).toISOString();
  return `${JSON.stringify({ t, event: { type: "session_update", update } })}\n`;
}

function tool(seconds: number, id: string, kind: string, title: string, toolName?: string) {
  return record(seconds, {
    sessionUpdate: "tool_call",
    toolCallId: id,
    kind,
    title,
    status: "pending",
    ...(toolName ? { _meta: { claudeCode: { toolName } } } : {}),
  });
}

const recorded = [
  record(0, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Looking" } }),
  tool(5, "t1", "read", "Read src/loop/activity.ts", "Read"),
  record(6, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" }),
  tool(10, "t2", "read", "Read src/loop/orchestrator.ts", "Read"),
  tool(10, "t2", "read", "Read src/loop/orchestrator.ts", "Read"),
  tool(20, "t3", "search", "grep pullRequestReady", "Grep"),
  tool(25, "t4", "search", "Find **/*.ts", "Glob"),
  tool(30, "t5", "execute", "bun test", "Bash"),
  tool(60, "t6", "edit", "Edit src/loop/turn-summary.ts", "Edit"),
  tool(90, "t7", "other", "mcp__paws__get_closeout", "mcp__paws__get_closeout"),
  tool(100, "t8", "think", "Update todos", "TodoWrite"),
  record(9 * 60 + 10, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Done" },
  }),
].join("");

test("the turn summary counts a recorded transcript's tool calls and leaves out zero counts", () => {
  expect(turnSummaryLine(recorded)).toBe(
    "Worked for 9 minutes · Read 2 files, searched 2 times, ran 1 command, edited 1 file, used 1 MCP tool.",
  );
  expect(turnSummaryLine(record(0, { sessionUpdate: "plan", entries: [] }))).toBe(
    "Worked for less than a minute.",
  );
  expect(turnSummaryLine("")).toBeNull();
});

test("the turn summary reads only what the turn appended to acp.jsonl", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "turn-summary-")), "acp.jsonl");
  writeFileSync(
    path,
    tool(0, "old", "execute", "earlier turn") + record(3600, { sessionUpdate: "plan" }),
  );
  const offset = await transcriptOffset(path);
  appendFileSync(
    path,
    tool(4000, "w1", "fetch", "WebSearch", "WebSearch") +
      tool(4100, "w2", "fetch", "WebFetch", "WebFetch") +
      tool(4000 + 65 * 60, "e1", "execute", "bun run check"),
  );
  expect(await readTurnSummary(path, offset, "item")).toBe(
    "Worked for 1 hour 5 minutes · Ran 1 command, searched the web 2 times.",
  );
  expect(await transcriptOffset(join(path, "missing"))).toBe(0);
  expect(await readTurnSummary(join(path, "missing"), 0, "item")).toBeNull();
});

test("the pull request response starts with the agent's capped summary and ends with the link and findings", async () => {
  const response = (summary: string) =>
    pullRequestReadyResponse({
      itemId: "item",
      head: "abc",
      pull: { number: 7, url: "https://github.com/o/r/pull/7" },
      risk: null,
      openLine: "Open findings: none.",
      summary,
    });
  const short = await response("Added the turn summary.\n\nVerified with bun test.");
  expect(short).toStartWith(
    "Added the turn summary.\n\nVerified with bun test.\n\nOpened https://github.com/o/r/pull/7.",
  );
  expect(short).toEndWith("\n\nOpen findings: none.");

  const long = await response("x".repeat(PULL_REQUEST_SUMMARY_LIMIT * 2));
  const [summary] = long.split("\n\nOpened ");
  expect(summary).toHaveLength(PULL_REQUEST_SUMMARY_LIMIT);
  expect(summary).toEndWith("…");
  expect(long).toEndWith("Open findings: none.");
  expect(await response("  ")).toStartWith("Opened https://github.com/o/r/pull/7.");
});
