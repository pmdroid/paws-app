import { journalCaught } from "../../journal";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Artifact,
  CandidateIdentity,
  Finding,
  ProducerIdentity,
  ReviewProducer,
  ReviewRecord,
  ReviewRequest,
} from "../types";
import { SPEC_VERSION } from "../types";
import { createCandidateCheckout } from "./checkout";
import {
  parseReviewEvents,
  reaskArgv,
  reviewArgv,
  reviewProvider,
  type ReviewCommandAgent,
  type ReviewCommandReply,
  type ReviewCommandRunner,
} from "./command";
import { findingsJsonSchema, parseFindings, reaskPrompt } from "./findings";
import { assertCommit } from "./prompt";

const DEFAULT_EVALUATOR: ProducerIdentity = { name: "paws", version: "0.1" };

export type ReviewerOptions = {
  /** Agent whose own review command runs: `codex exec review` or Claude `/code-review`. */
  agent: ReviewCommandAgent;
  /** Reviewer profile's model, passed with the command's model flag. */
  model: string;
  /** Executable to start. Defaults to `codex` or `claude`. */
  command?: string;
  evaluator?: ProducerIdentity;
  /** Evidence attempt written on the review record. Defaults to 1. */
  attempt?: number;
};

export type RecordedReview = {
  status: "recorded";
  candidate: CandidateIdentity;
  producer: ReviewProducer;
  findings: Finding[];
  artifacts: Artifact[];
  record: ReviewRecord;
};

export type InvalidReview = {
  status: "invalid";
  candidate: CandidateIdentity;
  producer: ReviewProducer;
  reason: string;
};

/**
 * A recorded review carries schema-valid findings and does not decide pass or fail.
 * An invalid review is blocked. An empty finding list is not a substitute for it.
 */
export type ReviewRunResult = RecordedReview | InvalidReview;

/**
 * Closeout {@link ReviewRequest} reviewer on the agent's own review command.
 * The command runs in a detached checkout of `head` and reviews `base..head`
 * with its own rubric and the repository's `AGENTS.md` or `CLAUDE.md`. The policy
 * skill stays in the digest and is not sent. Independence is left for the
 * evaluator. This port records identities and findings.
 */
export function createReviewer(runner: ReviewCommandRunner, options: ReviewerOptions) {
  const evaluator = options.evaluator ?? DEFAULT_EVALUATOR;
  const attempt = options.attempt ?? 1;
  return {
    async review(request: ReviewRequest): Promise<ReviewRunResult> {
      const candidate = passThrough(request.candidate);
      const blank = blankProducer(options);
      try {
        assertCommit(request.base, "base");
        assertCommit(request.head, "head");
      } catch (error) {
        journalCaught(error, "reviewer.review.assertCommit", null);
        return invalid(candidate, blank, messageOf(error));
      }
      let schemaDir: string;
      let checkout: Awaited<ReturnType<typeof createCandidateCheckout>>;
      const schema = JSON.stringify(findingsJsonSchema());
      try {
        schemaDir = await mkdtemp(join(tmpdir(), "paws-review-schema-"));
      } catch (error) {
        journalCaught(error, "reviewer.review.mkdtemp", null);
        return invalid(candidate, blank, messageOf(error));
      }
      try {
        const schemaPath = join(schemaDir, "findings.schema.json");
        await writeFile(schemaPath, schema);
        try {
          checkout = await createCandidateCheckout(
            request.worktree,
            request.head,
            request.checkoutExclusions,
          );
        } catch (error) {
          journalCaught(error, "reviewer.review.createCandidateCheckout", null);
          return invalid(candidate, blank, messageOf(error));
        }
        try {
          return await runCommand({
            runner,
            options,
            request,
            candidate,
            cwd: checkout.path,
            schemaPath,
            schema,
            evaluator,
            attempt,
          });
        } finally {
          await checkout.remove();
        }
      } catch (error) {
        journalCaught(error, "reviewer.review.runCommand", null);
        return invalid(candidate, blank, messageOf(error));
      } finally {
        await rm(schemaDir, { recursive: true, force: true });
      }
    },
  };
}

type CommandInput = {
  runner: ReviewCommandRunner;
  options: ReviewerOptions;
  request: ReviewRequest;
  candidate: CandidateIdentity;
  cwd: string;
  schemaPath: string;
  schema: string;
  evaluator: ProducerIdentity;
  attempt: number;
};

async function runCommand(input: CommandInput): Promise<ReviewRunResult> {
  const { options } = input;
  const first = await invoke(
    input,
    reviewArgv({
      agent: options.agent,
      ...(options.command !== undefined ? { command: options.command } : {}),
      model: options.model,
      base: input.request.base,
      head: input.request.head,
      schemaPath: input.schemaPath,
      schema: input.schema,
    }),
  );
  if (!first.ok) return invalid(input.candidate, first.producer, first.reason);
  const firstParsed = parseFindings(first.reply.text);
  if (firstParsed.ok) return recorded(input, first.producer, firstParsed.findings);
  if (!first.reply.session) {
    return invalid(
      input.candidate,
      first.producer,
      `${firstParsed.reason}; the review command reported no session to re-ask`,
    );
  }
  const second = await invoke(
    input,
    reaskArgv({
      agent: options.agent,
      ...(options.command !== undefined ? { command: options.command } : {}),
      model: options.model,
      session: first.reply.session,
      schemaPath: input.schemaPath,
      schema: input.schema,
      prompt: reaskPrompt(firstParsed.reason),
    }),
    first.reply,
  );
  if (!second.ok) return invalid(input.candidate, second.producer, second.reason);
  const secondParsed = parseFindings(second.reply.text);
  if (!secondParsed.ok) return invalid(input.candidate, second.producer, secondParsed.reason);
  return recorded(input, second.producer, secondParsed.findings);
}

type Invocation =
  | { ok: true; reply: ReviewCommandReply; producer: ReviewProducer }
  | { ok: false; producer: ReviewProducer; reason: string };

async function invoke(
  input: CommandInput,
  argv: string[],
  earlier?: ReviewCommandReply,
): Promise<Invocation> {
  const result = await input.runner.run({ argv, cwd: input.cwd });
  const parsed = parseReviewEvents(input.options.agent, result.stdout);
  const reply: ReviewCommandReply = {
    ...parsed,
    session: parsed.session || earlier?.session || "",
    ...(parsed.model ? {} : earlier?.model ? { model: earlier.model } : {}),
    ...(parsed.provider ? {} : earlier?.provider ? { provider: earlier.provider } : {}),
  };
  const producer = producerOf(reply, input.options);
  const name = argv.slice(0, 3).join(" ");
  if (result.timedOut) return { ok: false, producer, reason: `${name} timed out` };
  if (result.exitCode !== 0) {
    const detail = reply.error ?? lastLine(result.stderr) ?? lastLine(result.stdout);
    const status = result.exitCode === null ? "did not start" : `exited ${result.exitCode}`;
    return {
      ok: false,
      producer,
      reason: detail ? `${name} ${status}: ${detail}` : `${name} ${status}`,
    };
  }
  if (reply.error) return { ok: false, producer, reason: `${name} failed: ${reply.error}` };
  return { ok: true, reply, producer };
}

function recorded(
  input: {
    request: ReviewRequest;
    candidate: CandidateIdentity;
    evaluator: ProducerIdentity;
    attempt: number;
  },
  producer: ReviewProducer,
  findings: Finding[],
): RecordedReview {
  const artifacts: Artifact[] = [];
  const record: ReviewRecord = {
    specVersion: SPEC_VERSION,
    recordType: "review",
    ...(input.candidate.task ? { task: input.candidate.task } : {}),
    itemId: input.request.item.id,
    base: input.request.base,
    head: input.request.head,
    policyDigest: input.request.policyDigest,
    attempt: input.attempt,
    evaluator: input.evaluator,
    producer,
    findings,
    artifacts,
  };
  return {
    status: "recorded",
    candidate: input.candidate,
    producer,
    findings,
    artifacts,
    record,
  };
}

function invalid(
  candidate: CandidateIdentity,
  producer: ReviewProducer,
  reason: string,
): InvalidReview {
  return { status: "invalid", candidate, producer, reason };
}

function producerOf(reply: ReviewCommandReply, options: ReviewerOptions): ReviewProducer {
  return {
    session: reply.session,
    model: reply.model ?? options.model,
    provider: reply.provider ?? reviewProvider(options.agent),
  };
}

function blankProducer(options: ReviewerOptions): ReviewProducer {
  return { session: "", model: options.model, provider: reviewProvider(options.agent) };
}

function passThrough(candidate: CandidateIdentity): CandidateIdentity {
  return {
    ...(candidate.task !== undefined ? { task: candidate.task } : {}),
    session: candidate.session,
    model: candidate.model,
    provider: candidate.provider,
  };
}

function lastLine(text: string): string | undefined {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.at(-1)?.slice(0, 500);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
