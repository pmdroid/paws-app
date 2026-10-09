import { appendFile, lstat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  PROTOCOL_VERSION,
  client,
  methods,
  ndJsonStream,
  type ClientContext,
  type InitializeResponse,
  type PermissionOption,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type StopReason,
} from "@agentclientprotocol/sdk";
import { commitCheckpoint } from "./checkpoint";
import { assertSafeSegment, runDir } from "./paths";
import { resolveAdapter, type AgentRole } from "./adapters";
import { startAskTeamBridge, type AskTeamBridge, type AskTeamHook } from "./ask-team";
import { AUTH_REQUIRED_MESSAGE, isAuthRequired, summarizeAuth, type AuthCheckResult } from "./auth";
import { minimalAgentEnv } from "./env";
import { TerminalRegistry, readGuarded, writeGuarded } from "./host-tools";
import { decidePermission, type GuardContext } from "./permissions";
import { captureStderr, killTree, spawnAgent, stopChild, waitForExit } from "./process";
import {
  DEFAULT_CANCEL_GRACE_MS,
  DEFAULT_RUN_TIMEOUT_MS,
  type AcpEventListener,
  type RunAgentOptions,
  type RunAgentResult,
} from "./types";
import type { ChildProcess } from "node:child_process";

const CLIENT_INFO = { name: "paws", version: "0.0.0" };

export interface CheckOwnLoginOptions {
  role: AgentRole;
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Spawn the adapter, read `initialize` / `authMethods`, and close.
 * Does not call `authenticate` and does not read credential files.
 */
export async function checkOwnLogin(options: CheckOwnLoginOptions): Promise<AuthCheckResult> {
  const adapter = options.command
    ? { command: options.command, args: options.args ?? [] }
    : resolveAdapter(options.role, options.env);
  const child = spawnAgent(adapter.command, adapter.args, minimalAgentEnv(options.env));
  const stderr = captureStderr(child);
  try {
    return await withConnection(child, async (ctx) => {
      const response = await withTimeout(
        ctx.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: CLIENT_INFO,
          clientCapabilities: clientCapabilities(),
        }),
        options.timeoutMs ?? 30_000,
        options.signal,
      );
      return summarizeAuth(response as InitializeResponse);
    });
  } catch (error) {
    const detail = stderr.text().trim();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(detail ? `${message}\n${detail}` : message, { cause: error });
  } finally {
    await stopChild(child, 500);
  }
}

/**
 * `session/new` + `session/prompt` against Claude Code (`claude-agent-acp`) or
 * Codex (`codex-acp`). Session updates are forwarded through `onEvent`.
 */
export async function runAgent(options: RunAgentOptions): Promise<RunAgentResult> {
  assertSafeSegment(options.itemId, "item id");
  assertSafeSegment(options.runId, "run id");
  if (!isAbsolute(options.worktreePath)) throw new Error("worktreePath must be absolute");
  const info = await lstat(options.worktreePath);
  if (!info.isDirectory()) throw new Error("worktreePath is not a directory");

  const home = options.home ?? homedir();
  const guard: GuardContext = {
    worktree: options.worktreePath,
    home,
    pawsRoot: options.pawsRoot,
  };
  const adapter = options.command
    ? { command: options.command, args: options.args ?? [] }
    : resolveAdapter(options.role, options.env);
  const child = spawnAgent(
    adapter.command,
    adapter.args,
    minimalAgentEnv(options.env),
    options.docker
      ? {
          docker: {
            agent: options.docker.agent,
            worktree: options.worktreePath,
            proxyUrl: options.docker.proxyUrl,
            ...(options.docker.image ? { image: options.docker.image } : {}),
            ...(options.docker.bin ? { bin: options.docker.bin } : {}),
          },
        }
      : undefined,
  );
  const stderr = captureStderr(child);
  const graceMs = options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
  const transcript = `${runDir(options.pawsRoot, options.runId)}/acp.jsonl`;
  await mkdir(runDir(options.pawsRoot, options.runId), { recursive: true, mode: 0o700 });

  const state = {
    cancelling: false,
    kind: undefined as "timeout" | "cancel" | undefined,
  };
  const clock = {
    pause() {},
    resume() {},
  };
  const runAbort = new AbortController();
  let bridge: AskTeamBridge | undefined;
  let emitQueue: Promise<void> = Promise.resolve();
  const emit: AcpEventListener = (event) => {
    emitQueue = emitQueue.then(async () => {
      await appendFile(transcript, `${JSON.stringify({ t: new Date().toISOString(), event })}\n`);
      await options.onEvent?.(event);
    });
    return emitQueue;
  };

  const terminals = new TerminalRegistry(guard, options.env ?? process.env);
  if (options.askTeam) {
    bridge = await startAskTeamBridge({
      socketPath: `${runDir(options.pawsRoot, options.runId)}/ask-team.sock`,
      hook: options.askTeam,
      context: { itemId: options.itemId, runId: options.runId, role: options.role },
      signal: runAbort.signal,
      onAsk: (question) => emit({ type: "ask_team", question, phase: "asked" }),
      onAnswer: (question, answer) =>
        emit({ type: "ask_team", question, phase: "answered", answer }),
      onHookStart: () => clock.pause(),
      onHookEnd: () => clock.resume(),
    });
  }

  const app = client({ name: "paws" })
    .onRequest(methods.client.session.requestPermission, (ctx) =>
      answerPermission(ctx.params, guard, () => state.cancelling, emit),
    )
    .onNotification(methods.client.session.update, (ctx) =>
      emit({ type: "session_update", sessionId: ctx.params.sessionId, update: ctx.params.update }),
    )
    .onRequest(methods.client.fs.readTextFile, (ctx) => readGuarded(ctx.params, guard))
    .onRequest(methods.client.fs.writeTextFile, (ctx) => writeGuarded(ctx.params, guard))
    .onRequest(methods.client.terminal.create, (ctx) => terminals.create(ctx.params))
    .onRequest(methods.client.terminal.output, (ctx) => terminals.output(ctx.params))
    .onRequest(methods.client.terminal.waitForExit, (ctx) => terminals.wait(ctx.params))
    .onRequest(methods.client.terminal.kill, (ctx) => terminals.kill(ctx.params))
    .onRequest(methods.client.terminal.release, (ctx) => terminals.release(ctx.params));

  let cancelNotified = false;
  const notifyCancelled = (reason: "timeout" | "cancel") => {
    if (cancelNotified) return;
    cancelNotified = true;
    return emit({ type: "cancelled", reason });
  };

  let result: RunAgentResult = {
    role: options.role,
    stopReason: "error",
    timedOut: false,
    cancelled: false,
    authRequired: false,
    pid: child.pid,
    agentExited: false,
  };

  try {
    if (!child.stdin || !child.stdout) throw new Error("agent stdio pipes were not created");
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
    );
    result = await app.connectWith(stream, async (ctx) => {
      const initialized = await ctx.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: CLIENT_INFO,
        clientCapabilities: clientCapabilities(),
      });
      const auth = summarizeAuth(initialized as InitializeResponse);
      await emit({ type: "auth_checked", role: options.role, auth });

      let sessionId: string;
      try {
        const created = await ctx.request(methods.agent.session.new, {
          cwd: options.worktreePath,
          mcpServers: bridge ? [bridge.mcpServer] : [],
        });
        sessionId = created.sessionId;
      } catch (error) {
        if (isAuthRequired(error)) {
          await emit({ type: "error", message: AUTH_REQUIRED_MESSAGE });
          return baseResult(options.role, child, {
            stopReason: "error",
            auth,
            authRequired: true,
            errorMessage: AUTH_REQUIRED_MESSAGE,
          });
        }
        throw error;
      }
      await emit({
        type: "session_started",
        role: options.role,
        sessionId,
        cwd: options.worktreePath,
      });

      const outcome = await runPrompt({
        ctx,
        child,
        sessionId,
        prompt: options.prompt,
        state,
        timeoutMs: options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
        graceMs,
        signal: options.signal,
        runAbort,
        clock,
      });

      if (
        outcome.errorMessage &&
        !outcome.cancelled &&
        !outcome.timedOut &&
        !outcome.authRequired
      ) {
        await emit({ type: "error", message: outcome.errorMessage });
      }
      if (outcome.acpStopReason && !outcome.cancelled && !outcome.timedOut) {
        await emit({ type: "prompt_complete", stopReason: outcome.acpStopReason });
      }
      if (outcome.cancelled || outcome.timedOut) {
        await notifyCancelled(outcome.timedOut ? "timeout" : "cancel");
      }

      return baseResult(options.role, child, { ...outcome, sessionId, auth });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const detail = stderr.text().trim();
    const intentional = state.kind === "timeout" || state.kind === "cancel";
    result = baseResult(options.role, child, {
      stopReason:
        state.kind === "timeout" ? "timeout" : state.kind === "cancel" ? "cancelled" : "error",
      timedOut: state.kind === "timeout",
      cancelled: state.cancelling,
      ...(intentional ? {} : { errorMessage: detail ? `${message}\n${detail}` : message }),
    });
    if (intentional) {
      await notifyCancelled(state.kind === "timeout" ? "timeout" : "cancel");
    } else {
      await emit({ type: "error", message: result.errorMessage ?? message });
    }
  } finally {
    result.agentExited = await stopChild(child, graceMs);
    result.pid = child.pid;
    if (options.checkpoint !== false) {
      const reason = result.timedOut
        ? "timeout"
        : result.cancelled
          ? "cancel"
          : result.stopReason === "error"
            ? "error"
            : "prompt_complete";
      try {
        result.checkpoint = await commitCheckpoint(
          options.worktreePath,
          `wip: ${options.itemId} ${reason}`,
        );
        await emit({ type: "checkpoint", reason, checkpoint: result.checkpoint });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errorMessage = result.errorMessage ?? message;
        await emit({ type: "error", message });
      }
    }
    await bridge?.close();
    await emitQueue.catch(() => undefined);
  }
  return result;
}

interface PromptState {
  cancelling: boolean;
  kind: "timeout" | "cancel" | undefined;
}

async function runPrompt(options: {
  ctx: ClientContext;
  child: ChildProcess;
  sessionId: string;
  prompt: string;
  state: PromptState;
  timeoutMs: number;
  graceMs: number;
  signal?: AbortSignal;
  runAbort: AbortController;
  clock: { pause(): void; resume(): void };
}): Promise<Omit<RunAgentResult, "role" | "pid" | "agentExited">> {
  const { ctx, child, sessionId, state } = options;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let remaining = options.timeoutMs;
  let started = Date.now();
  let paused = false;

  const beginStop = (kind: "timeout" | "cancel") => {
    if (state.cancelling) return;
    state.cancelling = true;
    state.kind = kind;
    options.runAbort.abort();
    void ctx.notify(methods.agent.session.cancel, { sessionId }).catch(() => undefined);
    killTimer = setTimeout(() => killTree(child, "SIGKILL"), options.graceMs);
  };

  const arm = (ms: number) => {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    timeoutTimer = setTimeout(() => beginStop("timeout"), ms);
  };
  arm(remaining);

  options.clock.pause = () => {
    if (state.cancelling || paused) return;
    paused = true;
    remaining = Math.max(0, remaining - (Date.now() - started));
    if (timeoutTimer) clearTimeout(timeoutTimer);
    timeoutTimer = undefined;
  };
  options.clock.resume = () => {
    if (!paused || state.cancelling) return;
    paused = false;
    started = Date.now();
    arm(remaining);
  };

  const onAbort = () => beginStop("cancel");
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });

  let acpStopReason: StopReason | undefined;
  let errorMessage: string | undefined;
  let authRequired = false;
  try {
    const response = await ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: options.prompt }],
    });
    acpStopReason = response.stopReason;
  } catch (error) {
    if (isAuthRequired(error)) {
      authRequired = true;
      errorMessage = AUTH_REQUIRED_MESSAGE;
    } else if (!state.cancelling) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
    if (state.cancelling) {
      await waitForExit(child, options.graceMs);
      killTree(child, "SIGKILL");
      await waitForExit(child, 500);
    }
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (killTimer) clearTimeout(killTimer);
    options.clock.pause = () => undefined;
    options.clock.resume = () => undefined;
    options.signal?.removeEventListener("abort", onAbort);
  }

  const timedOut = state.kind === "timeout";
  const cancelled = state.cancelling || acpStopReason === "cancelled";
  let stopReason: RunAgentResult["stopReason"] = "error";
  if (timedOut) stopReason = "timeout";
  else if (cancelled) stopReason = "cancelled";
  else if (acpStopReason) stopReason = acpStopReason;
  else if (!errorMessage) stopReason = "error";

  return {
    stopReason,
    ...(acpStopReason ? { acpStopReason } : {}),
    timedOut,
    cancelled,
    authRequired,
    ...(errorMessage ? { errorMessage } : {}),
  };
}

function answerPermission(
  params: RequestPermissionRequest,
  guard: GuardContext,
  cancelling: () => boolean,
  emit: AcpEventListener,
): Promise<RequestPermissionResponse> | RequestPermissionResponse {
  const tool = params.toolCall;
  if (cancelling()) {
    void emit({
      type: "permission",
      toolCallId: tool.toolCallId,
      decision: "cancelled",
      reason: "run cancelled",
      title: tool.title,
      kind: tool.kind,
      name: tool.name,
    });
    return { outcome: { outcome: "cancelled" } };
  }
  const decision = decidePermission(
    {
      kind: tool.kind,
      name: tool.name,
      title: tool.title,
      locations: tool.locations,
      rawInput: tool.rawInput,
    },
    guard,
  );
  const selected = selectOption(params.options, decision.allow);
  void emit({
    type: "permission",
    toolCallId: tool.toolCallId,
    decision: selected ? (decision.allow ? "allow" : "deny") : "cancelled",
    reason: decision.reason,
    ...(selected ? { optionId: selected.optionId } : {}),
    title: tool.title,
    kind: tool.kind,
    name: tool.name,
  });
  if (!selected) return { outcome: { outcome: "cancelled" } };
  return { outcome: { outcome: "selected", optionId: selected.optionId } };
}

function selectOption(options: PermissionOption[], allow: boolean): PermissionOption | undefined {
  const kinds: PermissionOption["kind"][] = allow
    ? ["allow_once", "allow_always"]
    : ["reject_once", "reject_always"];
  for (const kind of kinds) {
    const found = options.find((option) => option.kind === kind);
    if (found) return found;
  }
  return undefined;
}

function clientCapabilities() {
  return {
    fs: { readTextFile: true, writeTextFile: true },
    terminal: true,
  };
}

async function withConnection<T>(
  child: ChildProcess,
  op: (ctx: ClientContext) => Promise<T>,
): Promise<T> {
  if (!child.stdin || !child.stdout) throw new Error("agent stdio pipes were not created");
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
  );
  const app = client({ name: "paws" });
  const spawnError = new Promise<never>((_, reject) => {
    child.once("error", reject);
  });
  return Promise.race([spawnError, app.connectWith(stream, op)]);
}

function withTimeout<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for initialize")), ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    });
  });
}

function baseResult(
  role: AgentRole,
  child: ChildProcess,
  fields: Partial<Omit<RunAgentResult, "role" | "pid" | "agentExited">> &
    Pick<RunAgentResult, "stopReason">,
): RunAgentResult {
  return {
    role,
    pid: child.pid,
    agentExited: child.exitCode != null || child.signalCode != null,
    timedOut: false,
    cancelled: false,
    authRequired: false,
    ...fields,
  };
}

export type { AskTeamHook };
