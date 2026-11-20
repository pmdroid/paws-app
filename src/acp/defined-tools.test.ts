import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAskTeamBridge } from "./ask-team";
import { decideReadOnlyPermission } from "./permissions";

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

test("add_repository reaches its hook and a read-only run may call it but not write", async () => {
  const root = await mkdtemp(join(tmpdir(), "paws-add-repository-"));
  const asked: unknown[] = [];
  const bridge = await startAskTeamBridge({
    socketPath: join(root, "tools.sock"),
    context: { itemId: "item", runId: "run", role: "implementer" },
    signal: new AbortController().signal,
    async addRepository(repository) {
      asked.push(repository);
      return repository === "acme/app"
        ? { text: `Added at repositories/acme/app (commit ${"c".repeat(40)}).` }
        : { text: "Paws could not add acme/other.", isError: true };
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
      {
        method: "tools/call",
        params: { name: "add_repository", arguments: { repository: "acme/app" } },
      },
      {
        method: "tools/call",
        params: { name: "add_repository", arguments: { repository: "acme/other" } },
      },
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
    expect((results.get(1)!.tools as { name: string }[]).map((tool) => tool.name)).toEqual([
      "add_repository",
    ]);
    expect(results.get(2)).toEqual({
      content: [
        { type: "text", text: `Added at repositories/acme/app (commit ${"c".repeat(40)}).` },
      ],
      isError: false,
    });
    expect(results.get(3)).toEqual({
      content: [{ type: "text", text: "Paws could not add acme/other." }],
      isError: true,
    });
    expect(asked).toEqual(["acme/app", "acme/other"]);
  } finally {
    child.kill();
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
  const ctx = {
    worktree: "/work/run",
    home: "/home/agent",
    pawsRoot: "/work/.paws",
    definedTools: ["add_repository"],
  };
  const added = "/work/run/repositories/acme/app/README.md";
  expect(
    decideReadOnlyPermission({ name: "mcp__paws__add_repository", kind: "other" }, ctx).allow,
  ).toBe(true);
  expect(decideReadOnlyPermission({ kind: "read", locations: [{ path: added }] }, ctx).allow).toBe(
    true,
  );
  expect(decideReadOnlyPermission({ kind: "edit", locations: [{ path: added }] }, ctx).allow).toBe(
    false,
  );
  expect(
    decideReadOnlyPermission(
      { kind: "execute", rawInput: { command: "curl https://example.com" } },
      ctx,
    ).allow,
  ).toBe(false);
  expect(
    decideReadOnlyPermission(
      { name: "mcp__paws__add_repository", kind: "other" },
      { ...ctx, definedTools: [] },
    ).allow,
  ).toBe(false);
});
