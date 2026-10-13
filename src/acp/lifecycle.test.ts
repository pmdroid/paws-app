import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { recoverAcpConversation, reconstructAcpPrompt } from "./lifecycle";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function transcript(
  updates: unknown[],
  prefix = "",
): Promise<{ path: string; offset: number }> {
  const root = await mkdtemp(join(tmpdir(), "paws-acp-recovery-"));
  roots.push(root);
  const path = join(root, "acp.jsonl");
  await writeFile(
    path,
    prefix +
      updates
        .map((update) => JSON.stringify({ event: { type: "session_update", update } }))
        .join("\n") +
      "\n",
  );
  return { path, offset: Buffer.byteLength(prefix) };
}

for (const channel of ["terminal_output", "terminal_output_delta"]) {
  test(`recovery restores interleaved ${channel} chunks once per completed tool`, async () => {
    const { path, offset } = await transcript(
      [
        { sessionUpdate: "tool_call", toolCallId: "check", title: "Check", status: "in_progress" },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "check",
          _meta: {
            [channel]: { terminal_id: "a", data: "First " },
            terminal_input: { data: "private input" },
            analysis: "private reasoning",
          },
        },
        {
          sessionUpdate: "tool_call",
          toolCallId: "failure",
          title: "Failing check",
          status: "in_progress",
          rawOutput: { code: 1 },
        },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "failure",
          _meta: { [channel]: { terminal_id: "b", data: "Assertion failed" } },
        },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "check",
          _meta: { [channel]: { terminal_id: "a", data: "check passed" } },
        },
        { sessionUpdate: "tool_call_update", toolCallId: "check", status: "completed" },
        { sessionUpdate: "tool_call_update", toolCallId: "failure", status: "failed" },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "check",
          status: "completed",
          content: [],
        },
      ],
      JSON.stringify({
        event: {
          type: "session_update",
          update: { sessionUpdate: "tool_call", toolCallId: "old", status: "completed" },
        },
      }) + "\n",
    );
    const recovered = await recoverAcpConversation(path, offset);
    expect(recovered.map((entry) => JSON.parse(entry.body))).toEqual([
      {
        toolCallId: "check",
        title: "Check",
        status: "completed",
        content: [],
        terminalOutput: "First check passed",
      },
      {
        toolCallId: "failure",
        title: "Failing check",
        status: "failed",
        rawOutput: { code: 1 },
        terminalOutput: "Assertion failed",
      },
    ]);
    const prompt = reconstructAcpPrompt("Continue after restart.", recovered);
    expect(prompt).toContain("First check passed");
    expect(prompt).toContain("Assertion failed");
    expect(prompt).not.toContain("private input");
    expect(prompt).not.toContain("private reasoning");
  });
}

test("recovery bounds terminal output and ignores invalid metadata and unfinished tools", async () => {
  const { path } = await transcript([
    {
      sessionUpdate: "tool_call",
      toolCallId: "large",
      title: "Large output",
      status: "in_progress",
    },
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "large",
      _meta: { terminal_output_delta: { data: "x".repeat(70 * 1024) } },
    },
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "large",
      _meta: { terminal_output: { data: "Final failure" } },
    },
    { sessionUpdate: "tool_call_update", toolCallId: "large", status: "completed" },
    {
      sessionUpdate: "tool_call",
      toolCallId: "unfinished",
      status: "in_progress",
      _meta: { terminal_output: { data: "not completed" } },
    },
    {
      sessionUpdate: "tool_call",
      toolCallId: "plain",
      status: "completed",
      rawOutput: "ordinary result",
      _meta: { terminal_output: { data: 12 }, terminal_output_delta: null },
    },
  ]);
  const recovered = await recoverAcpConversation(path);
  expect(recovered.map((entry) => JSON.parse(entry.body))).toEqual([
    {
      toolCallId: "large",
      title: "Large output",
      status: "completed",
      terminalOutput: "x".repeat(64 * 1024 - "Final failure".length) + "Final failure",
    },
    { toolCallId: "plain", status: "completed", rawOutput: "ordinary result" },
  ]);
});

test("recovery chooses one channel per update without removing repeated real chunks", async () => {
  const { path } = await transcript([
    {
      sessionUpdate: "tool_call",
      toolCallId: "mirrored",
      status: "in_progress",
      _meta: {
        terminal_output: { data: "same\n" },
        terminal_output_delta: { data: "same\n" },
      },
    },
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "mirrored",
      _meta: { terminal_output_delta: { data: "same\n" } },
    },
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "mirrored",
      status: "completed",
      _meta: { terminal_output_delta: { data: false }, terminal_output: { data: "done" } },
    },
  ]);
  const recovered = await recoverAcpConversation(path);
  expect(recovered).toHaveLength(1);
  expect(JSON.parse(recovered[0]!.body).terminalOutput).toBe("same\nsame\ndone");
});

test("recovery preserves complete ACP history among worker question and artifact records", async () => {
  const { path } = await transcript([
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Full answer" } },
    { sessionUpdate: "tool_call", toolCallId: "check", status: "completed", rawOutput: "done" },
  ]);
  const { appendFile } = await import("node:fs/promises");
  await appendFile(path, JSON.stringify({ type: "question", text: "Continue?" }) + "\n");
  await appendFile(path, JSON.stringify({ type: "artifact", path: "report.txt" }) + "\n");
  expect(await recoverAcpConversation(path)).toEqual([
    { kind: "response", body: "Full answer" },
    {
      kind: "tool_result",
      body: JSON.stringify({ toolCallId: "check", status: "completed", rawOutput: "done" }),
    },
  ]);
});
