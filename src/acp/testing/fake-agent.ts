import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import type { FakeResult, FakeScript, FakeStep } from "./script";

/**
 * Stdio ACP agent used by tests. It speaks JSON-RPC newline messages.
 * `authenticate` is answered when a Grok script asks for it; Claude scripts
 * leave that method unused.
 */

const resultPath = process.argv[2];
const scriptPath = process.argv[3];
const script: FakeScript = scriptPath
  ? (JSON.parse(readFileSync(scriptPath, "utf8")) as FakeScript)
  : { steps: [] };

const state: FakeResult = {
  methods: [],
  argv: process.argv.slice(4),
  cwd: process.cwd(),
  env: {
    xaiApiKey: present("XAI_API_KEY"),
    ghToken: present("GH_TOKEN"),
    sshAuthSock: present("SSH_AUTH_SOCK"),
    aws: Object.keys(process.env).some((key) => key.startsWith("AWS_") && present(key)),
  },
  mcpServers: [],
  permissions: [],
  fs: [],
  terminals: [],
};

/** `sessions` scripts successive spawns; a counter next to the script picks one. */
const spawnSteps = (() => {
  if (!script.sessions?.length || !scriptPath) return script.steps;
  const counter = `${scriptPath}.spawns`;
  let spawned = 0;
  try {
    spawned = Number(readFileSync(counter, "utf8")) || 0;
  } catch {}
  writeFileSync(counter, String(spawned + 1));
  return script.sessions[Math.min(spawned, script.sessions.length - 1)]!;
})();

function present(key: string): boolean {
  const value = process.env[key];
  return typeof value === "string" && value.length > 0;
}

let nextId = 1;
let cancelled = false;
const pending = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();

function persist(): void {
  if (!resultPath) return;
  const pendingPath = `${resultPath}.${process.pid}.pending`;
  writeFileSync(pendingPath, JSON.stringify(state, null, 2));
  renameSync(pendingPath, resultPath);
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function request(method: string, params: unknown): Promise<unknown> {
  const id = nextId++;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
}

function record(method: string): void {
  state.methods.push(method);
  persist();
}

const sessionId = script.sessionId ?? crypto.randomUUID();
let currentModel = script.model === undefined ? "test-claude-model" : script.model;
let currentEffort = script.effort ?? "medium";
const configOptions = () => {
  const models =
    currentModel === null
      ? []
      : [
          {
            id: "model",
            type: "select",
            name: "Model",
            category: "model",
            currentValue: currentModel,
            options:
              script.modelOptions ??
              (script.models ?? [currentModel]).map((value) => ({ value, name: value })),
          },
        ];
  const efforts = (currentModel && script.modelEfforts?.[currentModel]) ?? script.efforts;
  return [
    ...models,
    ...(efforts
      ? [
          {
            id: "reasoning_effort",
            type: "select",
            name: "Effort",
            category: "thought_level",
            currentValue: currentEffort,
            options: efforts.map((value) => ({ value, name: value })),
          },
        ]
      : []),
  ];
};

async function handle(message: {
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string };
}): Promise<void> {
  if (message.id != null && message.method == null) {
    const waiter = pending.get(Number(message.id));
    if (!waiter) return;
    pending.delete(Number(message.id));
    if (message.error) waiter.reject(new Error(message.error.message ?? "request failed"));
    else waiter.resolve(message.result);
    return;
  }
  if (!message.method) return;
  record(message.method);

  if (message.method === "initialize") {
    if (script.hangInitialize) return;
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: "fake-acp", version: "0.0.0" },
        agentCapabilities: {
          mcpCapabilities: { http: false, sse: false },
          promptCapabilities: script.promptCapabilities,
          loadSession: script.loadSession === true,
        },
        authMethods: script.authMethods ?? [],
      },
    });
    return;
  }

  if (message.method === "authenticate") {
    state.authenticate = message.params ?? {};
    persist();
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }

  if (message.method === "session/new") {
    const servers = Array.isArray(message.params?.mcpServers) ? message.params.mcpServers : [];
    state.mcpServers = servers.map((server) => {
      const recordServer = server as {
        name?: string;
        command?: string;
        args?: string[];
        env?: Array<{ name: string; value: string }>;
      };
      return {
        name: recordServer.name,
        command: recordServer.command,
        args: recordServer.args,
        env: recordServer.env,
      };
    });
    const sessionMeta = message.params?.["_meta"];
    if (sessionMeta) state.sessionMeta = sessionMeta;
    if (process.env.CODEX_HOME) state.codexHome = process.env.CODEX_HOME;
    persist();
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId, configOptions: configOptions() } });
    return;
  }

  if (message.method === "session/load") {
    state.loaded = message.params ?? {};
    persist();
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: message.params?.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "REPLAYED HISTORY" },
        },
      },
    });
    send({ jsonrpc: "2.0", id: message.id, result: { configOptions: configOptions() } });
    return;
  }

  if (message.method === "session/set_config_option") {
    if (message.params?.configId === "reasoning_effort") {
      state.effortSelection = message.params;
      persist();
      if (script.effortError)
        send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32602, message: script.effortError },
        });
      else {
        currentEffort = script.confirmEffort ?? String(message.params?.value);
        send({ jsonrpc: "2.0", id: message.id, result: { configOptions: configOptions() } });
      }
      return;
    }
    state.modelSelection = message.params;
    persist();
    if (script.modelError)
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: script.modelError } });
    else {
      currentModel = script.confirmModel ?? String(message.params?.value);
      send({ jsonrpc: "2.0", id: message.id, result: { configOptions: configOptions() } });
    }
    return;
  }

  if (message.method === "session/cancel") {
    cancelled = true;
    return;
  }

  if (message.method === "session/prompt") {
    state.prompts ??= [];
    state.prompts.push(message.params?.prompt);
    persist();
    try {
      const finished = await runSteps(spawnSteps, message.id ?? null);
      if (!finished) {
        send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: text } });
    }
    return;
  }

  if (message.id != null) {
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: `unexpected method ${message.method}` },
    });
  }
}

async function runSteps(steps: FakeStep[], prompt: number | string | null): Promise<boolean> {
  for (const step of steps) {
    if (step.type === "update") {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: step.update },
      });
      if (step.delayMs) await Bun.sleep(step.delayMs);
      continue;
    }
    if (step.type === "permission") {
      let outcome: unknown;
      try {
        outcome = await request("session/request_permission", {
          sessionId,
          toolCall: {
            toolCallId: step.toolCall.toolCallId,
            title: step.toolCall.title ?? step.toolCall.toolCallId,
            name: step.toolCall.name,
            kind: step.toolCall.kind,
            status: "pending",
            locations: step.toolCall.locations,
            rawInput: step.toolCall.rawInput,
          },
          options: step.options ?? [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        });
      } catch (error) {
        // Like a real agent, a failed permission request fails only that tool call.
        outcome = { error: error instanceof Error ? error.message : String(error) };
      }
      state.permissions.push({ toolCallId: step.toolCall.toolCallId, outcome });
      persist();
      // A cancelled outcome means the client cancelled the prompt turn.
      if ((outcome as { outcome?: { outcome?: string } }).outcome?.outcome === "cancelled") {
        send({ jsonrpc: "2.0", id: prompt, result: { stopReason: "cancelled" } });
        return true;
      }
      continue;
    }
    if (step.type === "fs_read" || step.type === "fs_write") {
      const method = step.type === "fs_read" ? "fs/read_text_file" : "fs/write_text_file";
      const params =
        step.type === "fs_read"
          ? { sessionId, path: step.path }
          : { sessionId, path: step.path, content: step.content };
      try {
        const response = (await request(method, params)) as { content?: string };
        state.fs.push({
          op: step.type === "fs_read" ? "read" : "write",
          path: step.path,
          ok: true,
          ...(response.content != null ? { content: response.content } : {}),
        });
      } catch (error) {
        state.fs.push({
          op: step.type === "fs_read" ? "read" : "write",
          path: step.path,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      persist();
      continue;
    }
    if (step.type === "terminal") {
      try {
        const created = (await request("terminal/create", {
          sessionId,
          command: step.command,
          args: step.args ?? [],
          ...(step.cwd ? { cwd: step.cwd } : {}),
        })) as { terminalId: string };
        const waited = (await request("terminal/wait_for_exit", {
          sessionId,
          terminalId: created.terminalId,
        })) as { exitCode?: number | null };
        const output = (await request("terminal/output", {
          sessionId,
          terminalId: created.terminalId,
        })) as { output?: string };
        await request("terminal/release", { sessionId, terminalId: created.terminalId });
        state.terminals.push({
          command: step.command,
          ok: true,
          output: output.output,
          exitCode: waited.exitCode,
        });
      } catch (error) {
        state.terminals.push({
          command: step.command,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      persist();
      continue;
    }
    if (step.type === "get_closeout" || step.type === "run_closeout") {
      const server = state.mcpServers[0];
      try {
        if (!server?.command) throw new Error("no mcp server");
        const text = await callHostTool(
          server,
          step.type,
          step.type === "run_closeout"
            ? { id: step.id, ...(step.model ? { model: step.model } : {}) }
            : {},
        );
        state.closeouts = [...(state.closeouts ?? []), text];
      } catch (error) {
        state.closeouts = [
          ...(state.closeouts ?? []),
          error instanceof Error ? error.message : String(error),
        ];
      }
      persist();
      continue;
    }
    if (step.type === "update_plan") {
      const server = state.mcpServers[0];
      if (!server?.command) {
        state.plan = { ok: false, error: "no mcp server" };
        persist();
        continue;
      }
      try {
        const text = await callHostTool(server, "update_plan", { steps: step.steps });
        state.plan = { ok: true, text };
      } catch (error) {
        state.plan = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      persist();
      continue;
    }
    if (step.type === "open_pull_request") {
      const server = state.mcpServers[0];
      try {
        if (!server?.command) throw new Error("no mcp server");
        const text = await callHostTool(server, "open_pull_request", {
          title: step.title,
          body: step.body,
        });
        state.pullRequest = { ok: true, text };
      } catch (error) {
        state.pullRequest = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      persist();
      continue;
    }
    if (step.type === "post_update") {
      const server = state.mcpServers[0];
      state.updates ??= [];
      try {
        if (!server?.command) throw new Error("no mcp server");
        state.updates.push({
          ok: true,
          text: await callHostTool(server, "post_update", { text: step.text }),
        });
      } catch (error) {
        state.updates.push({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      persist();
      continue;
    }
    if (step.type === "ask_team") {
      const server = state.mcpServers[0];
      if (!server?.command) {
        state.askTeam = { ok: false, error: "no mcp server" };
        persist();
        continue;
      }
      try {
        const text = await callHostTool(server, "ask_team", {
          question: step.question,
          ...(step.options ? { options: step.options } : {}),
          ...(step.context ? { context: step.context } : {}),
        });
        state.askTeam = { ok: true, text };
      } catch (error) {
        state.askTeam = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      persist();
      continue;
    }
    if (step.type === "publish_artifact") {
      try {
        const server = state.mcpServers[0];
        if (!server?.command) throw new Error("no mcp server");
        const text = await callHostTool(server, "publish_artifact", {
          path: step.path,
          ...(step.displayName ? { displayName: step.displayName } : {}),
          ...(step.mimeType ? { mimeType: step.mimeType } : {}),
          ...(step.attachToIssue === undefined ? {} : { attachToIssue: step.attachToIssue }),
          ...(step.checkId === undefined ? {} : { checkId: step.checkId }),
        });
        state.artifact = { ok: true, text };
      } catch (error) {
        state.artifact = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      persist();
      continue;
    }
    if (step.type === "spawn") {
      spawn(step.command, step.args ?? [], {
        detached: step.detached === true,
        stdio: "ignore",
        env: step.env ?? process.env,
      }).unref();
      continue;
    }
    if (step.type === "hang") {
      if (script.ignoreCancel) await new Promise(() => undefined);
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          if (cancelled) {
            clearInterval(timer);
            resolve();
          }
        }, 15);
      });
      send({ jsonrpc: "2.0", id: prompt, result: { stopReason: "cancelled" } });
      return true;
    }
    if (step.type === "end") {
      send({ jsonrpc: "2.0", id: prompt, result: { stopReason: step.stopReason ?? "end_turn" } });
      for (const update of step.updatesAfterResponse ?? [])
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
      return true;
    }
  }
  return false;
}

async function callHostTool(
  server: { command?: string; args?: string[]; env?: Array<{ name: string; value: string }> },
  tool: string,
  args: Record<string, unknown>,
): Promise<string> {
  const env: Record<string, string> = {};
  if (process.env.PATH) env.PATH = process.env.PATH;
  for (const item of server.env ?? []) env[item.name] = item.value;
  const child = spawn(server.command ?? "", server.args ?? [], {
    stdio: ["pipe", "pipe", "pipe"],
    env,
  }) as ChildProcessWithoutNullStreams;
  return speakMcp(child, tool, args);
}

function speakMcp(
  child: ChildProcessWithoutNullStreams,
  tool: string,
  args: Record<string, unknown>,
): Promise<string> {
  let next = 1;
  const waiters = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line) as {
      id?: number;
      result?: unknown;
      error?: { message?: string };
    };
    if (message.id == null) return;
    const waiter = waiters.get(message.id);
    if (!waiter) return;
    waiters.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message ?? "mcp error"));
    else waiter.resolve(message.result);
  });
  const call = (method: string, params: unknown) => {
    const id = next++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => waiters.set(id, { resolve, reject }));
  };
  return (async () => {
    await call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "fake-acp", version: "0.0.0" },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    const listed = (await call("tools/list", {})) as { tools: Array<{ name: string }> };
    state.tools = listed.tools.map((entry) => entry.name);
    persist();
    const result = (await call("tools/call", {
      name: tool,
      arguments: args,
    })) as { content?: Array<{ text?: string }>; isError?: boolean };
    child.stdin.end();
    const text = result.content?.[0]?.text ?? "";
    if (result.isError) throw new Error(text);
    return text;
  })();
}

async function readInput(): Promise<void> {
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line) as {
      id?: number | string | null;
      method?: string;
      params?: Record<string, unknown>;
      result?: unknown;
      error?: { message?: string };
    };
    void handle(message);
  }
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("fake-agent.ts") || entry.endsWith("fake-agent.js")) {
  if (script.ignoreCancel) {
    process.on("SIGTERM", () => undefined);
    process.on("SIGINT", () => undefined);
  }
  readInput().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
