import { createServer, type Server, type Socket } from "node:net";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServerStdio } from "@agentclientprotocol/sdk";
import type { AgentRole } from "./adapters";
import {
  snapshotArtifactFile,
  type ArtifactLimits,
  type PublishArtifactHook,
  type PublishArtifactRequest,
} from "./artifacts";

export type AskTeamOption = string | { label?: string; value: string };

export const ASK_TEAM_TOOL_NAME = "ask_team";
export const UPDATE_PLAN_TOOL_NAME = "update_plan";

export type PlanStepStatus = "pending" | "inProgress" | "completed" | "canceled";

export interface PlanStep {
  content: string;
  status: PlanStepStatus;
}

export interface UpdatePlanHook {
  update(steps: readonly PlanStep[]): Promise<void>;
}

/** Question the agent sends. QM-07 turns this into a Linear elicitation. */
export interface AskTeamRequest {
  question: string;
  options?: readonly AskTeamOption[];
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
  if (!process.execPath.endsWith("/bun")) {
    return {
      command: "/opt/paws-runner/bin/bun",
      args: ["--no-env-file", "/opt/paws-runner/current/src/acp/ask-team-mcp.ts"],
    };
  }
  return {
    command: process.execPath,
    args: [fileURLToPath(new URL("./ask-team-mcp.ts", import.meta.url))],
  };
}

/**
 * Local socket the MCP stdio process calls back into.
 * The run timeout is paused around `hook.ask` so a human answer is not cut off.
 */
interface HostToolBridgeOptions {
  socketPath: string;
  hook?: AskTeamHook;
  updatePlan?: UpdatePlanHook;
  publishArtifact?: PublishArtifactHook;
  artifactLimits?: ArtifactLimits;
  context: { itemId: string; runId: string; role: AgentRole; worktreePath?: string };
  signal: AbortSignal;
  onAsk?: (question: string) => void | Promise<void>;
  onAnswer?: (question: string, answer: string) => void | Promise<void>;
  onHookStart?: () => void;
  onHookEnd?: () => void;
}

export async function startAskTeamBridge(options: HostToolBridgeOptions): Promise<AskTeamBridge> {
  options.signal.throwIfAborted();
  await mkdir(dirname(options.socketPath), { recursive: true, mode: 0o700 });
  await unlink(options.socketPath).catch(() => undefined);
  const lifetime = new AbortController();
  const sockets = new Set<Socket>();
  const onAbort = () => {
    lifetime.abort();
    for (const socket of sockets) socket.destroy();
  };
  options.signal.addEventListener("abort", onAbort, { once: true });
  if (options.signal.aborted) onAbort();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    void handleConnection(socket, { ...options, signal: lifetime.signal });
  });
  try {
    await listen(server, options.socketPath);
    await chmod(options.socketPath, 0o600);
    lifetime.signal.throwIfAborted();
  } catch (error) {
    options.signal.removeEventListener("abort", onAbort);
    onAbort();
    server.close();
    await unlink(options.socketPath).catch(() => undefined);
    throw error;
  }

  const entry = askTeamMcpEntry();
  return {
    mcpServer: {
      name: "paws",
      command: entry.command,
      args: entry.args,
      env: [
        { name: "PAWS_ASK_TEAM_SOCKET", value: options.socketPath },
        {
          name: "PAWS_HOST_TOOLS",
          value: [
            options.hook ? "ask_team" : "",
            options.updatePlan ? "update_plan" : "",
            options.publishArtifact ? "publish_artifact" : "",
          ]
            .filter(Boolean)
            .join(","),
        },
      ],
    },
    async close() {
      options.signal.removeEventListener("abort", onAbort);
      onAbort();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(options.socketPath).catch(() => undefined);
    },
  };
}

export const startHostToolBridge = startAskTeamBridge;

async function handleConnection(socket: Socket, options: HostToolBridgeOptions): Promise<void> {
  socket.setEncoding("utf8");
  let buffer = "";
  const readLine = () =>
    new Promise<string>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      socket.on("error", onError);
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 16_384) {
          reject(new Error("host tool request too large"));
          socket.destroy();
          return;
        }
        const newline = buffer.indexOf("\n");
        if (newline >= 0) {
          const text = buffer.slice(0, newline);
          socket.off("error", onError);
          resolve(text);
        }
      });
      socket.on("close", () => {
        socket.off("error", onError);
        reject(new Error("host tool socket closed"));
      });
    });

  let id = 0;
  try {
    const line = await readLine();
    const parsed = JSON.parse(line) as {
      id?: number;
      tool?: string;
      arguments?: Record<string, unknown>;
      question?: string;
      options?: readonly AskTeamOption[];
      context?: string;
    };
    id = parsed.id ?? 0;
    options.signal.throwIfAborted();
    if (parsed.tool === "update_plan") {
      if (!options.updatePlan) throw new Error("update_plan is unavailable");
      const steps = parsePlan(parsed.arguments ?? {});
      await options.updatePlan.update(steps);
      socket.end(`${JSON.stringify({ id, answer: "Plan updated." })}\n`);
      return;
    }
    if (parsed.tool === "publish_artifact") {
      if (!options.publishArtifact || !options.context.worktreePath) {
        throw new Error("publish_artifact is unavailable");
      }
      const request = (parsed.arguments ?? {}) as unknown as PublishArtifactRequest;
      const context = {
        ...options.context,
        request,
        worktreePath: options.context.worktreePath,
        signal: options.signal,
      };
      const attempt = options.publishArtifact.begin?.(request, context);
      if (request.attachToIssue !== undefined && typeof request.attachToIssue !== "boolean") {
        throw new Error("attachToIssue must be a boolean");
      }
      const artifact = await snapshotArtifactFile(
        options.context.worktreePath,
        request,
        options.artifactLimits,
        options.signal,
      );
      options.signal.throwIfAborted();
      let published;
      try {
        published = await abortable(
          options.publishArtifact.publish(artifact, context),
          options.signal,
        );
      } catch {
        throw new Error("artifact upload failed");
      }
      options.signal.throwIfAborted();
      let url: URL;
      try {
        url = new URL(published.url);
      } catch {
        throw new Error("artifact upload returned an invalid asset URL");
      }
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
        throw new Error("artifact upload returned an invalid asset URL");
      }
      const name = published.displayName ?? artifact.displayName;
      if (
        typeof name !== "string" ||
        !name.trim() ||
        name.length > 255 ||
        [...name].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        )
      ) {
        throw new Error("artifact upload returned an invalid display name");
      }
      options.signal.throwIfAborted();
      attempt?.complete();
      const label = name.replace(/[\\[\]]/g, "\\$&");
      socket.end(
        `${JSON.stringify({ id, answer: `${artifact.mimeType.startsWith("image/") ? "!" : ""}[${label}](<${url.href}>)` })}\n`,
      );
      return;
    }
    if (parsed.tool && parsed.tool !== "ask_team") throw new Error("unknown host tool");
    if (!options.hook) throw new Error("ask_team is unavailable");
    const request = parseAsk(parsed.arguments ?? parsed);
    await options.onAsk?.(request.question);
    options.signal.throwIfAborted();
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
    if (!socket.destroyed) socket.end(`${JSON.stringify({ id, error: message })}\n`);
  }
}

function oneLine(content: string): boolean {
  return [...content].every((character) => {
    const code = character.charCodeAt(0);
    return code >= 32 && code !== 127;
  });
}

const PLAN_STATUS: Record<string, PlanStepStatus> = {
  pending: "pending",
  inProgress: "inProgress",
  in_progress: "inProgress",
  completed: "completed",
  canceled: "canceled",
  cancelled: "canceled",
};

function parsePlan(value: { steps?: unknown }): PlanStep[] {
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 16)
    throw new Error("update_plan requires 1 to 16 steps");
  return value.steps.map((step) => {
    if (typeof step !== "object" || step === null || Array.isArray(step))
      throw new Error("update_plan steps require content and status");
    const record = step as Record<string, unknown>;
    if (typeof record.content !== "string" || typeof record.status !== "string")
      throw new Error("update_plan steps require content and status");
    const content = record.content.trim();
    const status = PLAN_STATUS[record.status];
    if (content.length < 1 || content.length > 200 || !oneLine(content) || status === undefined)
      throw new Error(
        "update_plan steps require one line of content and a pending, inProgress, completed, or canceled status",
      );
    return { content, status };
  });
}

function parseAsk(value: {
  question?: string;
  options?: readonly AskTeamOption[];
  context?: string;
}): AskTeamRequest {
  if (typeof value.question !== "string" || !value.question.trim()) {
    throw new Error("ask_team requires a question");
  }
  if (
    value.options != null &&
    (!Array.isArray(value.options) || value.options.some((item) => !isAskTeamOption(item)))
  ) {
    throw new Error("ask_team options must be strings or label/value choices");
  }
  return {
    question: value.question,
    ...(value.options ? { options: value.options } : {}),
    ...(value.context ? { context: value.context } : {}),
  };
}

function isAskTeamOption(value: unknown): value is AskTeamOption {
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const option = value as Record<string, unknown>;
  return (
    typeof option.value === "string" &&
    option.value.trim().length > 0 &&
    (option.label === undefined ||
      (typeof option.label === "string" && option.label.trim().length > 0))
  );
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
