import {
  enqueueOutboxOnceSteps,
  getItemCandidateSteps,
  linearOutboxKeyedSteps,
  type Q,
  type Steps,
} from "../db";
import { itemForBranchSteps } from "./pull-reviews";

export type OutsidePush = { itemId: string; branch: string; sender: string; running: boolean };

export type OutsidePushDelivery = {
  owner: string;
  repo: string;
  branch: string;
  head: string;
  sender: string;
  bot: boolean;
};

export function outsidePushDelivery(event: string, body: unknown): OutsidePushDelivery | null {
  const payload = record(body);
  if (event !== "pull_request" || payload.action !== "synchronize") return null;
  const repository = record(payload.repository);
  const owner = record(repository.owner).login;
  const repo = repository.name;
  const head = record(record(payload.pull_request).head);
  const headRepository = record(head.repo).full_name;
  const sender = record(payload.sender);
  if (
    typeof owner !== "string" ||
    typeof repo !== "string" ||
    typeof head.ref !== "string" ||
    typeof head.sha !== "string" ||
    typeof sender.login !== "string" ||
    (typeof headRepository === "string" &&
      headRepository.toLowerCase() !== `${owner}/${repo}`.toLowerCase())
  )
    return null;
  return {
    owner,
    repo,
    branch: head.ref,
    head: head.sha,
    sender: sender.login,
    bot: sender.type === "Bot",
  };
}

export function outsidePushFollowUp(push: OutsidePush): string {
  return `${push.sender} pushed commits to ${push.branch} while you work. Before you commit again, run git pull --rebase origin ${push.branch} and keep their changes.`;
}

export function* outsidePushSteps(
  q: Q,
  delivery: OutsidePushDelivery,
  appLogin: string | null,
  now: number,
): Steps<OutsidePush | null> {
  if (delivery.bot && appLogin !== null && delivery.sender.toLowerCase() === appLogin.toLowerCase())
    return null;
  const item = yield* itemForBranchSteps(q, delivery.owner, delivery.repo, delivery.branch);
  if (!item?.sessionKey) return null;
  const candidate = yield* getItemCandidateSteps(q, item.id);
  if (!candidate || candidate.sha === delivery.head) return null;
  const key = `outside-push:${item.id}:${delivery.head}`;
  if (yield* linearOutboxKeyedSteps(q, key)) return null;
  yield* enqueueOutboxOnceSteps(q, {
    target: "linear",
    op: "activity",
    orderingKey: item.sessionKey,
    idempotencyKey: key,
    payload: {
      sessionId: item.sessionKey,
      kind: "thought",
      body: `${delivery.sender} pushed to ${delivery.branch}; Paws keeps these commits.`,
      id: crypto.randomUUID(),
    },
    now,
  });
  return {
    itemId: item.id,
    branch: delivery.branch,
    sender: delivery.sender,
    running: item.state === "running",
  };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
