import { journalCaught } from "../journal";
import {
  closeSync,
  constants,
  fchmodSync,
  fchownSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { scrubText } from "../closeout-spec";
import {
  accountAgentEnv,
  minimalAgentEnv,
  runAgent,
  type RunAgentOptions,
  type RunAgentResult,
} from "../acp";
import { ExecutionIdSchema, openRunnerAccountHome } from "../runner-execution";
import { withoutRunnerBin } from "../runner-mise";
import {
  RUNNER_INPUT_CHUNK_BYTES,
  RUNNER_RETRO_CAPABILITY,
  RUNNER_RETRO_LIMITS,
  RunnerRetroCommandSchema,
  RunnerRetroInputRequestSchema,
  RunnerRetroResultSchema,
  type RunnerRetroCommand,
  type RunnerRetroInputKind,
  type RunnerRetroInputRequest,
  type RunnerRetroResult,
} from "../runner-protocol";

export const RETRO_RESULT_FILE = "retro-result.json";
export const RETRO_DIGEST_FILE = "session-digest.json";
const CLAIM_FILE = ".retro-claim";

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

const RetroInputChunkSchema = z.strictObject({
  commandId: z.string(),
  kind: z.enum(["digest", "prompt"]),
  offset: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  data: z.string().max(Math.ceil(RUNNER_INPUT_CHUNK_BYTES / 3) * 4),
});

export type RetroInputFetch = (
  request: RunnerRetroInputRequest,
  signal: AbortSignal,
) => Promise<unknown>;

export class RetroInputIntegrityError extends Error {}
export class RetroCommandMismatchError extends Error {}
export class RetroResultConflictError extends Error {}

export async function downloadRetroInput(
  command: RunnerRetroCommand,
  kind: RunnerRetroInputKind,
  fetchInput: RetroInputFetch,
  signal: AbortSignal,
): Promise<Buffer> {
  const descriptor = command[kind];
  const parts: Buffer[] = [];
  let offset = 0;
  do {
    signal.throwIfAborted();
    const length = Math.min(RUNNER_INPUT_CHUNK_BYTES, descriptor.sizeBytes - offset);
    const request = RunnerRetroInputRequestSchema.parse({
      commandId: command.id,
      workspaceId: command.workspaceId,
      retroId: command.retroId,
      attempt: command.attempt,
      kind,
      sha256: descriptor.sha256,
      offset,
      length,
    });
    const response = await fetchInput(request, signal);
    signal.throwIfAborted();
    const parsed = RetroInputChunkSchema.safeParse(response);
    if (!parsed.success) throw new RetroInputIntegrityError(`The retro ${kind} chunk is malformed`);
    const chunk = parsed.data;
    const bytes = Buffer.from(chunk.data, "base64");
    if (
      chunk.commandId !== command.id ||
      chunk.kind !== kind ||
      chunk.offset !== offset ||
      bytes.toString("base64") !== chunk.data ||
      bytes.length !== length ||
      hash(bytes) !== chunk.sha256
    )
      throw new RetroInputIntegrityError(`The retro ${kind} chunk failed its integrity check`);
    parts.push(bytes);
    offset += bytes.length;
  } while (offset < descriptor.sizeBytes);
  const bytes = Buffer.concat(parts);
  if (bytes.length !== descriptor.sizeBytes || hash(bytes) !== descriptor.sha256)
    throw new RetroInputIntegrityError(`The retro ${kind} does not match its frozen hash`);
  if (!Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes))
    throw new RetroInputIntegrityError(`The retro ${kind} is not UTF-8`);
  return bytes;
}

export function readRetroResult(outputDirectory: string): RunnerRetroResult | null {
  let text: string;
  try {
    const fd = openSync(
      join(outputDirectory, RETRO_RESULT_FILE),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      text = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return RunnerRetroResultSchema.parse(JSON.parse(text));
}

export function recordRetroResult(
  options: { outputDirectory: string; resultsGid: number },
  result: RunnerRetroResult,
): "recorded" | "duplicate" {
  const contents = JSON.stringify(RunnerRetroResultSchema.parse(result));
  const target = join(options.outputDirectory, RETRO_RESULT_FILE);
  const stagingPath = join(options.outputDirectory, `.retro-result-${randomUUID()}.tmp`);
  try {
    const fd = openSync(
      stagingPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o640,
    );
    try {
      fchownSync(fd, process.getuid!(), options.resultsGid);
      fchmodSync(fd, 0o640);
      writeFileSync(fd, contents);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(stagingPath, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const recorded = readRetroResult(options.outputDirectory);
      if (recorded && JSON.stringify(recorded) === contents) return "duplicate";
      throw new RetroResultConflictError("A different result is already recorded for this retro");
    }
    syncDirectory(options.outputDirectory);
    return "recorded";
  } finally {
    rmSync(stagingPath, { force: true });
  }
}

function syncDirectory(path: string): void {
  const directory = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

export interface RetroWorkerOptions {
  executionId: string;
  command: RunnerRetroCommand;
  expected: { runnerId: string; workspaceId: string; attempt: number; settingsRevision: number };
  fetchInput: RetroInputFetch;
  outputDirectory: string;
  workRoot: string;
  home: string;
  resultsGid: number;
  signal?: AbortSignal;
  launch?: Pick<RunAgentOptions, "command" | "args" | "env">;
  executionLimitMs?: number;
  now?: () => number;
}

export type RetroWorkerResult = { result: RunnerRetroResult; delivery: "recorded" | "duplicate" };

export async function executeRetroCommand(options: RetroWorkerOptions): Promise<RetroWorkerResult> {
  const command = RunnerRetroCommandSchema.parse(options.command);
  const executionId = ExecutionIdSchema.parse(options.executionId);
  if (process.getuid?.() === 0) throw new Error("Runner agents must run as a non-root user");
  if (
    ![options.outputDirectory, options.workRoot, options.home].every(isAbsolute) ||
    !Number.isSafeInteger(options.resultsGid) ||
    options.resultsGid < 0
  )
    throw new Error("Invalid runner worker configuration");
  if (
    command.runnerId !== options.expected.runnerId ||
    command.workspaceId !== options.expected.workspaceId ||
    command.attempt !== options.expected.attempt ||
    command.settingsRevision !== options.expected.settingsRevision
  )
    throw new RetroCommandMismatchError("The retro command does not match the runner assignment");
  const now = options.now ?? Date.now;
  const base = {
    executionId,
    commandId: command.id,
    type: "retro" as const,
    capability: RUNNER_RETRO_CAPABILITY,
    runnerId: command.runnerId,
    workspaceId: command.workspaceId,
    retroId: command.retroId,
    attempt: command.attempt,
    settingsRevision: command.settingsRevision,
    digestSha256: command.digest.sha256,
    promptSha256: command.prompt.sha256,
  };
  const secrets = secretValues(options.launch?.env);
  const finish = (
    fields: Pick<RunnerRetroResult, "outcome" | "activeMs"> &
      Partial<Pick<RunnerRetroResult, "output" | "errorMessage" | "identity" | "tokens">>,
  ): RetroWorkerResult => {
    const result = RunnerRetroResultSchema.parse({
      ...base,
      ...fields,
      ...(fields.output !== undefined ? { outputSha256: hash(fields.output) } : {}),
      ...(fields.errorMessage !== undefined
        ? { errorMessage: boundedError(fields.errorMessage, secrets) }
        : {}),
    });
    const delivery = recordRetroResult(options, result);
    console.warn(
      JSON.stringify({
        event: "retro_result",
        executionId,
        commandId: command.id,
        outcome: result.outcome,
        activeMs: result.activeMs,
        outputChars: result.output?.length ?? 0,
      }),
    );
    return { result, delivery };
  };

  const recorded = readRetroResult(options.outputDirectory);
  if (recorded) {
    if (JSON.stringify({ ...recorded, ...base }) !== JSON.stringify(recorded))
      throw new RetroResultConflictError("A different command's result is in this directory");
    return { result: recorded, delivery: "duplicate" };
  }
  try {
    const claim = openSync(
      join(options.outputDirectory, CLAIM_FILE),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(claim, JSON.stringify({ executionId, commandId: command.id }));
      fsyncSync(claim);
    } finally {
      closeSync(claim);
    }
    syncDirectory(options.outputDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const claimed = JSON.parse(readFileSync(join(options.outputDirectory, CLAIM_FILE), "utf8"));
    if (claimed.executionId !== executionId || claimed.commandId !== command.id)
      throw new RetroResultConflictError("A different command claimed this directory", {
        cause: error,
      });
    rmSync(join(options.workRoot, executionId), { recursive: true, force: true });
    return finish({
      outcome: "error",
      activeMs: 0,
      errorMessage: "The runner restarted during the retro turn before it finished.",
    });
  }

  const signal = options.signal ?? new AbortController().signal;
  if (command.profile.model === null)
    return finish({
      outcome: "error",
      activeMs: 0,
      errorMessage: "The retro has no frozen model. A retro runs only a concrete model.",
    });
  let digest: Buffer;
  let prompt: string;
  try {
    digest = await downloadRetroInput(command, "digest", options.fetchInput, signal);
    prompt = (await downloadRetroInput(command, "prompt", options.fetchInput, signal)).toString(
      "utf8",
    );
  } catch (error) {
    if (signal.aborted)
      return finish({
        outcome: "cancelled",
        activeMs: 0,
        errorMessage: "The retro was cancelled.",
      });
    journalCaught(error, "runner-worker.executeRetroCommand.download", null);
    return finish({
      outcome: "error",
      activeMs: 0,
      errorMessage:
        error instanceof RetroInputIntegrityError
          ? error.message
          : "The runner could not download the retro inputs.",
    });
  }

  const root = join(options.workRoot, executionId);
  const workspace = join(root, "workspace");
  mkdirSync(options.workRoot, { recursive: true, mode: 0o700 });
  rmSync(root, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(join(workspace, RETRO_DIGEST_FILE), digest, { flag: "wx", mode: 0o400 });
    const home = openRunnerAccountHome(options.home, command.account, command.profile.agent);
    const env = minimalAgentEnv({
      PATH: "/usr/local/bin:/usr/bin:/bin",
      ...options.launch?.env,
      ...(command.account
        ? accountAgentEnv(home)
        : {
            HOME: home,
            CODEX_HOME: join(home, ".codex"),
            CLAUDE_CONFIG_DIR: join(home, ".claude"),
          }),
    });
    env.PATH = withoutRunnerBin(env.PATH);
    const limitMs = Math.min(
      command.executionLimit.activeMinutes * 60_000,
      options.executionLimitMs ?? Number.MAX_SAFE_INTEGER,
    );
    const overflow = new AbortController();
    let text = "";
    let tokens = 0;
    const started = now();
    let run: RunAgentResult;
    try {
      run = await runAgent({
        ...options.launch,
        env,
        profile: command.profile,
        role: "reviewer",
        readOnly: true,
        hostAccess: false,
        checkpoint: false,
        itemId: executionId,
        runId: executionId,
        prompt,
        worktreePath: workspace,
        pawsRoot: join(root, "paws"),
        home,
        timeoutMs: limitMs,
        signal: AbortSignal.any([signal, overflow.signal]),
        onEvent(event) {
          if (event.type !== "session_update") return;
          if (
            event.update.sessionUpdate === "agent_message_chunk" &&
            event.update.content.type === "text"
          ) {
            text += event.update.content.text;
            if (text.length > command.output.maxChars + 1024) overflow.abort();
          }
          if (event.update.sessionUpdate === "usage_update")
            tokens = Math.max(tokens, event.update.used ?? 0);
        },
      });
    } catch (error) {
      journalCaught(error, "runner-worker.executeRetroCommand.runAgent", null);
      run = {
        role: "reviewer",
        stopReason: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
        timedOut: false,
        cancelled: signal.aborted,
        authRequired: false,
        agentExited: true,
      };
    }
    const activeMs = Math.max(0, Math.min(now() - started, limitMs));
    const turn = {
      activeMs,
      ...(run.identity
        ? { identity: { model: run.identity.model, provider: run.identity.provider } }
        : {}),
      ...(Math.max(tokens, run.tokens ?? 0) > 0
        ? { tokens: Math.max(tokens, run.tokens ?? 0) }
        : {}),
    };
    if (signal.aborted)
      return finish({ ...turn, outcome: "cancelled", errorMessage: "The retro was cancelled." });
    if (overflow.signal.aborted || text.trim().length > command.output.maxChars)
      return finish({
        ...turn,
        outcome: "error",
        errorMessage: `The retro output exceeded ${command.output.maxChars} characters.`,
      });
    if (run.timedOut)
      return finish({
        ...turn,
        outcome: "timeout",
        errorMessage: `The retro turn exceeded its ${Math.ceil(limitMs / 60_000)} minute limit.`,
      });
    if (run.authRequired)
      return finish({
        ...turn,
        outcome: "auth_required",
        errorMessage: run.errorMessage ?? "The agent needs to sign in again.",
      });
    if (run.stopReason !== "end_turn" || run.errorMessage)
      return finish({
        ...turn,
        outcome: "error",
        errorMessage: run.errorMessage ?? `The retro turn stopped: ${run.stopReason}.`,
      });
    if (run.identity?.model !== command.profile.model)
      return finish({
        ...turn,
        outcome: "error",
        errorMessage: `The agent ran ${run.identity?.model ?? "an unknown model"} instead of the frozen model ${command.profile.model}.`,
      });
    if (command.profile.effort !== undefined && run.effort !== command.profile.effort)
      return finish({
        ...turn,
        outcome: "error",
        errorMessage: `The agent ran effort ${run.effort ?? "unknown"} instead of the frozen effort ${command.profile.effort}.`,
      });
    const output = retroJson(text);
    if (output === null)
      return finish({
        ...turn,
        outcome: "error",
        errorMessage: "The retro agent did not return one JSON object.",
      });
    return finish({ ...turn, outcome: "completed", output });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function retroJson(text: string): string | null {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  const body = (fenced ? fenced[1]! : trimmed).trim();
  try {
    const value: unknown = JSON.parse(body);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  } catch {
    return null;
  }
  return body.length > 0 ? body : null;
}

function secretValues(env: NodeJS.ProcessEnv | undefined): string[] {
  return Object.entries({ ...process.env, ...env }).flatMap(([key, value]) =>
    value && /(?:TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL)/i.test(key) ? [value] : [],
  );
}

function boundedError(message: string, secrets: readonly string[]): string {
  const scrubbed = scrubText(message, secrets).trim() || "The retro turn failed.";
  return scrubbed.slice(0, RUNNER_RETRO_LIMITS.errorChars);
}
