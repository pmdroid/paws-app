import { type RunnerRepositoryRefusal } from "../core";
import { applyLinearCommandSteps, getWorkItemSteps, type Q, type Steps } from "../db";
import type { StoredQuestion } from "../questions";
import { restartSteps } from "./operations";

export const RUNNER_REPOSITORY_RETRY = "Retry";
export const RUNNER_REPOSITORY_STOP = "Stop";
export const RUNNER_REPOSITORY_REASON = "repository_not_allowed";
export const RUNNER_HOST_CONFIG = "/etc/paws-runner/config.json";

export function runnerRepositoryQuestion(
  repository: string,
  refusals: readonly RunnerRepositoryRefusal[],
  runnersUrl: string,
): string {
  const lines = refusals.map((refusal) => {
    const allows = refusal.allowed.length
      ? `allows only ${refusal.allowed.join(", ")}`
      : "allows no repository";
    const page = `${runnersUrl.replace(/\/$/, "")}/${encodeURIComponent(refusal.runnerId)}`;
    return refusal.code === "repository_host"
      ? `${refusal.runnerName} ${allows} in its host config (\`${RUNNER_HOST_CONFIG}\`, \`allowedRepositories\`). Add ${repository} there and restart \`paws-runner.service\`, or allow it on the [runner's page](${page}) in Paws.`
      : `${refusal.runnerName} ${allows} on its [runner's page](${page}) in Paws. Allow ${repository} there.`;
  });
  return [
    `No runner can run ${repository}.`,
    ...lines,
    `Then reply **${RUNNER_REPOSITORY_RETRY}**, or **${RUNNER_REPOSITORY_STOP}** to cancel.`,
  ].join("\n\n");
}

export function* answerRunnerRepositorySteps(
  q: Q,
  question: StoredQuestion,
  now: number,
  self: string | undefined,
  notifications: { ready: boolean },
): Steps<void> {
  const item = yield* getWorkItemSteps(q, question.itemId);
  if (item?.state !== "awaiting_input" || item.cancelRequested) return;
  if (/^\s*stop\b/i.test(question.answer ?? "")) {
    yield* applyLinearCommandSteps(
      q,
      { type: "cancel", itemId: item.id, source: "linear", requestedAt: now },
      now,
      undefined,
      {},
      self,
      notifications,
    );
    return;
  }
  const restarted = yield* restartSteps(q, item, {
    reason: "follow_up",
    body: "Retry runner placement.",
    jobKey: `runner-repository:${question.id}`,
    now,
  });
  if (restarted?.armed) notifications.ready = true;
}
