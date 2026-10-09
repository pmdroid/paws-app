import { createServer, type Server, type Socket } from "node:net";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServerStdio } from "@agentclientprotocol/sdk";
import type { AgentRole } from "./adapters";

export const ASK_TEAM_TOOL_NAME = "ask_team";

/** Question the agent sends. QM-07 turns this into a Linear elicitation. */
export interface AskTeamRequest {
  question: string;
  options?: string[];
  context?: string;
}

export interface AskTeamResponse {
  answer: string;
}

export interface AskTeamContext {
  itemId: string;
  runId: string;
  role: AgentRole;
  signal: AbortSignal;
}

/**
 * Injected by the host. QM-05 only defines the hook and exposes it to the agent
 * as an MCP tool. The Linear park/resume implementation belongs to QM-07.
 */
export interface AskTeamHook {
  ask(request: AskTeamRequest, context: AskTeamContext): Promise<AskTeamResponse>;
}

export interface AskTeamBridge {
  mcpServer: McpServerStdio;
  close(): Promise<void>;
}

export function askTeamMcpEntry(): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [fileURLToPath(new URL("./ask-team-mcp.ts", import.meta.url))],
  };
}

/**
 * Local socket the MCP stdio process calls back into.
 * The run timeout is paused around `hook.ask` so a human answer is not cut off.
 */
export async function startAskTeamBridge(options: {
  socketPath: string;
  hook: AskTeamHook;
  context: { itemId: string; runId: string; role: AgentRole };
  signal: AbortSignal;
  onAsk?: (question: string) => void | Promise<void>;
  onAnswer?: (question: string, answer: string) => void | Promise<void>;
  onHookStart?: () => void;
  onHookEnd?: () => void;
}): Promise<AskTeamBridge> {
  await mkdir(dirname(options.socketPath), { recursive: true, mode: 0o700 });
  await unlink(options.socketPath).catch(() => undefined);

  const server = createServer((socket) => {
    void handleConnection(socket, options);
  });
  await listen(server, options.socketPath);
  await chmod(options.socketPath, 0o600);

  const entry = askTeamMcpEntry();
  return {
    mcpServer: {
      name: "paws",
      command: entry.command,
      args: entry.args,
      env: [{ name: "PAWS_ASK_TEAM_SOCKET", value: options.socketPath }],
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(options.socketPath).catch(() => undefined);
    },
  };
}

async function handleConnection(
  socket: Socket,
  options: {
    hook: AskTeamHook;
    context: { itemId: string; runId: string; role: AgentRole };
    signal: AbortSignal;
    onAsk?: (question: string) => void | Promise<void>;
    onAnswer?: (question: string, answer: string) => void | Promise<void>;
    onHookStart?: () => void;
    onHookEnd?: () => void;
  },
): Promise<void> {
  socket.setEncoding("utf8");
  let buffer = "";
  const line = await new Promise<string>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    socket.on("error", onError);
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        const text = buffer.slice(0, newline);
        socket.off("error", onError);
        resolve(text);
      }
    });
    socket.on("end", () => {
      socket.off("error", onError);
      reject(new Error("ask_team socket closed"));
    });
  });

  let id = 0;
  try {
    const parsed = JSON.parse(line) as {
      id?: number;
      question?: string;
      options?: string[];
      context?: string;
    };
    id = parsed.id ?? 0;
    const request = parseAsk(parsed);
    await options.onAsk?.(request.question);
    options.onHookStart?.();
    let response: AskTeamResponse;
    try {
      response = await abortable(
        options.hook.ask(request, { ...options.context, signal: options.signal }),
        options.signal,
      );
    } finally {
      options.onHookEnd?.();
    }
    await options.onAnswer?.(request.question, response.answer);
    socket.end(`${JSON.stringify({ id, answer: response.answer })}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    socket.end(`${JSON.stringify({ id, error: message })}\n`);
  }
}

function parseAsk(value: {
  question?: string;
  options?: string[];
  context?: string;
}): AskTeamRequest {
  if (typeof value.question !== "string" || !value.question.trim()) {
    throw new Error("ask_team requires a question");
  }
  if (
    value.options != null &&
    (!Array.isArray(value.options) || value.options.some((item) => typeof item !== "string"))
  ) {
    throw new Error("ask_team options must be strings");
  }
  return {
    question: value.question,
    ...(value.options ? { options: value.options } : {}),
    ...(value.context ? { context: value.context } : {}),
  };
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("cancelled"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error("cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
