import { appendFile, lstat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  PROTOCOL_VERSION,
  RequestError,
  client,
  methods,
  ndJsonStream,
  type ClientContext,
  type InitializeResponse,
  type NewSessionResponse,
  type ContentBlock,
  type PermissionOption,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type StopReason,
} from "@agentclientprotocol/sdk";
import { loadConfigFile, resolveAgentProfiles } from "../config";
import { loadImplementationSkills } from "./skills";
import { buildAgentPrompt, snapshotAgentInputs } from "./input-files";
import { commitCheckpoint } from "./checkpoint";
import { validateCandidateAttribution } from "./commit-policy";
import {
  appBotCommitIdentity,
  commitIdentityEnv,
  policyCoauthors,
  commitPolicyMessage,
} from "../core";
import { git } from "./git";
import { assertSafeSegment, runDir } from "./paths";
import {
  GROK_LOGIN_MESSAGE,
  rejectAutoApprove,
  resolveAdapter,
  selectGrokAuthMethod,
  xaiApiKeyPresent,
  type AgentRole,
} from "./adapters";
import { startHostToolBridge, type AskTeamBridge, type AskTeamHook } from "./ask-team";
import { installCloseoutStopHook } from "./closeout-hook";
import { AUTH_REQUIRED_MESSAGE, isAuthRequired, summarizeAuth, type AuthCheckResult } from "./auth";
import { sessionModel, selectSessionProfile, providerFor, standardWindowNotice } from "./model";
import { minimalAgentEnv } from "./env";
import { TerminalRegistry, readGuarded, writeGuarded } from "./host-tools";
import { decidePermission, decideReadOnlyPermission, type GuardContext } from "./permissions";
import { captureStderr, killTree, spawnAgent, stopChild, waitForExit } from "./process";
import {
  DEFAULT_CANCEL_GRACE_MS,
  DEFAULT_RUN_TIMEOUT_MS,
  FOLLOW_UP_INTERRUPTION,
  type AcpEventListener,
  type RunAgentOptions,
  type RunAgentResult,
} from "./types";
import type { OwnedProcess } from "./process";

const CLIENT_INFO = { name: "paws", version: "0.0.0" };

export interface CheckOwnLoginOptions {
  role: AgentRole;
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Pass `XAI_API_KEY` through when config allows it. The value is not read here. */
  allowXaiApiKey?: boolean;
}

/**
 * Spawn the adapter, read `initialize` / `authMethods`, and close.
 * Does not call `authenticate` and does not read credential files.
 */
export async function checkOwnLogin(options: CheckOwnLoginOptions): Promise<AuthCheckResult> {
  const adapter = options.command
    ? { command: options.command, args: options.args ?? [] }
    : resolveAdapter(options.role, options.env);
  const child = spawnAgent(
    adapter.command,
    adapter.args,
    minimalAgentEnv(options.env, { allowXaiApiKey: options.allowXaiApiKey }),
  );
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
 * `session/new` + `session/prompt` against the selected implementer
 * (Claude Code, Grok, or Codex) or the Codex reviewer.
 * Session updates are forwarded through `onEvent`.
 * Grok is authenticated with the advertised method id only. Paws does not
 * read `~/.grok/auth.json` or the API key value.
 */
export async function runAgent(options: RunAgentOptions): Promise<RunAgentResult> {
  if (options.signal?.aborted) {
    return {
      role: options.role,
      stopReason: "cancelled",
      cancelled: true,
      interrupted: options.signal.reason === FOLLOW_UP_INTERRUPTION,
      timedOut: false,
      authRequired: false,
      agentExited: true,
    };
  }
  assertSafeSegment(options.itemId, "item id");
  assertSafeSegment(options.runId, "run id");
  if (!isAbsolute(options.worktreePath)) throw new Error("worktreePath must be absolute");
  const suppliedInputs = snapshotAgentInputs(options.worktreePath, options.inputFiles);
  const info = await lstat(options.worktreePath);
  if (!info.isDirectory()) throw new Error("worktreePath is not a directory");
  const preparedInput = options.prepareInputFiles
    ? await options.prepareInputFiles({
        workspace: options.worktreePath,
        prompt: options.prompt,
        signal: options.signal ?? new AbortController().signal,
      })
    : { prompt: options.prompt, inputFiles: [] };
  options.signal?.throwIfAborted();
  const inputFiles = snapshotAgentInputs(options.worktreePath, [
    ...suppliedInputs,
    ...preparedInput.inputFiles,
  ]);

  const home = options.home ?? homedir();
  const guard: GuardContext = {
    hostAccess: options.hostAccess,
    worktree: options.worktreePath,
    home,
    pawsRoot: options.pawsRoot,
  };
  const config = loadConfigFile(join(options.pawsRoot, "config.toml"));
  if (options.role === "implementer" && !options.prepareOnly) {
    const skills = await loadImplementationSkills({
      config,
      pawsRoot: options.pawsRoot,
      worktree: options.worktreePath,
      repository: options.repository,
      root: options.skillsRoot,
      signal: options.signal,
    });
    guard.skillRoots = skills.roots;
    if (skills.prompt) preparedInput.prompt += `\n\n${skills.prompt}`;
  }
  const agents = config.agents;
  const profile = options.profile ?? resolveAgentProfiles(config)[options.role];
  const grok = profile.agent === "grok";
  const sourceEnv = options.env ?? process.env;
  const commitPolicy = !options.readOnly && !options.prepareOnly ? options.commitPolicy : undefined;
  const commitBase = commitPolicy
    ? (
        await git(["-C", options.worktreePath, "rev-parse", "HEAD"], {
          env: options.checkpointEnv ?? sourceEnv,
          signal: options.signal,
        })
      ).trim()
    : undefined;
  if (commitPolicy) policyCoauthors(commitPolicy);
  const attributionEnv = commitPolicy
    ? commitIdentityEnv(appBotCommitIdentity(commitPolicy.bot))
    : {};
  if (commitPolicy) {
    const trailers = commitPolicyMessage("", commitPolicy).trim();
    preparedInput.prompt += `\n\nUse the configured App bot author and committer for every new commit. ${trailers ? `Include these exact human attribution trailers in every new commit message:\n${trailers}` : "Do not add human Co-authored-by trailers."}`;
  }
  const adapter = options.command
    ? { command: options.command, args: options.args ?? [] }
    : resolveAdapter(options.role, sourceEnv, undefined, undefined, agents, profile.agent);
  if (grok) rejectAutoApprove(adapter.args);
  const graceMs = options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
  const directory = runDir(options.pawsRoot, options.runId);
  const transcript = `${directory}/acp.jsonl`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const socketPath = `${directory}/ask-team.sock`;
  const stopHook =
    (options.askTeam ||
      options.updatePlan ||
      options.pullRequest ||
      options.postUpdate ||
      options.publishArtifact) &&
    options.readOnly !== true
      ? await installCloseoutStopHook({
          agent: profile.agent,
          runDirectory: directory,
          socketPath,
          sourceEnv,
        })
      : undefined;
  const child = spawnAgent(
    adapter.command,
    adapter.args,
    {
      ...minimalAgentEnv(sourceEnv, { allowXaiApiKey: grok && agents.grok.allowApiKey }),
      ...attributionEnv,
      ...stopHook?.env,
    },
    {
      ...(grok ? { cwd: options.worktreePath } : {}),
    },
  );
  const stderr = captureStderr(child);

  const state = {
    cancelling: false,
    kind: undefined as PromptState["kind"],
  };
  const clock = {
    pause() {},
    resume() {},
  };
  const runAbort = new AbortController();
  let activeCtx: ClientContext | undefined;
  let activeSessionId: string | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const beginStop = (kind: Exclude<PromptState["kind"], undefined>) => {
    if (state.cancelling) return;
    state.cancelling = true;
    state.kind = kind;
    runAbort.abort();
    if (activeCtx && activeSessionId) {
      void activeCtx
        .notify(methods.agent.session.cancel, { sessionId: activeSessionId })
        .catch(() => undefined);
    }
    killTimer = setTimeout(() => killTree(child, "SIGKILL"), graceMs);
  };
  const onAbort = () =>
    beginStop(
      options.signal?.reason === FOLLOW_UP_INTERRUPTION ? FOLLOW_UP_INTERRUPTION : "cancel",
    );
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const phaseSignal = AbortSignal.any([
    runAbort.signal,
    ...(options.signal ? [options.signal] : []),
  ]);
  let bridge: AskTeamBridge | undefined;
  let emitQueue: Promise<void> = Promise.resolve();
  const emit: AcpEventListener = (event) => {
    emitQueue = emitQueue.then(async () => {
      await appendFile(transcript, `${JSON.stringify({ t: new Date().toISOString(), event })}\n`);
      if (!state.cancelling || event.type === "cancelled") await options.onEvent?.(event);
    });
    return emitQueue;
  };

  const terminals = new TerminalRegistry(guard, options.env ?? process.env, attributionEnv);
  runAbort.signal.addEventListener("abort", () => void terminals.close(graceMs), { once: true });
  const assertRunning = () => {
    if (state.cancelling) throw RequestError.invalidParams({}, "run cancelled");
  };

  let observedModel: string | null = null;
  let changedModel = false;
  let loading = false;
  const app = client({ name: "paws" })
    .onRequest(methods.client.session.requestPermission, (ctx) =>
      answerPermission(ctx.params, guard, options.readOnly === true, () => state.cancelling, emit),
    )
    .onNotification(methods.client.session.update, (ctx) => {
      if (loading) return;
      const update = ctx.params.update;
      if (update.sessionUpdate === "config_option_update") {
        const model = sessionModel({ configOptions: update.configOptions }).model;
        if (
          observedModel &&
          update.configOptions.some(
            (option) => option.category === "model" || option.id === "model",
          ) &&
          model !== observedModel
        )
          changedModel = true;
      }
      return emit({ type: "session_update", sessionId: ctx.params.sessionId, update });
    })
    .onRequest(methods.client.fs.readTextFile, (ctx) => {
      assertRunning();
      return readGuarded(ctx.params, guard);
    })
    .onRequest(methods.client.fs.writeTextFile, (ctx) => {
      assertRunning();
      if (options.readOnly) throw new Error("This agent session is read-only");
      return writeGuarded(ctx.params, guard);
    })
    .onRequest(methods.client.terminal.create, (ctx) => {
      assertRunning();
      if (options.readOnly) throw new Error("This agent session is read-only");
      return terminals.create(ctx.params);
    })
    .onRequest(methods.client.terminal.output, (ctx) => terminals.output(ctx.params))
    .onRequest(methods.client.terminal.waitForExit, (ctx) => terminals.wait(ctx.params))
    .onRequest(methods.client.terminal.kill, (ctx) => terminals.kill(ctx.params))
    .onRequest(methods.client.terminal.release, (ctx) => terminals.release(ctx.params));

  let cancelNotified = false;
  const notifyCancelled = (reason: Exclude<PromptState["kind"], undefined>) => {
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
    if (
      options.askTeam ||
      options.updatePlan ||
      options.pullRequest ||
      options.postUpdate ||
      options.publishArtifact
    ) {
      bridge = await startHostToolBridge({
        socketPath,
        hook: options.askTeam,
        updatePlan: options.updatePlan,
        pullRequest: options.pullRequest,
        postUpdate: options.postUpdate,
        publishArtifact: options.publishArtifact,
        ...(options.closeoutProgress ? { closeoutProgress: options.closeoutProgress } : {}),
        artifactLimits: options.artifactLimits,
        context: {
          itemId: options.itemId,
          runId: options.runId,
          role: options.role,
          worktreePath: options.worktreePath,
        },
        commandGuard: guard,
        ...(options.closeoutPolicy ? { closeoutPolicy: options.closeoutPolicy } : {}),
        allowCloseoutRun: options.readOnly !== true,
        signal: runAbort.signal,
        onAsk: (question) => emit({ type: "ask_team", question, phase: "asked" }),
        onAnswer: (question, answer) =>
          emit({ type: "ask_team", question, phase: "answered", answer }),
        onHookStart: () => clock.pause(),
        onHookEnd: () => clock.resume(),
      });
    }
    assertRunning();
    if (!child.stdin || !child.stdout) throw new Error("agent stdio pipes were not created");
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
    );
    const exit = new Promise<never>((_, reject) => {
      child.once("exit", (code) =>
        reject(new Error(`Agent exited (${code}) before completing the session`)),
      );
      child.once("error", reject);
    });
    result = await Promise.race([
      exit,
      app.connectWith(stream, async (ctx) => {
        activeCtx = ctx;
        const initialized = await withTimeout(
          ctx.request(methods.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            clientInfo: CLIENT_INFO,
            clientCapabilities: clientCapabilities(),
          }),
          30_000,
          phaseSignal,
        );
        const auth = summarizeAuth(initialized as InitializeResponse);
        await emit({ type: "auth_checked", role: options.role, auth });
        assertRunning();
        if (grok) {
          const methodId = selectGrokAuthMethod(auth.authMethods, {
            apiKeyPresent: xaiApiKeyPresent(sourceEnv),
            allowApiKey: agents.grok.allowApiKey,
          });
          if (methodId === null) {
            await emit({ type: "error", message: GROK_LOGIN_MESSAGE });
            return baseResult(options.role, child, {
              stopReason: "error",
              auth,
              authRequired: true,
              errorMessage: GROK_LOGIN_MESSAGE,
            });
          }
          try {
            await withTimeout(
              ctx.request(methods.agent.authenticate, { methodId }),
              30_000,
              phaseSignal,
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await emit({ type: "error", message });
            return baseResult(options.role, child, {
              stopReason: "error",
              auth,
              authRequired: true,
              errorMessage: message,
            });
          }
        }

        let sessionId: string;
        let model: Awaited<ReturnType<typeof selectSessionProfile>>;
        let prompt = preparedInput.prompt;
        try {
          assertRunning();
          const session = {
            cwd: options.worktreePath,
            mcpServers: bridge ? [bridge.mcpServer] : [],
            ...(stopHook?.sessionMeta ? { _meta: stopHook.sessionMeta } : {}),
          };
          let created: NewSessionResponse | undefined;
          if (
            options.resume?.sessionId &&
            (initialized as InitializeResponse).agentCapabilities?.loadSession
          ) {
            loading = true;
            try {
              const loaded = await withTimeout(
                ctx.request(methods.agent.session.load, {
                  ...session,
                  sessionId: options.resume.sessionId,
                }),
                60_000,
                phaseSignal,
              );
              created = { ...loaded, sessionId: options.resume.sessionId };
            } catch (error) {
              phaseSignal.throwIfAborted();
              if (isAuthRequired(error)) throw error;
            } finally {
              loading = false;
            }
          }
          if (!created && options.resume) prompt = options.resume.replayPrompt;
          const opened: NewSessionResponse =
            created ??
            (await withTimeout(
              ctx.request(methods.agent.session.new, session),
              30_000,
              phaseSignal,
            ));
          sessionId = opened.sessionId;
          activeSessionId = sessionId;
          assertRunning();
          model = await withTimeout(
            selectSessionProfile(ctx, opened, profile),
            30_000,
            phaseSignal,
          );
          observedModel = model.model;
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
        const identity = model.model
          ? { session: sessionId, model: model.model, provider: providerFor(profile.agent) }
          : undefined;
        await emit({
          type: "session_started",
          ...(identity ? { identity } : {}),
          role: options.role,
          sessionId,
          cwd: options.worktreePath,
        });
        if (model.standardWindow)
          await emit({ type: "progress", text: standardWindowNotice(model.standardWindow.name) });

        assertRunning();
        if (options.prepareOnly)
          return baseResult(options.role, child, {
            stopReason: "end_turn",
            sessionId,
            identity,
            models: model.models,
            effort: model.effort,
            efforts: model.efforts,
            auth,
          });
        const outcome = await runPrompt({
          ctx,
          child,
          sessionId,
          prompt: buildAgentPrompt(
            prompt,
            options.worktreePath,
            inputFiles,
            (initialized as InitializeResponse).agentCapabilities?.promptCapabilities,
          ),
          state,
          timeoutMs: options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
          graceMs,
          beginStop,
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
          await notifyCancelled(state.kind ?? "cancel");
        }

        if (changedModel)
          throw new Error(
            "Agent changed model during the session; candidate identity is not stable",
          );
        return baseResult(options.role, child, {
          ...outcome,
          sessionId,
          identity,
          models: model.models,
          effort: model.effort,
          efforts: model.efforts,
          auth,
        });
      }),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const detail = stderr.text().trim();
    const intentional = state.cancelling;
    result = baseResult(options.role, child, {
      stopReason: state.kind === "timeout" ? "timeout" : state.cancelling ? "cancelled" : "error",
      timedOut: state.kind === "timeout",
      cancelled: state.cancelling,
      interrupted: state.kind === FOLLOW_UP_INTERRUPTION,
      ...(intentional ? {} : { errorMessage: detail ? `${message}\n${detail}` : message }),
    });
    if (intentional) {
      await notifyCancelled(state.kind ?? "cancel");
    } else {
      await emit({ type: "error", message: result.errorMessage ?? message });
    }
  } finally {
    runAbort.abort();
    result.agentExited = await stopChild(child, graceMs);
    result.pid = child.pid;
    result.transcriptPath = transcript;
    result.agentExited = (await terminals.close(graceMs)) && result.agentExited;
    if (!result.agentExited) {
      result.errorMessage = "ACP process cleanup could not be verified";
      if (!result.cancelled) result.stopReason = "error";
    }
    if (
      options.checkpoint !== false &&
      result.agentExited &&
      !result.cancelled &&
      !options.signal?.aborted
    ) {
      const reason = result.timedOut
        ? "timeout"
        : result.stopReason === "error"
          ? "error"
          : "prompt_complete";
      try {
        const checkpoint = await commitCheckpoint(
          options.worktreePath,
          commitPolicy
            ? commitPolicyMessage(leftoverMessage(reason), commitPolicy)
            : leftoverMessage(reason),
          options.signal,
          () => options.signal?.removeEventListener("abort", onAbort),
          options.checkpointEnv,
          options.checkpointExcludePaths,
          commitPolicy ? appBotCommitIdentity(commitPolicy.bot) : options.checkpointIdentity,
        );
        if (checkpoint.committed || (!state.cancelling && !options.signal?.aborted)) {
          result.checkpoint = checkpoint;
          options.signal?.removeEventListener("abort", onAbort);
          await emit({ type: "checkpoint", reason, checkpoint });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errorMessage = result.errorMessage ?? message;
        await emit({ type: "error", message });
      }
    }
    if (bridge && options.readOnly !== true) {
      try {
        const report = await bridge.closeoutReport();
        if (report !== undefined && Buffer.byteLength(report) <= 65_536)
          result.closeoutReport = report;
      } catch {
        result.closeoutReport = undefined;
      }
    }
    await bridge?.close();
    await emitQueue.catch(() => undefined);
    options.signal?.removeEventListener("abort", onAbort);
    if (killTimer) clearTimeout(killTimer);
    if (state.cancelling) {
      result.cancelled = true;
      result.interrupted = state.kind === FOLLOW_UP_INTERRUPTION;
      result.stopReason = state.kind === "timeout" ? "timeout" : "cancelled";
      result.authRequired = false;
    }
  }
  if (commitPolicy && result.agentExited && !result.cancelled && !options.signal?.aborted) {
    try {
      const head = (
        await git(["-C", options.worktreePath, "rev-parse", "HEAD"], {
          env: options.checkpointEnv ?? sourceEnv,
        })
      ).trim();
      await validateCandidateAttribution(
        options.worktreePath,
        commitBase!,
        head,
        commitPolicy,
        options.checkpointEnv ?? sourceEnv,
        options.signal,
      );
    } catch (error) {
      result.stopReason = "error";
      result.errorMessage = error instanceof Error ? error.message : String(error);
    }
  }
  return result;
}

interface PromptState {
  cancelling: boolean;
  kind: "timeout" | "cancel" | typeof FOLLOW_UP_INTERRUPTION | undefined;
}

async function runPrompt(options: {
  ctx: ClientContext;
  child: OwnedProcess;
  sessionId: string;
  prompt: ContentBlock[];
  state: PromptState;
  timeoutMs: number;
  graceMs: number;
  beginStop(kind: Exclude<PromptState["kind"], undefined>): void;
  clock: { pause(): void; resume(): void };
}): Promise<Omit<RunAgentResult, "role" | "pid" | "agentExited">> {
  const { ctx, child, sessionId, state } = options;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let remaining = options.timeoutMs;
  let started = Date.now();
  let paused = false;

  const arm = (ms: number) => {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    timeoutTimer = setTimeout(() => options.beginStop("timeout"), ms);
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

  let acpStopReason: StopReason | undefined;
  let errorMessage: string | undefined;
  let authRequired = false;
  try {
    const response = await ctx.request(methods.agent.session.prompt, {
      sessionId,
      prompt: options.prompt,
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
    options.clock.pause = () => undefined;
    options.clock.resume = () => undefined;
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
    interrupted: state.kind === FOLLOW_UP_INTERRUPTION,
    authRequired,
    ...(errorMessage ? { errorMessage } : {}),
  };
}

function answerPermission(
  params: RequestPermissionRequest,
  guard: GuardContext,
  readOnly: boolean,
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
  const decision = (readOnly ? decideReadOnlyPermission : decidePermission)(
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
  const reason =
    decision.allow && !selected ? "the agent offered no allow option" : decision.reason;
  void emit({
    type: "permission",
    toolCallId: tool.toolCallId,
    decision: decision.allow && selected ? "allow" : "deny",
    reason,
    ...(selected ? { optionId: selected.optionId } : {}),
    title: tool.title,
    kind: tool.kind,
    name: tool.name,
  });
  if (selected) return { outcome: { outcome: "selected", optionId: selected.optionId } };
  // A "cancelled" outcome cancels the whole prompt turn in ACP. Without a matching
  // option, fail only this tool call so the agent continues without it.
  throw RequestError.internalError(
    { toolCallId: tool.toolCallId },
    `Paws refused this tool call: ${reason}`,
  );
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
  child: OwnedProcess,
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
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    });
  });
}

function baseResult(
  role: AgentRole,
  child: OwnedProcess,
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

function leftoverMessage(reason: "timeout" | "error" | "prompt_complete"): string {
  const why = {
    timeout: "the run timed out",
    error: "the run ended with an error",
    prompt_complete: "the agent finished",
  }[reason];
  return `Save changes the agent left uncommitted (${why})`;
}
