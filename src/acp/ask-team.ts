import { createServer, type Server, type Socket } from "node:net";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServerStdio } from "@agentclientprotocol/sdk";
import type { AgentRole } from "./adapters";
import {
  artifactMimeType,
  ArtifactRejectedError,
  DEFAULT_MAX_ARTIFACT_BYTES,
  evidenceByteLimit,
  snapshotArtifactFile,
  type ArtifactEvidence,
  type ArtifactLimits,
  type PublishArtifactHook,
  type PublishArtifactRequest,
} from "./artifacts";
export { decodePolicyFiles, encodePolicyFiles } from "../closeout-spec";
export type { PolicyFilesLoad } from "../closeout-spec";
import {
  createCloseoutSession,
  workspacePolicyFiles,
  type CloseoutSession,
  type CloseoutSessionEvent,
  type PolicyFilesLoad,
} from "../closeout-spec";
import { CLOSEOUT_FINISH_UNAVAILABLE, closeoutFinishLine } from "./closeout-hook";
import { git } from "./git";
import { decidePermission, type GuardContext } from "./permissions";

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

export const OPEN_PULL_REQUEST_TOOL_NAME = "open_pull_request";

const OPEN_PULL_REQUEST_FIRST = JSON.stringify({
  decision: "block",
  reason:
    "Cannot finish yet. Commit your work, then call open_pull_request with a title and a description. If this task needs no code change, say why and finish.",
});

export interface PullRequestDescription {
  title: string;
  body: string;
}

export interface PullRequestHook {
  update(description: PullRequestDescription): Promise<void>;
}

/** Receives the agent's `get_closeout` reports and `run_closeout` attempts as they happen. */
export interface CloseoutProgressHook {
  record(event: CloseoutSessionEvent): void | Promise<void>;
}

export const POST_UPDATE_TOOL_NAME = "post_update";
export const POST_UPDATE_INTERVAL_MS = 60_000;

export type PostUpdateResult = { posted: true } | { posted: false; waitSeconds: number };

export interface PostUpdateHook {
  /** Posts the text as a Linear thought, or reports how long until the next update is allowed. */
  post(text: string): Promise<PostUpdateResult>;
}

/** At most one update per key per interval. */
export function createUpdateLimiter(
  now: () => number = Date.now,
  intervalMs: number = POST_UPDATE_INTERVAL_MS,
): { take(key: string): PostUpdateResult } {
  const last = new Map<string, number>();
  return {
    take(key) {
      const at = now();
      const previous = last.get(key);
      if (previous !== undefined && at - previous < intervalMs)
        return { posted: false, waitSeconds: Math.ceil((previous + intervalMs - at) / 1000) };
      last.set(key, at);
      return { posted: true };
    },
  };
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
  closeoutReport(): Promise<string | undefined>;
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
  pullRequest?: PullRequestHook;
  postUpdate?: PostUpdateHook;
  publishArtifact?: PublishArtifactHook;
  closeoutProgress?: CloseoutProgressHook;
  artifactLimits?: ArtifactLimits;
  context: { itemId: string; runId: string; role: AgentRole; worktreePath?: string };
  closeout?: CloseoutSession;
  closeoutPolicy?: () => Promise<PolicyFilesLoad>;
  commandGuard?: GuardContext;
  allowCloseoutRun?: boolean;
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
  const finish = { pullRequestOpened: false, nudged: false };
  const sockets = new Set<Socket>();
  const onAbort = () => {
    lifetime.abort();
    for (const socket of sockets) socket.destroy();
  };
  options.signal.addEventListener("abort", onAbort, { once: true });
  if (options.signal.aborted) onAbort();
  const entry = askTeamMcpEntry();
  const worktreePath = options.context.worktreePath;
  const closeout = worktreePath
    ? createCloseoutSession(worktreePath, {
        policy: options.closeoutPolicy ?? (async () => workspacePolicyFiles(worktreePath)),
        signal: options.signal,
        allowCommand(argv) {
          authorizeCloseout(argv, worktreePath, options.commandGuard);
        },
        ...(options.closeoutProgress
          ? { onProgress: progressListener(options.closeoutProgress) }
          : {}),
      })
    : undefined;
  const allowCloseoutRun = options.allowCloseoutRun !== false;
  const bridge = { ...options, ...(closeout ? { closeout } : {}) };
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    void handleConnection(socket, { ...bridge, signal: lifetime.signal }, finish);
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
            options.pullRequest ? "open_pull_request" : "",
            options.postUpdate ? "post_update" : "",
            closeout ? "get_closeout" : "",
            closeout && allowCloseoutRun ? "run_closeout" : "",
          ]
            .filter(Boolean)
            .join(","),
        },
      ],
    },
    async closeoutReport() {
      if (!closeout) return undefined;
      return closeout.report();
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

async function handleConnection(
  socket: Socket,
  options: HostToolBridgeOptions,
  finish: { pullRequestOpened: boolean; nudged: boolean },
): Promise<void> {
  socket.setEncoding("utf8");
  let buffer = "";
  const readLine = () =>
    new Promise<string>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      socket.on("error", onError);
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 65_536) {
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
    if (parsed.tool === "get_closeout" || parsed.tool === "run_closeout") {
      if (!options.closeout) throw new Error(`${parsed.tool} is unavailable`);
      if (parsed.tool === "run_closeout" && options.allowCloseoutRun === false) {
        throw new Error("run_closeout is unavailable");
      }
      options.onHookStart?.();
      let answer: string;
      try {
        answer =
          parsed.tool === "get_closeout"
            ? await options.closeout.report()
            : await options.closeout.run(
                closeoutId(parsed.arguments ?? {}),
                closeoutModel(parsed.arguments),
              );
      } finally {
        options.onHookEnd?.();
      }
      socket.end(`${JSON.stringify({ id, answer })}\n`);
      return;
    }
    if (parsed.tool === "closeout_finish") {
      options.onHookStart?.();
      try {
        let answer =
          options.closeout && options.allowCloseoutRun !== false
            ? closeoutFinishLine(await options.closeout.report())
            : CLOSEOUT_FINISH_UNAVAILABLE;
        if (answer === "{}" && options.pullRequest && !finish.pullRequestOpened && !finish.nudged) {
          finish.nudged = true;
          answer = OPEN_PULL_REQUEST_FIRST;
        }
        if (!socket.destroyed) socket.end(`${JSON.stringify({ id, answer })}\n`);
      } catch {
        if (!socket.destroyed) {
          socket.end(`${JSON.stringify({ id, answer: CLOSEOUT_FINISH_UNAVAILABLE })}\n`);
        }
      } finally {
        options.onHookEnd?.();
      }
      return;
    }
    if (parsed.tool === "update_plan") {
      if (!options.updatePlan) throw new Error("update_plan is unavailable");
      const steps = parsePlan(parsed.arguments ?? {});
      await options.updatePlan.update(steps);
      socket.end(`${JSON.stringify({ id, answer: "Plan updated." })}\n`);
      return;
    }
    if (parsed.tool === "open_pull_request") {
      if (!options.pullRequest) throw new Error("open_pull_request is unavailable");
      await options.pullRequest.update(parsePullRequest(parsed.arguments ?? {}));
      finish.pullRequestOpened = true;
      socket.end(
        `${JSON.stringify({ id, answer: "Saved. Paws opens or updates the pull request with this title and description after Closeout accepts the work." })}\n`,
      );
      return;
    }
    if (parsed.tool === "post_update") {
      if (!options.postUpdate) throw new Error("post_update is unavailable");
      const result = await options.postUpdate.post(parsePostUpdate(parsed.arguments ?? {}));
      socket.end(
        `${JSON.stringify({ id, answer: result.posted ? "Posted." : `Too soon. The next update is allowed in ${result.waitSeconds} seconds.` })}\n`,
      );
      return;
    }
    if (parsed.tool === "publish_artifact") {
      if (!options.publishArtifact || !options.context.worktreePath) {
        throw new Error("publish_artifact is unavailable");
      }
      const request = (parsed.arguments ?? {}) as unknown as PublishArtifactRequest;
      const evidenceLimit =
        request.checkId === undefined ? null : evidenceByteLimit(artifactMimeType(request));
      const evidence =
        evidenceLimit === null
          ? undefined
          : await artifactEvidence(
              options.closeout,
              options.context.worktreePath,
              request.checkId,
              options.signal,
            );
      const context = {
        ...options.context,
        request,
        worktreePath: options.context.worktreePath,
        signal: options.signal,
        ...(evidence ? { evidence } : {}),
      };
      const attempt = options.publishArtifact.begin?.(request, context);
      if (request.attachToIssue !== undefined && typeof request.attachToIssue !== "boolean") {
        throw new Error("attachToIssue must be a boolean");
      }
      const artifact = await snapshotArtifactFile(
        options.context.worktreePath,
        request,
        evidenceLimit === null ? options.artifactLimits : { maxBytes: evidenceLimit },
        options.signal,
      );
      if (
        evidence &&
        evidenceByteLimit(artifact.mimeType) === null &&
        artifact.sizeBytes > (options.artifactLimits?.maxBytes ?? DEFAULT_MAX_ARTIFACT_BYTES)
      )
        throw new Error(
          `artifact exceeds ${options.artifactLimits?.maxBytes ?? DEFAULT_MAX_ARTIFACT_BYTES} bytes`,
        );
      options.signal.throwIfAborted();
      let published;
      try {
        published = await abortable(
          options.publishArtifact.publish(artifact, context),
          options.signal,
        );
      } catch (error) {
        if (error instanceof ArtifactRejectedError) throw error;
        throw new Error("artifact upload failed", { cause: error });
      }
      options.signal.throwIfAborted();
      let url: URL;
      try {
        url = new URL(published.url);
      } catch {
        throw new Error("artifact upload returned an invalid asset URL");
      }
      if (
        !(url.protocol === "https:" || (evidence && url.protocol === "http:")) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      ) {
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
      const image = artifact.mimeType.startsWith("image/") && !evidence;
      socket.end(
        `${JSON.stringify({ id, answer: `${image ? "!" : ""}[${label}](<${url.href}>)` })}\n`,
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

/** Ties a video or screenshot to the current attempt of a required Closeout check. */
async function artifactEvidence(
  closeout: CloseoutSession | undefined,
  worktreePath: string,
  checkId: unknown,
  signal: AbortSignal,
): Promise<ArtifactEvidence> {
  if (typeof checkId !== "string" || !/^[A-Za-z0-9][\w.-]{0,127}$/.test(checkId))
    throw new Error("checkId must be a Closeout check id from get_closeout");
  if (!closeout) throw new Error("checkId needs Closeout, and get_closeout is unavailable here");
  let report: { required?: { id?: unknown; failed_attempts?: unknown }[] };
  try {
    report = JSON.parse(await closeout.report());
  } catch {
    throw new Error("Closeout status is unavailable");
  }
  const check = Array.isArray(report.required)
    ? report.required.find((item) => item?.id === checkId)
    : undefined;
  if (!check)
    throw new Error(
      `Closeout check ${checkId} is not required for the current changes. Call get_closeout.`,
    );
  const failures = Number.isSafeInteger(check.failed_attempts)
    ? (check.failed_attempts as number)
    : 0;
  let headCommit: string;
  try {
    headCommit = (
      await git(["rev-parse", "--verify", "HEAD^{commit}"], { cwd: worktreePath, signal })
    ).trim();
  } catch {
    throw new Error("The workspace has no commit to attach evidence to");
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(headCommit))
    throw new Error("The workspace has no commit to attach evidence to");
  return { checkId, attempt: failures + 1, headCommit };
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

export function parsePullRequest(value: {
  title?: unknown;
  body?: unknown;
}): PullRequestDescription {
  if (typeof value.title !== "string" || typeof value.body !== "string")
    throw new Error("open_pull_request requires a title and a body");
  const title = value.title.trim();
  const body = value.body.trim();
  if (title.length < 1 || title.length > 256 || !oneLine(title))
    throw new Error("open_pull_request needs a one-line title of at most 256 characters");
  if (body.length < 1 || body.length > 12_000)
    throw new Error("open_pull_request needs a body of 1 to 12000 characters");
  return { title, body };
}

export function parsePostUpdate(value: { text?: unknown }): string {
  if (typeof value.text !== "string") throw new Error("post_update requires text");
  const text = value.text.trim();
  if (text.length < 1 || text.length > 500)
    throw new Error("post_update needs text of 1 to 500 characters");
  return text;
}

function progressListener(hook: CloseoutProgressHook): (event: CloseoutSessionEvent) => void {
  return (event) => {
    try {
      void Promise.resolve(hook.record(event)).catch(() => undefined);
    } catch {
      // Recording progress never interrupts the agent's Closeout.
    }
  };
}

function authorizeCloseout(
  argv: readonly string[],
  worktree: string,
  guard: GuardContext | undefined,
): void {
  if (!guard) throw new Error("closeout command is not authorized");
  const decision = decidePermission(
    {
      kind: "execute",
      command: argv[0] ?? "",
      args: [...argv.slice(1)],
      cwd: worktree,
    },
    guard,
  );
  if (!decision.allow) throw new Error(decision.reason);
}

function closeoutId(value: Record<string, unknown>): string {
  if (typeof value.id !== "string" || value.id.trim().length === 0) {
    throw new Error("run_closeout requires an id");
  }
  return value.id.trim();
}

function closeoutModel(value: Record<string, unknown> | undefined): string | undefined {
  if (value?.model === undefined) return undefined;
  if (typeof value.model !== "string" || value.model.trim().length === 0) {
    throw new Error("run_closeout model must be a model id");
  }
  return value.model.trim();
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
