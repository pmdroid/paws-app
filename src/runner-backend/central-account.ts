import { RunnerCapacityWait } from "../core";
import type { Db } from "../db";
import type { RunnerCodingAgent } from "../runner-protocol";
import { leaseCentralAccountSteps, type PlacementReason } from "../runner-placement";
import { USAGE_LIMIT_RESUME_SLACK_MS, USAGE_LIMIT_RETRY_MS, UsageLimitPause } from "./failover";

export async function leaseCentralAccount(
  store: Db,
  input: {
    workspaceId: string;
    agent: RunnerCodingAgent;
    runnerId: string;
    runId: string;
    until: number;
    now: number;
  },
): Promise<{ accountId: string; reason: PlacementReason | null } | null> {
  const choice = await store.transaction((q) => leaseCentralAccountSteps(q, input));
  if (choice.kind === "none") return null;
  if (choice.kind === "leased") return { accountId: choice.accountId, reason: choice.reason };
  if (choice.kind === "busy")
    throw new RunnerCapacityWait(
      [],
      undefined,
      choice.accountIds.map((id) => `${id}: agent account in use`),
    );
  throw new UsageLimitPause(
    input.agent,
    choice.resetsAt === null
      ? input.now + USAGE_LIMIT_RETRY_MS
      : choice.resetsAt + USAGE_LIMIT_RESUME_SLACK_MS,
    choice.resetsAt,
    null,
  );
}
