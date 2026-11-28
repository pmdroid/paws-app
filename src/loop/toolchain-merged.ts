import {
  getWorkItemRepositorySteps,
  getWorkItemSteps,
  listOpenQuestionsSteps,
  type Db,
  type Q,
  type Steps,
} from "../db";
import { journal } from "../journal";
import { answerSteps } from "../questions";
import { parseToolchainQuestion } from "../runner-protocol";
import { questionEffects } from "./question-effects";
import { TOOLCHAIN_BRANCH } from "./toolchain-pull";

export const TOOLCHAIN_MERGED_REASON = "toolchain_merged";

type ToolchainMerge = { owner: string; repo: string; mergedAt: number | null };

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function toolchainMerge(event: string, body: unknown): ToolchainMerge | null {
  const payload = record(body);
  const repository = record(payload.repository);
  const pull = record(payload.pull_request);
  const head = record(pull.head);
  const base = record(pull.base);
  const name = repository.full_name;
  if (
    event !== "pull_request" ||
    payload.action !== "closed" ||
    pull.merged !== true ||
    typeof name !== "string" ||
    head.ref !== TOOLCHAIN_BRANCH ||
    record(head.repo).full_name !== name ||
    base.ref !== (repository.default_branch ?? "main") ||
    record(base.repo).full_name !== name
  )
    return null;
  const [owner, repo] = name.split("/");
  if (!owner || !repo) return null;
  const mergedAt = typeof pull.merged_at === "string" ? Date.parse(pull.merged_at) : NaN;
  return { owner, repo, mergedAt: Number.isNaN(mergedAt) ? null : mergedAt };
}

export function* resumeToolchainWaitsSteps(
  q: Q,
  store: Db,
  merge: ToolchainMerge,
  deliveryId: string,
  now: number,
): Steps<string[]> {
  const before = merge.mergedAt ?? now;
  const effects = questionEffects(store, { now });
  const resumed: string[] = [];
  for (const open of yield* listOpenQuestionsSteps(q)) {
    if (open.createdAt >= before || parseToolchainQuestion(open.body) === null) continue;
    if ((yield* getWorkItemSteps(q, open.itemId))?.state !== "awaiting_input") continue;
    const repository = yield* getWorkItemRepositorySteps(q, open.itemId);
    if (repository?.owner !== merge.owner || repository.repo !== merge.repo) continue;
    const answered = yield* answerSteps(
      q,
      {
        sessionId: open.sessionId,
        deliveryId: `${TOOLCHAIN_MERGED_REASON}:${deliveryId}`,
        body: "retry",
        answeredBy: "Paws",
        now,
      },
      effects,
    );
    if (answered.status === "answered" && answered.question.id === open.id)
      resumed.push(open.itemId);
  }
  if (resumed.length > 0)
    journal(
      `${TOOLCHAIN_BRANCH} merged in ${merge.owner}/${merge.repo}: answered retry reason=${TOOLCHAIN_MERGED_REASON} items=${resumed.join(",")}`,
    );
  return resumed;
}
