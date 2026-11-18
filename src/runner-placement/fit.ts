import { itemWorkPlacementSteps } from "./session";
import { createRunnerPlacement, PINNED_ELSEWHERE, PlacementUnavailableError } from "./placement";
import {
  getAgentAccountSteps,
  getRunnerSteps,
  runnerHostVersionSteps,
  getWorkItemRepositorySteps,
  listAgentBindingsSteps,
  runnerRepositoryRefusalSteps,
  type ItemRunnerVerdict,
  type ItemRunnerVerdicts,
  type Db,
  type Q,
  type Steps,
} from "../db";
import {
  REVIEW_COMMAND_OAUTH_RUNNER_VERSION,
  runnerReleaseAtLeast,
  type RunnerCodingAgent,
} from "../runner-protocol";
import { bindingReadinessSteps, BINDING_REASON_TEXT } from "./account-health";
import {
  eligibleReasonText,
  eligibleRunnersSteps,
  isInRunnerScope,
  itemOwnerScopeSteps,
} from "./eligible";
import type { EligibleRunner, PlacementAccount, PlacementPurpose } from "./index";

type AccountRefusal = {
  reason: string;
  until?: number;
  account?: string;
  refusals?: AccountRefusal[];
};
type AccountFit = { account: PlacementAccount; low: boolean };
type SignInRunner = Pick<EligibleRunner, "id">;
type SignInInput = {
  agent: RunnerCodingAgent;
  model: string | null | undefined;
  purpose: PlacementPurpose;
  at: number;
  exceptCommandId?: string;
  excludeBindingIds?: readonly string[];
  bindingId?: string;
  role?: "implementer" | "reviewer";
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
  requiresOAuthSteps?: (q: Q, accountId: string) => Steps<boolean>,
): Steps<AccountFit | AccountRefusal> {
  const bindings = (yield* listAgentBindingsSteps(q, workspaceId)).filter(
    (binding) => binding.runnerId === runner.id && binding.agent === input.agent,
  );
  const refusals: AccountRefusal[] = [];
  for (const binding of bindings) {
    if (
      input.excludeBindingIds?.includes(binding.id) ||
      (input.bindingId && input.bindingId !== binding.id)
    )
      continue;
    if (
      input.agent === "claude" &&
      input.role === "reviewer" &&
      requiresOAuthSteps &&
      (yield* requiresOAuthSteps(q, binding.accountId)) &&
      !runnerReleaseAtLeast(
        yield* runnerHostVersionSteps(q, runner.id),
        REVIEW_COMMAND_OAUTH_RUNNER_VERSION,
      )
    ) {
      refusals.push({
        reason: `Claude OAuth credentials need runner ${REVIEW_COMMAND_OAUTH_RUNNER_VERSION.join(".")} or later`,
      });
      continue;
    }
    const readiness = yield* bindingReadinessSteps(q, {
      bindingId: binding.id,
      model: input.model,
      now: input.at,
      purpose: input.purpose,
      runnerCapacity: false,
      exceptCommandId: input.exceptCommandId,
    });
    if (readiness.ready)
      return {
        account: { accountId: binding.accountId, bindingId: binding.id, named: true },
        low: readiness.low,
      };
    refusals.push({
      reason:
        readiness.reason === "busy"
          ? "account at its concurrency limit"
          : BINDING_REASON_TEXT[readiness.reason],
      ...(readiness.until !== null ? { until: readiness.until } : {}),
      ...(readiness.reason === "exhausted"
        ? { account: (yield* getAgentAccountSteps(q, workspaceId, binding.accountId)).label }
        : {}),
    });
  }
  const first =
    refusals.find((r) => r.reason === "account at its concurrency limit") ?? refusals[0];
  return { ...(first ?? { reason: "agent not signed in" }), refusals };
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
          eligibleReasonText(runner.reason),
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
    const fit = yield* signInFitSteps(q, runner, scope.workspaceId, {
      agent: input.agent as RunnerCodingAgent,
      model: input.model,
      purpose: "work",
      at: input.now,
    });
    if (!("reason" in fit)) {
      runners.push(verdict(null, null));
      continue;
    }
    const cooling = (fit.refusals ?? [fit])
      .filter((refusal) => refusal.reason === BINDING_REASON_TEXT.exhausted)
      .sort((a, b) => (a.until ?? Infinity) - (b.until ?? Infinity))[0];
    runners.push({
      ...verdict(fit.reason, null),
      ...(fit.reason === BINDING_REASON_TEXT.exhausted && cooling
        ? {
            cooldown: {
              account: cooling.account ?? "an agent account",
              until: cooling.until ?? null,
            },
          }
        : {}),
    });
  }
  return { repository, runners };
}

export function* itemRunnerVerdictsSteps(
  q: Q,
  store: Db,
  input: { itemId: string; agent: string; model?: string | null; now: number },
): Steps<ItemRunnerVerdicts | null> {
  const found = yield* runnerVerdictsSteps(q, input);
  if (!found) return null;
  const { repository, runners } = found;
  let order: string[];
  const placement = yield* itemWorkPlacementSteps(q, input.itemId, input.agent);
  const pinned = new Set<string>();
  try {
    // A new instance is safe here: session grace is kept per database, so this does not restart it.
    order = (yield* createRunnerPlacement({ store, now: () => input.now }).previewSteps!(q, {
      itemId: input.itemId,
      profile: { agent: input.agent as RunnerCodingAgent, model: input.model },
      role: "implementer",
      purpose: "work",
      ...placement,
      onRejected: (runnerId, reason) => {
        if (reason === PINNED_ELSEWHERE) pinned.add(runnerId);
      },
    })).map((r) => r.id);
  } catch (error) {
    if (error instanceof PlacementUnavailableError) return null;
    throw error;
  }
  const pin = placement.pinnedRunnerId
    ? ((yield* getRunnerSteps(q, placement.pinnedRunnerId))?.name ?? placement.pinnedRunnerId)
    : null;
  for (const runner of runners)
    if (runner.rejection === null && !order.includes(runner.id))
      runner.rejection =
        pin && pinned.has(runner.id) ? `run pinned to ${pin}` : "not available for this placement";
  runners.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  return {
    repository,
    agent: input.agent,
    runners,
  };
}
