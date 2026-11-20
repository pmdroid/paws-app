import {
  acknowledgeRunnerHelperSteps,
  endRunnerHelperSteps,
  workspaceMemberUsable,
  getLinearSessionSteps,
  insertRunnerHelperSteps,
  linearSessionClientIdSteps,
  openSessionHelperSteps,
  recordCommandAccountSteps,
  runnerHelperAcknowledgedSteps,
  runnerHelperAvailabilitySteps,
  runnerHelperResultMatchesSteps,
  runnerHelperRowSteps,
  runnerHostVersionSteps,
  storeRunnerHelperResultSteps,
  unacknowledgedRunnerHelpersSteps,
  usableRunnerSteps,
  yieldFindingGroupHelpersSteps,
  workspaceSessionIdsSteps,
  workspaceMemberSteps,
  type Q,
  type Steps,
  type RunnerHelperRow,
  type UsableRunner,
  type Db,
} from "../db";
import { journalCaught } from "../journal";
import type { KeyObject } from "node:crypto";
import { z } from "zod";
import {
  HOST_TOOL_LIMITS,
  HostToolArgumentsSchema,
  HostToolNameSchema,
  RunnerCommandSchema,
  RunnerHelperResultSchema,
  RUNNER_RESULT_BODY_LIMIT,
  runnerHelperLifetime,
  runnerAccountEchoed,
  runnerReleaseAtLeast,
  signRunnerCommand,
  SLACK_REPLY_RUNNER_VERSION,
  withRejectedFields,
  type HostToolDefinitions,
  type RunnerCommand,
  type RunnerHelperResult,
  type RunnerAccount,
  type RunnerProfile,
  type RunnerSlackReplyScope,
  type SignedRunnerCommand,
} from "../runner-protocol";
import { runnerRequestUnavailable } from "../runner-work";

type HelperCommand = Extract<RunnerCommand, { type: "helper" }>;
type HelperDispatch = {
  runnerId: string;
  sessionId: string;
  purpose: HelperCommand["purpose"];
  profile: RunnerProfile;
  prompt: string;
  account?: RunnerAccount;
  conversation?: HelperCommand["conversation"];
  slack?: RunnerSlackReplyScope;
  tools?: HostToolDefinitions;
};

export type HelperToolAnswer = { text: string; isError?: boolean };
export type HelperToolHandler = (
  name: string,
  args: z.infer<typeof HostToolArgumentsSchema>,
) => Promise<HelperToolAnswer>;

const HELPER_TOOL_REQUESTS = 64;
const HELPER_TOOL_TIMEOUT_MS = 30_000;
const HELPER_TOOL_BODY_LIMIT = 65_536;
const usedUp: HelperToolAnswer = { text: "This run has used all its tool calls.", isError: true };
const unanswered: HelperToolAnswer = { text: "Paws could not answer that tool.", isError: true };
const HelperToolRequestSchema = z.strictObject({
  requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
  name: HostToolNameSchema,
  arguments: HostToolArgumentsSchema,
});

export type SlackReplyAuthority = (
  q: Q,
  input: { workspaceId: string; scope: RunnerSlackReplyScope; issuedAt?: number },
) => Steps<boolean>;

export class HelperFencedError extends Error {
  override readonly name = "HelperFencedError";
}
export class RunnerHelperBusyError extends Error {
  override readonly name = "RunnerHelperBusyError";
  constructor(readonly heldRunnerId?: string) {
    super("Runner is busy");
  }
}

export function createRunnerHelpers(options: {
  store: Db;
  keyId: string;
  privateKey: KeyObject;
  now?: () => number;
  credentials?: (
    runnerId: string,
    envelopes: SignedRunnerCommand[],
  ) => Promise<SignedRunnerCommand[]>;
  slack?: SlackReplyAuthority;
}) {
  const { store } = options;
  const now = options.now ?? Date.now;
  const handlers = new Map<
    string,
    { handler: HelperToolHandler; answers: Map<string, Promise<HelperToolAnswer>> }
  >();
  async function answerTool(
    handler: HelperToolHandler,
    name: string,
    args: z.infer<typeof HostToolArgumentsSchema>,
  ): Promise<HelperToolAnswer> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const answer = await Promise.race([
        Promise.resolve().then(() => handler(name, args)),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), HELPER_TOOL_TIMEOUT_MS);
        }),
      ]);
      if (!answer || typeof answer.text !== "string") return unanswered;
      return {
        text: cutBytes(answer.text, HOST_TOOL_LIMITS.answerBytes),
        ...(answer.isError ? { isError: true } : {}),
      };
    } catch (error) {
      journalCaught(error, "runner-helpers.tool.answer", null);
      return unanswered;
    } finally {
      clearTimeout(timer);
    }
  }
  function* identitySteps(q: Q, runnerId: string) {
    return identified(yield* usableRunnerSteps(q, runnerId));
  }
  function* scopeSteps(
    q: Q,
    runnerId: string,
    sessionId: string,
    generation: number,
    purpose: HelperCommand["purpose"] | undefined,
    slack: RunnerSlackReplyScope | undefined,
    issuedAt: number,
  ) {
    const runner = yield* identitySteps(q, runnerId);
    if (purpose === "slack_reply") {
      if (
        !slack ||
        !options.slack ||
        sessionId !== slack.requestId ||
        generation !== slack.installGeneration ||
        runner.userId !== slack.memberUserId ||
        !runnerReleaseAtLeast(
          yield* runnerHostVersionSteps(q, runnerId),
          SLACK_REPLY_RUNNER_VERSION,
        ) ||
        !(yield* options.slack(q, { workspaceId: runner.workspaceId, scope: slack, issuedAt }))
      )
        throw new HelperFencedError("Slack reply authority changed");
      return runner;
    }
    const session = yield* getLinearSessionSteps(q, sessionId);
    const clientId = yield* linearSessionClientIdSteps(q, sessionId);
    const grouping = purpose === "finding_groups";
    const member = grouping
      ? yield* workspaceMemberSteps(q, runner.workspaceId, runner.userId)
      : null;
    if (
      !sessionHeld(grouping, member, session, generation, clientId) ||
      !(yield* workspaceSessionIdsSteps(q, runner.workspaceId, runner.userId, clientId)).includes(
        sessionId,
      )
    )
      throw new HelperFencedError("Linear helper session authority changed");
    return runner;
  }
  function* currentSteps(q: Q, id: string, runnerId?: string) {
    const { row, command, envelope } = assigned(yield* runnerHelperRowSteps(q, id), id, runnerId);
    const runner = yield* scopeSteps(
      q,
      row.runnerId,
      command.sessionId,
      command.sessionGeneration,
      command.purpose,
      command.slack,
      command.issuedAt,
    );
    return { row: unchangedIdentity(runner, row), command, envelope };
  }
  function assigned(row: RunnerHelperRow | null, id: string, runnerId?: string) {
    if (!row || (runnerId !== undefined && row.runnerId !== runnerId) || row.endedAt !== null)
      throw new HelperFencedError("Runner helper assignment is unavailable");
    const envelope = JSON.parse(row.envelope) as SignedRunnerCommand;
    const command = RunnerCommandSchema.parse(
      JSON.parse(Buffer.from(envelope.payload, "base64url").toString("utf8")),
    );
    if (
      command.type !== "helper" ||
      command.id !== id ||
      command.runnerId !== row.runnerId ||
      command.workspaceId !== row.workspaceId ||
      command.issuedAt > now() ||
      command.expiresAt <= now()
    )
      throw new HelperFencedError("Runner helper command is obsolete");
    return { row, command, envelope };
  }
  function* openSteps(q: Q, sessionId: string): Steps<HelperCommand | null> {
    const session = yield* getLinearSessionSteps(q, sessionId);
    const row = session && (yield* openSessionHelperSteps(q, sessionId, session.generation, now()));
    if (!row) return null;
    try {
      return (yield* currentSteps(q, row.id)).command;
    } catch (error) {
      if (error instanceof HelperFencedError) return null;
      throw error;
    }
  }
  function* dispatchSteps(q: Q, input: HelperDispatch) {
    const slack = input.purpose === "slack_reply";
    const session = slack ? null : yield* getLinearSessionSteps(q, input.sessionId);
    if (!slack && !session) throw new HelperFencedError("Linear helper session is unavailable");
    const generation = session ? session.generation : (input.slack?.installGeneration ?? -1);
    const runner = yield* scopeSteps(
      q,
      input.runnerId,
      input.sessionId,
      generation,
      input.purpose,
      input.slack,
      now(),
    );
    if (runner.status !== "active") throw new Error("Runner is not accepting helper work");
    const conversation = input.purpose === "conversation" || slack;
    if (input.purpose === "classify" || input.purpose === "select_repository") {
      const open = yield* openSteps(q, input.sessionId);
      if (open) throw new RunnerHelperBusyError(open.runnerId);
    }
    const availability = yield* runnerHelperAvailabilitySteps(
      q,
      input.runnerId,
      now(),
      input.purpose !== "finding_groups",
      conversation,
    );
    if (availability.held) throw new RunnerHelperBusyError(input.runnerId);
    if (!availability.available) throw new RunnerHelperBusyError();
    const at = now();
    const command = RunnerCommandSchema.parse({
      ...input,
      id: Bun.randomUUIDv7(),
      type: "helper",
      workspaceId: runner.workspaceId,
      sessionGeneration: generation,
      issuedAt: at,
      expiresAt: at + runnerHelperLifetime(input.purpose),
    }) as HelperCommand;
    const envelope = signRunnerCommand({
      keyId: options.keyId,
      privateKey: options.privateKey,
      command,
    });
    // Validate and sign first. Fencing and admission commit together, only on this runner.
    yield* recordCommandAccountSteps(q, command, at);
    if (input.purpose !== "finding_groups" && !conversation)
      yield* yieldFindingGroupHelpersSteps(q, input.runnerId, at);
    yield* insertRunnerHelperSteps(q, {
      id: command.id,
      runnerId: command.runnerId,
      workspaceId: command.workspaceId,
      sessionId: slack ? null : command.sessionId,
      sessionGeneration: command.sessionGeneration,
      runnerFence: runner.fence,
      envelope: JSON.stringify(envelope),
      expiresAt: command.expiresAt,
      purpose: command.purpose,
    });
    return { command, envelope };
  }
  const api = {
    dispatchSteps,
    dispatch: (input: HelperDispatch) => store.transaction((q) => dispatchSteps(q, input)),
    commands(runnerId: string): Promise<SignedRunnerCommand[]> {
      return store.run(function* (q) {
        yield* identitySteps(q, runnerId);
        const result: SignedRunnerCommand[] = [];
        const ids = yield* unacknowledgedRunnerHelpersSteps(q, runnerId, now());
        for (const id of ids) {
          try {
            result.push((yield* currentSteps(q, id, runnerId)).envelope);
          } catch (error) {
            if (!(error instanceof HelperFencedError)) throw error;
            journalCaught(error, "runner-helpers.commands.push", null);
          }
          if (result.length === 16) break;
        }
        return result;
      });
    },
    current: (id: string, runnerId?: string) => store.run((q) => currentSteps(q, id, runnerId)),
    handle(commandId: string, handler: HelperToolHandler): () => void {
      const entry = { handler, answers: new Map<string, Promise<HelperToolAnswer>>() };
      handlers.set(commandId, entry);
      return () => {
        if (handlers.get(commandId) === entry) handlers.delete(commandId);
      };
    },
    async request(
      runnerId: string,
      id: string,
      input: z.infer<typeof HelperToolRequestSchema>,
    ): Promise<HelperToolAnswer> {
      const { command } = await api.current(id, runnerId);
      const entry = handlers.get(id);
      if (!entry || !command.tools?.some((tool) => tool.name === input.name))
        throw new HelperFencedError("Runner helper tool is unavailable");
      const known = entry.answers.get(input.requestId);
      if (known) return known;
      if (entry.answers.size >= HELPER_TOOL_REQUESTS) return usedUp;
      const answer = answerTool(entry.handler, input.name, input.arguments);
      entry.answers.set(input.requestId, answer);
      return answer;
    },
    openSteps,
    acknowledged: (id: string) => store.run((q) => runnerHelperAcknowledgedSteps(q, id)),
    async acknowledge(runnerId: string, id: string): Promise<void> {
      await store.transaction(function* (q) {
        yield* currentSteps(q, id, runnerId);
        yield* acknowledgeRunnerHelperSteps(q, id, now());
      });
    },
    async submit(runnerId: string, result: RunnerHelperResult) {
      const parsed = RunnerHelperResultSchema.parse(result);
      return store.transaction(function* (q) {
        const { row, command } = yield* currentSteps(q, parsed.commandId, runnerId);
        if (!runnerAccountEchoed(command, parsed))
          throw new Error("Runner helper result account does not match its command");
        const payload = JSON.stringify(parsed);
        if (row.result !== null) {
          if (!(yield* runnerHelperResultMatchesSteps(q, parsed.commandId, payload)))
            throw new Error("Runner helper result is immutable");
          return { duplicate: true };
        }
        yield* storeRunnerHelperResultSteps(q, parsed.commandId, payload);
        return { duplicate: false };
      });
    },
    async result(id: string): Promise<RunnerHelperResult | null> {
      const { row } = await store.run((q) => currentSteps(q, id));
      return row.result === null ? null : RunnerHelperResultSchema.parse(JSON.parse(row.result));
    },
    finishSteps(q: Q, id: string): Steps<void> {
      return endRunnerHelperSteps(q, id, now());
    },
    async finish(id: string): Promise<void> {
      await store.run((q) => endRunnerHelperSteps(q, id, now()));
    },
    async fetch(request: Request, runnerId: string): Promise<Response | null> {
      const path = new URL(request.url).pathname;
      const json = (value: unknown, status = 200) =>
        Response.json(value, { status, headers: { "cache-control": "no-store" } });
      try {
        if (path === "/v1/helper-commands" && request.method === "GET")
          return json({
            commands: await (options.credentials ?? ((_, sent) => Promise.resolve(sent)))(
              runnerId,
              await api.commands(runnerId),
            ),
          });
        const match = /^\/v1\/helper-commands\/([^/]+)\/(ack|lease|result|request)$/.exec(path);
        if (!match || request.method !== "POST") return null;
        const id = z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/)
          .parse(decodeURIComponent(match[1]!));
        const input = await body(
          request,
          match[2] === "request" ? HELPER_TOOL_BODY_LIMIT : RUNNER_RESULT_BODY_LIMIT,
        );
        if (match[2] === "request")
          return json(await api.request(runnerId, id, HelperToolRequestSchema.parse(input)));
        if (match[2] === "result") {
          const result = RunnerHelperResultSchema.parse(input);
          if (result.commandId !== id) throw new Error("Runner helper result command changed");
          return json(await api.submit(runnerId, result));
        }
        z.strictObject({}).parse(input);
        if (match[2] === "ack") {
          await api.acknowledge(runnerId, id);
          return json({ ok: true });
        }
        return json({ expiresAt: (await api.current(id, runnerId)).command.expiresAt });
      } catch (error) {
        journalCaught(error, "runner-helpers.fetch.json", null);
        if (error instanceof HelperFencedError)
          return json({ error: "Runner helper is fenced.", code: "fenced" }, 409);
        if (runnerRequestUnavailable(error))
          return json({ error: "Paws is busy. Retry the request." }, 503);
        const denied = json({ error: "Runner helper request is denied or invalid." }, 403);
        return withRejectedFields(denied, error);
      }
    },
  };
  return api;
}

function identified(row: UsableRunner | null): UsableRunner {
  if (!row) throw new HelperFencedError("Runner helper identity is unavailable");
  return row;
}

/** Whether the session still admits a helper, short of the workspace's session list. */
function sessionHeld(
  grouping: boolean,
  member: { active: boolean | number; revokedAt: number | null; role: string } | null,
  session: { stoppedAt: number | null; generation: number } | null,
  generation: number,
  clientId: string | null,
): clientId is string {
  return !(
    (grouping && (!workspaceMemberUsable(member) || !["admin", "owner"].includes(member.role))) ||
    !session ||
    (!grouping && session.stoppedAt !== null) ||
    session.generation !== generation ||
    !clientId
  );
}

function unchangedIdentity(runner: UsableRunner, row: RunnerHelperRow): RunnerHelperRow {
  if (runner.fence !== row.runnerFence || runner.workspaceId !== row.workspaceId)
    throw new HelperFencedError("Runner helper identity changed");
  return row;
}

function cutBytes(text: string, limit: number): string {
  if (Buffer.byteLength(text) <= limit) return text;
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    bytes += Buffer.byteLength(character);
    if (bytes > limit) break;
    end += character.length;
  }
  return text.slice(0, end);
}

async function body(request: Request, limit: number) {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json")
    throw new Error("JSON is required");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("JSON is required");
  const timeout = AbortSignal.timeout(10_000);
  const cancel = () =>
    void reader.cancel().catch((caughtError1) => {
      journalCaught(caughtError1, "runner-helpers.body.cancel", null);
      return undefined;
    });
  timeout.addEventListener("abort", cancel, { once: true });
  request.signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      timeout.throwIfAborted();
      request.signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > limit) throw new Error("Runner helper input is too large");
      chunks.push(part.value);
    }
    timeout.throwIfAborted();
    request.signal.throwIfAborted();
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    timeout.removeEventListener("abort", cancel);
    request.signal.removeEventListener("abort", cancel);
    await reader.cancel().catch((caughtError2) => {
      journalCaught(caughtError2, "runner-helpers.body.cancel", null);
      return undefined;
    });
    reader.releaseLock();
  }
}

export type RunnerHelpers = ReturnType<typeof createRunnerHelpers>;
