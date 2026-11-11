import type { Database } from "bun:sqlite";
import { type RunnerRepositoryRefusal } from "../core";
import {
  applyLinearCommandSteps,
  commandInstance,
  emitJobReady,
  getWorkItemSteps,
  settled,
  sqliteDb,
  syncSteps,
  type Q,
  type Steps,
} from "../db";
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

export function answerRunnerRepository(
  db: Database,
  question: StoredQuestion,
  now: number,
  consumeTurn: (question: StoredQuestion) => void,
): void {
  const notifications = { ready: false };
  settled(
    sqliteDb(db).transaction((q) =>
      answerRunnerRepositorySteps(q, question, {
        now,
        self: commandInstance(db),
        consumeTurn: (_q, asked) => syncSteps(() => consumeTurn(asked)),
        notifications,
      }),
    ),
  );
  if (notifications.ready) emitJobReady(db);
}

function* answerRunnerRepositorySteps(
  q: Q,
  question: StoredQuestion,
  input: {
    now: number;
    self: string | undefined;
    consumeTurn: (q: Q, question: StoredQuestion) => Steps<void>;
    notifications: { ready: boolean };
  },
): Steps<void> {
  const { now, notifications } = input;
  yield* input.consumeTurn(q, question);
  const item = yield* getWorkItemSteps(q, question.itemId);
  if (item?.state !== "awaiting_input" || item.cancelRequested) return;
  if (/^\s*stop\b/i.test(question.answer ?? "")) {
    yield* applyLinearCommandSteps(
      q,
      { type: "cancel", itemId: item.id, source: "linear", requestedAt: now },
      now,
      undefined,
      {},
      input.self,
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
  notifications.ready ||= restarted?.armed === true;
}
