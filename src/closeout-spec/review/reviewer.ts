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
import { parseFindings, reaskPrompt } from "./findings";
import { loadReviewMaterial, renderReviewPrompt } from "./prompt";

const PROVIDER = "codex";

const DEFAULT_EVALUATOR: ProducerIdentity = { name: "paws", version: "0.1" };

export type ReviewAgentRequest = {
  itemId: string;
  worktree: string;
  prompt: string;
  readOnly: true;
  /** Set when this prompt continues the session that returned an invalid reply. */
  sessionId?: string;
};

export type ReviewAgentReply = {
  sessionId: string;
  /** Model id the agent reported for this session. */
  model?: string;
  text: string;
};

/** One fresh ACP session of the reviewer agent, pointed at a read-only checkout. */
export interface ReviewAgent {
  run(request: ReviewAgentRequest): Promise<ReviewAgentReply>;
}

export type ReviewerOptions = {
  /** Configured model id, used when the session does not report one. */
  model: string;
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
 * Closeout {@link ReviewRequest} reviewer.
 * Independence is left for the evaluator. This port records identities and findings.
 */
export function createReviewer(agent: ReviewAgent, options: ReviewerOptions) {
  const evaluator = options.evaluator ?? DEFAULT_EVALUATOR;
  const attempt = options.attempt ?? 1;
  return {
    async review(request: ReviewRequest): Promise<ReviewRunResult> {
      const candidate = passThrough(request.candidate);
      let material;
      try {
        material = await loadReviewMaterial({
          repo: request.worktree,
          skill: request.item.skill,
          skillFiles: request.skillFiles,
          base: request.base,
          head: request.head,
        });
      } catch (error) {
        return invalid(candidate, blankProducer(options.model), messageOf(error));
      }
      const prompt = renderReviewPrompt(material, request.base, request.head);
      let checkout: Awaited<ReturnType<typeof createCandidateCheckout>>;
      try {
        checkout = await createCandidateCheckout(
          request.worktree,
          request.head,
          request.checkoutExclusions,
        );
      } catch (error) {
        return invalid(candidate, blankProducer(options.model), messageOf(error));
      }
      try {
        return await runSession({
          agent,
          request,
          candidate,
          prompt,
          worktree: checkout.path,
          model: options.model,
          evaluator,
          attempt,
        });
      } finally {
        await checkout.remove();
      }
    },
  };
}

async function runSession(input: {
  agent: ReviewAgent;
  request: ReviewRequest;
  candidate: CandidateIdentity;
  prompt: string;
  worktree: string;
  model: string;
  evaluator: ProducerIdentity;
  attempt: number;
}): Promise<ReviewRunResult> {
  let first: ReviewAgentReply;
  try {
    first = await input.agent.run({
      itemId: input.request.item.id,
      worktree: input.worktree,
      prompt: input.prompt,
      readOnly: true,
    });
  } catch (error) {
    return invalid(input.candidate, blankProducer(input.model), messageOf(error));
  }
  const firstParsed = parseFindings(first.text);
  if (firstParsed.ok) {
    return recorded(input, producerOf(first, input.model), firstParsed.findings);
  }
  let second: ReviewAgentReply;
  try {
    second = await input.agent.run({
      itemId: input.request.item.id,
      worktree: input.worktree,
      prompt: reaskPrompt(firstParsed.reason),
      readOnly: true,
      ...(first.sessionId ? { sessionId: first.sessionId } : {}),
    });
  } catch (error) {
    return invalid(input.candidate, producerOf(first, input.model), messageOf(error));
  }
  const secondParsed = parseFindings(second.text);
  const producer = producerOf(second, input.model);
  if (!secondParsed.ok) return invalid(input.candidate, producer, secondParsed.reason);
  return recorded(input, producer, secondParsed.findings);
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

function producerOf(reply: ReviewAgentReply, configured: string): ReviewProducer {
  const reported = reply.model?.trim();
  return {
    session: reply.sessionId,
    model: reported ? reported : configured,
    provider: PROVIDER,
  };
}

function blankProducer(model: string): ReviewProducer {
  return { session: "", model, provider: PROVIDER };
}

function passThrough(candidate: CandidateIdentity): CandidateIdentity {
  return {
    ...(candidate.task !== undefined ? { task: candidate.task } : {}),
    session: candidate.session,
    model: candidate.model,
    provider: candidate.provider,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
