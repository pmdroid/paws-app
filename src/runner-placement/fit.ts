import { itemWorkPlacementSteps } from "./session";
import { createRunnerPlacement, PINNED_ELSEWHERE, PlacementUnavailableError } from "./placement";
import {
  bindingAccountHealthSteps,
  getAgentAccountSteps,
  getRunnerSteps,
  runnerHostVersionSteps,
  getWorkItemRepositorySteps,
  latestModelCatalogRowSteps,
  listAgentBindingsSteps,
  modelUnofferedReason,
  runnerAccountUnsupportedSteps,
  runnerRepositoryRefusalSteps,
  type ItemRunnerVerdict,
  type ItemRunnerVerdicts,
  type Db,
  type Q,
  type Steps,
} from "../db";
import {
  REVIEW_COMMAND_OAUTH_RUNNER_VERSION,
  RunnerHealthResultSchema,
  runnerReleaseAtLeast,
  type RunnerCodingAgent,
} from "../runner-protocol";
import {
  bindingReadinessSteps,
  BINDING_REASON_TEXT,
  type BindingUnavailableReason,
} from "./account-health";
import {
  eligibleReasonText,
  eligibleRunnersSteps,
  isInRunnerScope,
  itemOwnerScopeSteps,
} from "./eligible";
import type { EligibleRunner, PlacementAccount, PlacementPurpose } from "./index";

export type AccountRefusal = {
  reason: string;
  code?: BindingUnavailableReason | "account-home" | "model" | "runner-version";
  until?: number;
  account?: string;
  resetsAt?: number | null;
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
  catalog?: boolean;
  homeReported?: boolean;
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

const FIXED_CREDENTIAL_FILES = [".claude/paws-oauth.json", ".paws/api-key.json"];

export function credentialRefreshable(blob: string | null | undefined): boolean {
  try {
    const files = JSON.parse(blob ?? "") as unknown;
    if (!Array.isArray(files) || files.length === 0) return true;
    return !files.some(
      (file) =>
        typeof file === "object" &&
        file !== null &&
        FIXED_CREDENTIAL_FILES.includes((file as { path?: unknown }).path as string),
    );
  } catch {
    return true;
  }
}

export function* runnerModelCatalogSteps(
  q: Q,
  runnerId: string,
  agent: string,
): Steps<{ models: string[]; updatedAt: number } | null> {
  const row = yield* latestModelCatalogRowSteps(q, runnerId, agent);
  if (!row) return null;
  const parsed = RunnerHealthResultSchema.safeParse(JSON.parse(row.resultJson));
  const models = (parsed.success ? (parsed.data.models ?? []) : []).map((entry) => entry.id);
  return { models, updatedAt: row.updatedAt };
}

export function* runnerOffersModelSteps(
  q: Q,
  runnerId: string,
  agent: string,
  model: string,
): Steps<boolean> {
  const catalog = yield* runnerModelCatalogSteps(q, runnerId, agent);
  return catalog?.models.includes(model) ?? false;
}

export const RETRO_ACCOUNT_CHECKS = {
  purpose: "work",
  catalog: false,
  homeReported: true,
} as const satisfies Partial<SignInInput>;

export function* resolveRunnerAccountSteps(
  q: Q,
  runner: SignInRunner,
  workspaceId: string,
  input: SignInInput,
  checks: {
    requiresOAuthSteps?: (q: Q, accountId: string) => Steps<boolean>;
    refreshableSteps?: (q: Q, accountId: string) => Steps<boolean>;
  } = {},
): Steps<AccountFit | AccountRefusal> {
  const { requiresOAuthSteps, refreshableSteps } = checks;
  const bindings = (yield* listAgentBindingsSteps(q, workspaceId)).filter(
    (binding) => binding.runnerId === runner.id && binding.agent === input.agent,
  );
  if (
    bindings.length &&
    input.role !== "reviewer" &&
    input.catalog !== false &&
    input.model &&
    !(yield* runnerOffersModelSteps(q, runner.id, input.agent, input.model))
  )
    return {
      reason: modelUnofferedReason(input.agent, input.model),
      code: "model",
      refusals: [],
    };
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
        code: "runner-version",
      });
      continue;
    }
    const homeless = yield* runnerAccountUnsupportedSteps(q, runner.id, binding.id, input.agent, {
      reported: input.homeReported,
    });
    if (homeless) {
      refusals.push({ reason: homeless, code: "account-home" });
      continue;
    }
    const readiness = yield* bindingReadinessSteps(q, {
      bindingId: binding.id,
      model: input.model,
      now: input.at,
      purpose: input.purpose,
      runnerCapacity: false,
      exceptCommandId: input.exceptCommandId,
      refreshable: refreshableSteps ? yield* refreshableSteps(q, binding.accountId) : true,
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
      code: readiness.reason,
      ...(readiness.until !== null ? { until: readiness.until } : {}),
      ...(readiness.reason === "exhausted"
        ? {
            account: (yield* getAgentAccountSteps(q, workspaceId, binding.accountId)).label,
            resetsAt:
              (yield* bindingAccountHealthSteps(q, binding.id, input.model)).find(
                (row) => row.state === "exhausted",
              )?.resetsAt ?? null,
          }
        : {}),
    });
  }
  const first =
    refusals.find((r) => r.reason === "account at its concurrency limit") ?? refusals[0];
  return { ...(first ?? { reason: "agent not signed in" }), refusals };
}

type SignInChecks = Parameters<typeof resolveRunnerAccountSteps>[4];

function* runnerVerdictsSteps(
  q: Q,
  input: { itemId: string; agent: string; model?: string | null; now: number },
  checks: SignInChecks = {},
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
    const fit = yield* resolveRunnerAccountSteps(
      q,
      runner,
      scope.workspaceId,
      {
        agent: input.agent as RunnerCodingAgent,
        model: input.model,
        purpose: "work",
        at: input.now,
      },
      checks,
    );
    if (!("reason" in fit)) {
      runners.push(verdict(null, null));
      continue;
    }
    const cooling = (fit.refusals ?? [fit])
      .filter((refusal) => refusal.reason === BINDING_REASON_TEXT.exhausted)
      .sort((a, b) => (a.resetsAt ?? Infinity) - (b.resetsAt ?? Infinity))[0];
    runners.push({
      ...verdict(fit.reason, null),
      ...(fit.reason === BINDING_REASON_TEXT.exhausted && cooling
        ? {
            cooldown: {
              account: cooling.account ?? "an agent account",
              until: cooling.resetsAt ?? null,
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
  checks: SignInChecks = {},
): Steps<ItemRunnerVerdicts | null> {
  const found = yield* runnerVerdictsSteps(q, input, checks);
  if (!found) return null;
  const { repository, runners } = found;
  let order: string[];
  const placement = yield* itemWorkPlacementSteps(q, input.itemId, input.agent);
  const pinned = new Set<string>();
  try {
    // A new instance is safe here: session grace is kept per database, so this does not restart it.
    order = (yield* createRunnerPlacement({ store, now: () => input.now, ...checks }).previewSteps!(
      q,
      {
        itemId: input.itemId,
        profile: { agent: input.agent as RunnerCodingAgent, model: input.model },
        role: "implementer",
        purpose: "work",
        ...placement,
        onRejected: (runnerId, reason) => {
          if (reason === PINNED_ELSEWHERE) pinned.add(runnerId);
        },
      },
    )).map((r) => r.id);
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
    model: input.model ?? null,
    runners,
    ...(placement.pinnedRunnerId &&
    order.length &&
    order.every((id) => id === placement.pinnedRunnerId)
      ? { pinnedRunnerId: placement.pinnedRunnerId }
      : {}),
  };
}
