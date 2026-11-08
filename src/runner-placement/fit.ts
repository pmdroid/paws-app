import type { Database } from "bun:sqlite";
import {
  getRunner,
  getWorkItemRepository,
  legacyAgentAccountId,
  legacyAgentBindingId,
  legacyBindingAccountHealth,
  runnerRepositoryRefusal,
  type ItemRunnerVerdict,
  type ItemRunnerVerdicts,
} from "../db";
import type { RunnerCodingAgent } from "../runner-protocol";
import { accountHealthBlock, BINDING_REASON_TEXT } from "./account-health";
import {
  eligibleRunners,
  isInRunnerScope,
  itemOwnerScope,
  itemRepositoryRefusals,
} from "./eligible";
import type { EligibleRunner, PlacementAccount, PlacementPurpose } from "./index";

type AccountRefusal = { reason: string; until?: number };
type AccountFit = { account: PlacementAccount; low: boolean };

export function repositoryRejection(
  db: Database,
  runnerId: string,
  repository: string,
): string | null {
  const refusal = runnerRepositoryRefusal(db, runnerId, repository);
  if (!refusal) return null;
  return refusal.list === "admin"
    ? "repository not allowed on the runner's page"
    : "repository not allowed in the runner's host config";
}

export function signInFit(
  db: Database,
  runner: Pick<EligibleRunner, "id" | "cooldownUntil" | "quotaState"> & { signedIn: boolean },
  workspaceId: string,
  input: {
    agent: RunnerCodingAgent;
    model: string | null | undefined;
    purpose: PlacementPurpose;
    at: number;
  },
): AccountFit | AccountRefusal {
  const { agent, at, purpose } = input;
  if (!runner.signedIn) return { reason: "agent not signed in" };
  if (runner.cooldownUntil > at)
    return { reason: "agent quota cooldown", until: runner.cooldownUntil };
  const bindingId = legacyAgentBindingId(runner.id, agent);
  const health = accountHealthBlock(
    db,
    bindingId,
    legacyBindingAccountHealth(db, runner.id, agent, input.model).filter(
      (row) => row.kind !== "quota" && row.kind !== "auth",
    ),
    at,
    purpose,
  );
  if (health)
    return {
      reason: BINDING_REASON_TEXT[health.reason],
      ...(health.until !== null ? { until: health.until } : {}),
    };
  return {
    account: { accountId: legacyAgentAccountId(workspaceId, agent), bindingId, named: false },
    low: runner.quotaState === "low",
  };
}

export function itemRunnerVerdicts(
  db: Database,
  input: { itemId: string; agent: string; model?: string | null; now: number },
): ItemRunnerVerdicts | null {
  const scope = itemOwnerScope(db, input.itemId);
  if (!scope) return null;
  const binding = getWorkItemRepository(db, input.itemId);
  const repository = binding ? `${binding.owner}/${binding.repo}` : null;
  const runners = eligibleRunners(db, {
    ...scope,
    agent: input.agent,
    purpose: "work",
    now: input.now,
  })
    .filter((runner) => isInRunnerScope(runner.reason))
    .map((runner): ItemRunnerVerdict => {
      const verdict = (rejection: string | null, hostConfig: ItemRunnerVerdict["hostConfig"]) => ({
        id: runner.id,
        name: getRunner(db, runner.id)?.name ?? runner.id,
        rejection,
        hostConfig,
      });
      if (!runner.eligible)
        return verdict(
          runner.reason,
          runner.reason === "agent-not-signed-in" || runner.reason === "auth-expired"
            ? "sign-in"
            : null,
        );
      const refused = repository && repositoryRejection(db, runner.id, repository);
      if (refused) return verdict(refused, "repository");
      const fit = signInFit(db, { ...runner, signedIn: true }, scope.workspaceId, {
        agent: input.agent as RunnerCodingAgent,
        model: input.model,
        purpose: "work",
        at: input.now,
      });
      return verdict("reason" in fit ? fit.reason : null, null);
    });
  return {
    repository,
    agent: input.agent,
    runners,
    refusedEverywhere:
      itemRepositoryRefusals(db, { itemId: input.itemId, now: input.now }) !== null,
  };
}
