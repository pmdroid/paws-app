import { itemWorkPlacementSteps } from "./session";
import { createRunnerPlacement, PlacementUnavailableError } from "./placement";
import type { Database } from "bun:sqlite";
import {
  getRunnerSteps,
  getWorkItemRepositorySteps,
  legacyAgentAccountId,
  legacyAgentBindingId,
  legacyBindingAccountHealthSteps,
  runnerRepositoryRefusalSteps,
  settled,
  sqliteDb,
  type ItemRunnerVerdict,
  type ItemRunnerVerdicts,
  type Q,
  type Steps,
} from "../db";
import type { RunnerCodingAgent } from "../runner-protocol";
import { accountHealthBlockSteps, BINDING_REASON_TEXT } from "./account-health";
import { eligibleRunnersSteps, isInRunnerScope, itemOwnerScopeSteps } from "./eligible";
import type { EligibleRunner, PlacementAccount, PlacementPurpose } from "./index";

type AccountRefusal = { reason: string; until?: number };
type AccountFit = { account: PlacementAccount; low: boolean };
type SignInRunner = Pick<EligibleRunner, "id" | "cooldownUntil" | "quotaState"> & {
  signedIn: boolean;
};
type SignInInput = {
  agent: RunnerCodingAgent;
  model: string | null | undefined;
  purpose: PlacementPurpose;
  at: number;
};

export function* repositoryRejectionSteps(
  q: Q,
  runnerId: string,
  repository: string,
): Steps<string | null> {
  const refusal = yield* runnerRepositoryRefusalSteps(q, runnerId, repository);
  if (!refusal) return null;
  return refusal.list === "admin"
    ? "repository not allowed on the runner's page"
    : "repository not allowed in the runner's host config";
}

export function* signInFitSteps(
  q: Q,
  runner: SignInRunner,
  workspaceId: string,
  input: SignInInput,
): Steps<AccountFit | AccountRefusal> {
  const { agent, at, purpose } = input;
  if (!runner.signedIn) return { reason: "agent not signed in" };
  if (runner.cooldownUntil > at)
    return { reason: "agent quota cooldown", until: runner.cooldownUntil };
  const bindingId = legacyAgentBindingId(runner.id, agent);
  const health = yield* accountHealthBlockSteps(
    q,
    bindingId,
    (yield* legacyBindingAccountHealthSteps(q, runner.id, agent, input.model)).filter(
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

function* runnerVerdictsSteps(
  q: Q,
  input: { itemId: string; agent: string; model?: string | null; now: number },
) {
  const scope = yield* itemOwnerScopeSteps(q, input.itemId);
  if (!scope) return null;
  const binding = yield* getWorkItemRepositorySteps(q, input.itemId);
  const repository = binding ? `${binding.owner}/${binding.repo}` : null;
  const runners: ItemRunnerVerdict[] = [];
  for (const runner of yield* eligibleRunnersSteps(q, {
    ...scope,
    agent: input.agent,
    purpose: "work",
    now: input.now,
  })) {
    if (!isInRunnerScope(runner.reason)) continue;
    const name = (yield* getRunnerSteps(q, runner.id))?.name ?? runner.id;
    const verdict = (rejection: string | null, hostConfig: ItemRunnerVerdict["hostConfig"]) => ({
      id: runner.id,
      name,
      rejection,
      hostConfig,
    });
    if (!runner.eligible) {
      runners.push(
        verdict(
          runner.reason,
          runner.reason === "agent-not-signed-in" || runner.reason === "auth-expired"
            ? "sign-in"
            : null,
        ),
      );
      continue;
    }
    const refused = repository && (yield* repositoryRejectionSteps(q, runner.id, repository));
    if (refused) {
      runners.push(
        verdict(
          refused,
          (yield* runnerRepositoryRefusalSteps(q, runner.id, repository!))?.list === "host"
            ? "repository"
            : null,
        ),
      );
      continue;
    }
    const fit = yield* signInFitSteps(q, { ...runner, signedIn: true }, scope.workspaceId, {
      agent: input.agent as RunnerCodingAgent,
      model: input.model,
      purpose: "work",
      at: input.now,
    });
    runners.push(verdict("reason" in fit ? fit.reason : null, null));
  }
  return { repository, runners };
}

export function itemRunnerVerdicts(
  db: Database,
  input: { itemId: string; agent: string; model?: string | null; now: number },
): ItemRunnerVerdicts | null {
  return settled(sqliteDb(db).run((q) => itemRunnerVerdictsSteps(q, db, input)));
}

export function* itemRunnerVerdictsSteps(
  q: Q,
  db: Database,
  input: { itemId: string; agent: string; model?: string | null; now: number },
): Steps<ItemRunnerVerdicts | null> {
  const found = yield* runnerVerdictsSteps(q, input);
  if (!found) return null;
  const { repository, runners } = found;
  let order: string[];
  try {
    // A new instance is safe here: session grace is kept per database, so this does not restart it.
    order = (yield* createRunnerPlacement({ db, now: () => input.now }).previewSteps!(q, {
      itemId: input.itemId,
      profile: { agent: input.agent as RunnerCodingAgent, model: input.model },
      role: "implementer",
      purpose: "work",
      ...(yield* itemWorkPlacementSteps(q, input.itemId, input.agent)),
    })).map((r) => r.id);
  } catch (error) {
    if (error instanceof PlacementUnavailableError) return null;
    throw error;
  }
  for (const runner of runners)
    if (runner.rejection === null && !order.includes(runner.id))
      runner.rejection = "not available for this placement";
  runners.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  return {
    repository,
    agent: input.agent,
    runners,
  };
}
