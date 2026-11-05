import type { Database } from "bun:sqlite";
import { type RunnerRepositoryRefusal } from "../core";
import { applyLinearCommand, getWorkItem } from "../db";
import type { StoredQuestion } from "../questions";
import { restart } from "./operations";

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

export function answerRunnerRepository(
  db: Database,
  question: StoredQuestion,
  now: number,
  consumeTurn: (question: StoredQuestion) => void,
): void {
  consumeTurn(question);
  const item = getWorkItem(db, question.itemId);
  if (item?.state !== "awaiting_input" || item.cancelRequested) return;
  if (/^\s*stop\b/i.test(question.answer ?? "")) {
    applyLinearCommand(db, {
      type: "cancel",
      itemId: item.id,
      source: "linear",
      requestedAt: now,
    });
    return;
  }
  restart(db, item, {
    reason: "follow_up",
    body: "Retry runner placement.",
    jobKey: `runner-repository:${question.id}`,
    now,
  });
}
