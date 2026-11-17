import {
  accountSlotsInUseSteps,
  centralAgentAccountsSteps,
  takeAgentAccountLeaseSteps,
  type CentralAgentAccount,
  type Q,
  type Steps,
} from "../db";
import type { RunnerCodingAgent } from "../runner-protocol";
import type { PlacementReason } from "./index";

export type CentralAccountChoice =
  | { kind: "leased"; accountId: string; reason: PlacementReason | null }
  | { kind: "busy"; accountIds: string[] }
  | { kind: "paused"; resetsAt: number | null }
  | { kind: "none" };

function pausedUntil(account: CentralAgentAccount, now: number): number | null | undefined {
  const spent = account.limits.filter(
    (limit) => limit.usedPercent >= 100 && (limit.resetsAt === null || limit.resetsAt > now),
  );
  if (spent.length === 0) return undefined;
  if (spent.some((limit) => limit.resetsAt === null)) return null;
  return Math.max(...spent.map((limit) => limit.resetsAt!));
}

export function* leaseCentralAccountSteps(
  q: Q,
  input: {
    workspaceId: string;
    agent: RunnerCodingAgent;
    runnerId: string;
    runId: string;
    until: number;
    now: number;
  },
): Steps<CentralAccountChoice> {
  const accounts = yield* centralAgentAccountsSteps(q, input.workspaceId, input.agent);
  if (accounts.length === 0) return { kind: "none" };
  const pauses = new Map(accounts.map((account) => [account.id, pausedUntil(account, input.now)]));
  const free = accounts.filter((account) => pauses.get(account.id) === undefined);
  const extra = free.length === 0;
  const busy: string[] = [];
  for (const account of extra ? accounts.filter((entry) => entry.extraUsage) : free) {
    if (
      account.concurrency !== null &&
      (yield* accountSlotsInUseSteps(q, account.id, input.now)) >= account.concurrency
    ) {
      busy.push(account.id);
      continue;
    }
    if (yield* takeAgentAccountLeaseSteps(q, { ...input, accountId: account.id }))
      return { kind: "leased", accountId: account.id, reason: extra ? "extra_usage" : null };
    busy.push(account.id);
  }
  if (busy.length > 0) return { kind: "busy", accountIds: busy };
  const resets = [...pauses.values()].filter((value) => typeof value === "number");
  return { kind: "paused", resetsAt: resets.length > 0 ? Math.min(...resets) : null };
}
