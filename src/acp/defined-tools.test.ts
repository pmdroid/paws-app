import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAskTeamBridge } from "./ask-team";

test("the MCP server lists Paws-defined tools after the built-in ones and forwards calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "paws-defined-tools-"));
  const calls: [string, Record<string, unknown>][] = [];
  const inputSchema = {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  };
  const bridge = await startAskTeamBridge({
    socketPath: join(root, "tools.sock"),
    context: { itemId: "item", runId: "run", role: "implementer" },
    signal: new AbortController().signal,
    hook: { ask: async () => ({ answer: "yes" }) },
    hostTools: {
      definitions: [{ name: "linear_issue", description: "Read one Linear issue.", inputSchema }],
      async call(name, args) {
        calls.push([name, args]);
        return args.id === "PAS-0"
          ? { text: "No such issue.", isError: true }
          : { text: `${String(args.id)}: Fix rounding` };
      },
    },
  });
  const server = bridge.mcpServer as {
    command: string;
    args: string[];
    env: { name: string; value: string }[];
  };
  const child = Bun.spawn([server.command, ...server.args], {
    env: {
      ...process.env,
      ...Object.fromEntries(server.env.map((entry) => [entry.name, entry.value])),
    },
    stdin: "pipe",
    stdout: "pipe",
  });
  try {
    const requests = [
      { method: "tools/list", params: {} },
      { method: "tools/call", params: { name: "linear_issue", arguments: { id: "PAS-1" } } },
      { method: "tools/call", params: { name: "linear_issue", arguments: { id: "PAS-0" } } },
      { method: "tools/call", params: { name: "linear_comment", arguments: {} } },
    ];
    for (const [index, request] of requests.entries())
      void child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: index + 1, ...request })}\n`);
    await child.stdin.flush();
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (text.split("\n").filter(Boolean).length < requests.length) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    const results = new Map(
      text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { id: number; result: Record<string, unknown> })
        .map((message) => [message.id, message.result]),
    );
    const tools = results.get(1)!.tools as {
      name: string;
      description: string;
      inputSchema: unknown;
    }[];
    expect(tools.map((tool) => tool.name)).toEqual(["ask_team", "linear_issue"]);
    expect(tools[1]).toEqual({
      name: "linear_issue",
      description: "Read one Linear issue.",
      inputSchema,
    });
    expect(results.get(2)).toEqual({
      content: [{ type: "text", text: "PAS-1: Fix rounding" }],
      isError: false,
    });
    expect(results.get(3)).toEqual({
      content: [{ type: "text", text: "No such issue." }],
      isError: true,
    });
    expect(results.get(4)).toMatchObject({ isError: true });
    expect(calls).toEqual([
      ["linear_issue", { id: "PAS-1" }],
      ["linear_issue", { id: "PAS-0" }],
    ]);
  } finally {
    child.kill();
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});
