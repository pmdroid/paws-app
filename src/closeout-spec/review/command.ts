import { journalCaught } from "../../journal";

/** Agents whose own review command Closeout starts. */
export type ReviewCommandAgent = "codex" | "claude";

export type ReviewCommandRequest = {
  argv: string[];
  /** Candidate checkout at `head`. */
  cwd: string;
};

/** `exitCode` null means the command did not start or was stopped at its timeout. */
export type ReviewCommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
};

/** Runs one review command. Argv is passed to the process, never through a shell. */
export interface ReviewCommandRunner {
  run(request: ReviewCommandRequest): Promise<ReviewCommandResult>;
}

/** Final message and identity read from a review command's JSON events. */
export type ReviewCommandReply = {
  session: string;
  model?: string;
  provider?: string;
  /** Final message. Empty when the events carry none. */
  text: string;
  /** Set when the events report a failed turn. */
  error?: string;
};

const PROVIDERS: Record<ReviewCommandAgent, string> = { codex: "openai", claude: "anthropic" };

export function reviewProvider(agent: ReviewCommandAgent): string {
  return PROVIDERS[agent];
}

/**
 * The agent's own review of `base..head`.
 * Codex: `codex exec review --base <base>`, which takes no prompt beside `--base`.
 * Claude: `/code-review <base>..<head>` in a plan-mode print session.
 * Neither command gets a bypass flag; each runs its own read-only review.
 */
export function reviewArgv(input: {
  agent: ReviewCommandAgent;
  command?: string;
  model: string;
  base: string;
  head: string;
  /** Codex reads the schema from a file. Claude takes it inline. */
  schemaPath: string;
  schema: string;
}): string[] {
  if (input.agent === "codex") {
    return [
      input.command ?? "codex",
      "exec",
      "review",
      "--base",
      input.base,
      "--model",
      input.model,
      "--json",
      "--output-schema",
      input.schemaPath,
    ];
  }
  return [
    input.command ?? "claude",
    "-p",
    "--permission-mode",
    "plan",
    "--model",
    input.model,
    "--output-format",
    "stream-json",
    "--verbose",
    "--json-schema",
    input.schema,
    `/code-review ${input.base}..${input.head}`,
  ];
}

/** Follow-up in the same review session, for a final message that did not parse. */
export function reaskArgv(input: {
  agent: ReviewCommandAgent;
  command?: string;
  model: string;
  session: string;
  schemaPath: string;
  schema: string;
  prompt: string;
}): string[] {
  if (input.agent === "codex") {
    return [
      input.command ?? "codex",
      "exec",
      "resume",
      input.session,
      "--model",
      input.model,
      "--json",
      "--output-schema",
      input.schemaPath,
      input.prompt,
    ];
  }
  return [
    input.command ?? "claude",
    "-p",
    "--resume",
    input.session,
    "--permission-mode",
    "plan",
    "--model",
    input.model,
    "--output-format",
    "stream-json",
    "--verbose",
    "--json-schema",
    input.schema,
    input.prompt,
  ];
}

/** Reads session, model, provider, and the final message from JSON Lines events. */
export function parseReviewEvents(agent: ReviewCommandAgent, stdout: string): ReviewCommandReply {
  const reply: ReviewCommandReply = { session: "", text: "" };
  for (const line of stdout.split("\n")) {
    const event = eventOf(line);
    if (!event) continue;
    const model = stringField(event, "model");
    if (model) reply.model = model;
    const provider = stringField(event, "model_provider") ?? stringField(event, "provider");
    if (provider) reply.provider = provider;
    if (agent === "codex") readCodexEvent(event, reply);
    else readClaudeEvent(event, reply);
  }
  return reply;
}

function readCodexEvent(event: Record<string, unknown>, reply: ReviewCommandReply): void {
  const type = event.type;
  if (type === "thread.started") {
    reply.session = stringField(event, "thread_id") ?? reply.session;
    return;
  }
  if (type === "item.completed" && isRecord(event.item)) {
    const item = event.item;
    if (item.type === "agent_message" && typeof item.text === "string") reply.text = item.text;
    return;
  }
  if (type === "turn.failed" || type === "error") {
    const error = isRecord(event.error) ? stringField(event.error, "message") : undefined;
    reply.error = error ?? stringField(event, "message") ?? "the review turn failed";
  }
}

function readClaudeEvent(event: Record<string, unknown>, reply: ReviewCommandReply): void {
  const session = stringField(event, "session_id");
  if (session) reply.session = session;
  if (event.type !== "result") return;
  if (event.is_error === true) {
    reply.error = stringField(event, "result") ?? stringField(event, "subtype") ?? "review failed";
    return;
  }
  if (event.structured_output !== undefined && event.structured_output !== null) {
    reply.text = JSON.stringify(event.structured_output);
    return;
  }
  reply.text = stringField(event, "result") ?? "";
}

function eventOf(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const value = JSON.parse(trimmed) as unknown;
    return isRecord(value) ? value : undefined;
  } catch (caughtError1) {
    journalCaught(caughtError1, "command.eventOf.parse", null);
    return undefined;
  }
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const REVIEW_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;

/** Spawns the review command in the candidate checkout. */
export function createReviewCommandRunner(
  options: {
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
    /** Stops the command when aborted, as at its timeout. */
    signal?: AbortSignal;
  } = {},
): ReviewCommandRunner {
  const timeoutMs = options.timeoutMs ?? REVIEW_COMMAND_TIMEOUT_MS;
  return {
    async run(request) {
      let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
      try {
        proc = Bun.spawn(request.argv, {
          cwd: request.cwd,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: options.env ?? process.env,
        });
      } catch (error) {
        journalCaught(error, "command.createReviewCommandRunner.spawn", null);
        const message = error instanceof Error ? error.message : String(error);
        return { exitCode: null, stdout: "", stderr: message };
      }
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGKILL");
      }, timeoutMs);
      const stop = () => proc.kill("SIGKILL");
      if (options.signal?.aborted) stop();
      options.signal?.addEventListener("abort", stop, { once: true });
      try {
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        return timedOut
          ? { exitCode: null, stdout, stderr, timedOut: true }
          : { exitCode, stdout, stderr };
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", stop);
      }
    },
  };
}

export type FakeReviewCommandRunner = ReviewCommandRunner & {
  calls: ReviewCommandRequest[];
};

/**
 * Returns scripted results in order and records each argv and cwd.
 * `inspect` runs before a result is returned, while the checkout still exists.
 */
export function createFakeReviewCommandRunner(
  results: ReviewCommandResult[],
  inspect?: (request: ReviewCommandRequest) => void | Promise<void>,
): FakeReviewCommandRunner {
  const calls: ReviewCommandRequest[] = [];
  return {
    calls,
    async run(request) {
      calls.push({ argv: [...request.argv], cwd: request.cwd });
      await inspect?.(request);
      const result = results[calls.length - 1];
      if (!result) throw new Error("no scripted review command result");
      return result;
    },
  };
}
