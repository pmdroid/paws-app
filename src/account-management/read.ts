import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  accountSlotsInUse,
  admitAgentAccounts,
  agentAccountConcurrency,
  bindingAccountHealth,
  legacyAgentAccountId,
  listAgentAccounts,
  listAgentBindings,
  runnerAccountUnsupported,
  runnerAllowsRepository,
  type AgentAccount,
  type AgentAccountBinding,
  type AgentAccountErrorCode,
} from "../db";
import {
  BINDING_REASON_TEXT,
  bindingReadiness,
  type BindingUnavailableReason,
} from "../runner-placement";
import {
  RUNNER_CODING_AGENTS,
  runnerAccountAgentUnsupported,
  type RunnerCodingAgent,
} from "../runner-protocol";
import type { AgentProfiles, AccountPolicy } from "../config";

export const AGENT_NAMES: Record<RunnerCodingAgent, string> = {
  claude: "Claude",
  codex: "Codex",
  grok: "Grok",
  opencode: "OpenCode",
};

export type ReadinessState =
  | "eligible"
  | "waiting"
  | "auth-required"
  | "cooling-down"
  | "unavailable";

export type Readiness = {
  state: ReadinessState;
  reason: BindingUnavailableReason | "unsupported" | "not-signed-in" | null;
  detail: string;
  until: number | null;
  resetUnknown: boolean;
  low: boolean;
};

export type AccountBindingView = {
  id: string;
  runnerId: string;
  runnerName: string;
  ownedByYou: boolean;
  legacy: boolean;
  quotaScope: "account" | "unknown";
  readiness: Readiness;
};

export type AgentAccountView = {
  id: string;
  agent: RunnerCodingAgent;
  label: string;
  legacy: boolean;
  enabled: boolean;
  concurrency: number | null;
  running: number;
  sharedLimit: boolean;
  bindings: AccountBindingView[];
};

export type AgentAccountsList = {
  revision: string;
  canManage: boolean;
  agents: { agent: RunnerCodingAgent; name: string; unsupported: string | null }[];
  runners: { id: string; name: string; ownedByYou: boolean }[];
  accounts: AgentAccountView[];
};

const SKIPPED_TEXT: Record<AgentAccountErrorCode, string> = {
  not_found: "account is unknown",
  foreign_workspace: "account belongs to another workspace",
  duplicate: "account is listed twice",
  invalid: "account is invalid",
  removed: "account was removed",
  disabled: "account is disabled",
  legacy: "default sign-in",
  binding_mismatch: "account signs in another agent",
  runner_unsupported: "runner cannot run named accounts",
};

const GROUPS: Record<BindingUnavailableReason, ReadinessState> = {
  revoked: "unavailable",
  removed: "unavailable",
  disabled: "unavailable",
  offline: "waiting",
  paused: "waiting",
  busy: "waiting",
  "auth-required": "auth-required",
  exhausted: "cooling-down",
  "provider-restricted": "cooling-down",
  "unsupported-model": "cooling-down",
};

export function accountsRevision(db: Database, workspaceId: string): string {
  const accounts = db
    .query<Record<string, unknown>, [string]>(
      "SELECT id,label,enabled,concurrency,removed_at,updated_at FROM agent_account WHERE workspace_id=? ORDER BY id",
    )
    .all(workspaceId);
  const bindings = db
    .query<Record<string, unknown>, [string]>(
      "SELECT id,account_id,runner_id,removed_at FROM agent_account_binding WHERE workspace_id=? AND legacy=0 ORDER BY id",
    )
    .all(workspaceId);
  return createHash("sha256")
    .update(JSON.stringify([accounts, bindings]))
    .digest("hex")
    .slice(0, 24);
}

export function bindingView(
  db: Database,
  binding: AgentAccountBinding,
  runner: { name: string; ownerUserId: string },
  input: { userId: string; model?: string | null; repository?: string | null; now: number },
): AccountBindingView {
  return {
    id: binding.id,
    runnerId: binding.runnerId,
    runnerName: runner.name,
    ownedByYou: runner.ownerUserId === input.userId,
    legacy: binding.legacy,
    quotaScope: binding.quotaScope,
    readiness: readiness(db, binding, input),
  };
}

function readiness(
  db: Database,
  binding: AgentAccountBinding,
  input: { model?: string | null; repository?: string | null; now: number },
): Readiness {
  const make = (
    state: ReadinessState,
    reason: Readiness["reason"],
    detail: string,
    until: number | null = null,
    extra: Partial<Readiness> = {},
  ): Readiness => ({ state, reason, detail, until, resetUnknown: false, low: false, ...extra });
  const ready = bindingReadiness(db, {
    bindingId: binding.id,
    model: input.model ?? null,
    now: input.now,
  });
  const fixed = !ready.ready && GROUPS[ready.reason] === "unavailable";
  if (fixed) return make("unavailable", ready.reason, sentence(BINDING_REASON_TEXT[ready.reason]));
  if (!binding.legacy) {
    const unsupported = runnerAccountUnsupported(db, binding.runnerId, binding.id, binding.agent);
    if (unsupported?.includes("not reported this account binding"))
      return make("auth-required", "not-signed-in", "Sign in to this account on the runner.");
    if (unsupported) return make("unavailable", "unsupported", sentence(unsupported));
  } else {
    const policy = db
      .query<{ ready: number; cooldownUntil: number }, [string, string]>(
        "SELECT ready,cooldown_until AS cooldownUntil FROM runner_agent_policy WHERE runner_id=? AND agent=?",
      )
      .get(binding.runnerId, binding.agent);
    if (!policy || policy.ready !== 1)
      return make("auth-required", "not-signed-in", "Sign in to the agent on the runner.");
    if (policy.cooldownUntil > input.now)
      return make(
        "cooling-down",
        "exhausted",
        "The runner's default sign-in is in a usage-limit cooldown.",
        policy.cooldownUntil,
      );
  }
  if (input.repository && !runnerAllowsRepository(db, binding.runnerId, input.repository))
    return make("unavailable", null, "The runner does not allow this repository.");
  if (ready.ready)
    return make(
      "eligible",
      null,
      ready.revalidating
        ? "Eligible: the next attempt rechecks its last limit."
        : ready.low
          ? "Eligible, with little usage left."
          : "Eligible.",
      null,
      { low: ready.low },
    );
  const state = GROUPS[ready.reason];
  const quota = bindingAccountHealth(db, binding.id, input.model).find(
    (row) => row.kind === "quota" && row.state === "exhausted",
  );
  const resetUnknown = ready.reason === "exhausted" && (quota ? quota.resetsAt === null : true);
  return make(state, ready.reason, sentence(BINDING_REASON_TEXT[ready.reason]), ready.until, {
    resetUnknown,
  });
}

function sentence(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}${text.endsWith(".") ? "" : "."}`;
}

type RunnerRow = { id: string; name: string; ownerUserId: string; revoked: number };

function runnerRows(db: Database, workspaceId: string): Map<string, RunnerRow> {
  return new Map(
    db
      .query<RunnerRow, [string]>(
        "SELECT id,name,owner_user_id AS ownerUserId,(revoked_at IS NOT NULL OR status='revoked') AS revoked FROM runner WHERE workspace_id=? ORDER BY name,id",
      )
      .all(workspaceId)
      .map((row) => [row.id, row]),
  );
}

function accountView(
  db: Database,
  account: AgentAccount,
  bindings: readonly AgentAccountBinding[],
  runners: Map<string, RunnerRow>,
  input: { userId: string; model?: string | null; repository?: string | null; now: number },
): AgentAccountView {
  const live = bindings.filter(
    (binding) =>
      binding.accountId === account.id &&
      binding.removedAt === null &&
      runners.get(binding.runnerId)?.revoked === 0,
  );
  return {
    id: account.id,
    agent: account.agent,
    label: account.label,
    legacy: account.legacy,
    enabled: account.enabled,
    concurrency: agentAccountConcurrency(db, account.id),
    running: accountSlotsInUse(db, account.id, input.now),
    sharedLimit: !account.legacy && live.length > 1,
    bindings: live.map((binding) =>
      bindingView(db, binding, runners.get(binding.runnerId)!, input),
    ),
  };
}

export function listAccounts(
  db: Database,
  input: { workspaceId: string; userId: string; canManage: boolean; now: number },
): AgentAccountsList {
  const runners = runnerRows(db, input.workspaceId);
  const bindings = listAgentBindings(db, input.workspaceId);
  const accounts = listAgentAccounts(db, input.workspaceId).filter(
    (account) => account.removedAt === null,
  );
  return {
    revision: accountsRevision(db, input.workspaceId),
    canManage: input.canManage,
    agents: RUNNER_CODING_AGENTS.map((agent) => ({
      agent,
      name: AGENT_NAMES[agent],
      unsupported: runnerAccountAgentUnsupported(agent),
    })),
    runners: [...runners.values()]
      .filter((runner) => runner.revoked === 0)
      .map((runner) => ({
        id: runner.id,
        name: runner.name,
        ownedByYou: runner.ownerUserId === input.userId,
      })),
    accounts: accounts.map((account) => accountView(db, account, bindings, runners, input)),
  };
}

export type PreviewRole = "implementer" | "reviewer" | "reviewerFallback";

export type EligibilityPreview = {
  role: PreviewRole;
  repository: string | null;
  agent: RunnerCodingAgent;
  model: string | null;
  policyRevision: string | null;
  source: "project" | "defaults" | "default";
  accounts: {
    id: string;
    label: string;
    position: number;
    skipped: string | null;
    sharedLimit: boolean;
    bindings: AccountBindingView[];
  }[];
  choice: {
    accountId: string;
    label: string;
    bindingId: string;
    runnerId: string;
    runnerName: string;
    position: number;
    fallback: string | null;
  } | null;
  waiting: string | null;
};

export function previewEligibility(
  db: Database,
  input: {
    workspaceId: string;
    userId: string;
    role: PreviewRole;
    repository: string | null;
    profiles: AgentProfiles;
    policy: AccountPolicy | null;
    now: number;
  },
): EligibilityPreview | null {
  const profile = input.profiles[input.role];
  if (!profile) return null;
  const agent = profile.agent as RunnerCodingAgent;
  const rolePolicy = input.policy?.[input.role];
  const admission = admitAgentAccounts(
    db,
    input.workspaceId,
    agent,
    rolePolicy ? { agent: rolePolicy.agent, accounts: rolePolicy.accounts } : undefined,
  );
  const runners = runnerRows(db, input.workspaceId);
  const bindings = listAgentBindings(db, input.workspaceId);
  const all = new Map(listAgentAccounts(db, input.workspaceId).map((row) => [row.id, row]));
  const legacyId = legacyAgentAccountId(input.workspaceId, agent);
  const ids = rolePolicy?.accounts ?? [legacyId];
  const read = {
    userId: input.userId,
    model: profile.model,
    repository: input.repository,
    now: input.now,
  };
  const accounts = ids.map((id, index) => {
    const skipped = admission.skipped.find((entry) => entry.accountId === id);
    const row = all.get(id);
    const view = row ? accountView(db, row, bindings, runners, read) : null;
    return {
      id,
      label: row?.label ?? (id === legacyId ? `${AGENT_NAMES[agent]} default sign-in` : id),
      position: index + 1,
      skipped: skipped ? SKIPPED_TEXT[skipped.reason] : null,
      sharedLimit: view?.sharedLimit ?? false,
      bindings: skipped ? [] : (view?.bindings ?? []),
    };
  });
  const passed: string[] = [];
  let choice: EligibilityPreview["choice"] = null;
  for (const account of accounts) {
    if (account.skipped) {
      passed.push(`${account.label}: ${account.skipped}`);
      continue;
    }
    const binding = account.bindings.find((entry) => entry.readiness.state === "eligible");
    if (binding) {
      choice = {
        accountId: account.id,
        label: account.label,
        bindingId: binding.id,
        runnerId: binding.runnerId,
        runnerName: binding.runnerName,
        position: account.position,
        fallback: passed.length ? passed.join("; ") : null,
      };
      break;
    }
    passed.push(`${account.label}: ${accountWaitReason(account.bindings)}`);
  }
  return {
    role: input.role,
    repository: input.repository,
    agent,
    model: profile.model,
    policyRevision: rolePolicy ? (input.policy?.revision ?? null) : null,
    source: rolePolicy?.source ?? "default",
    accounts,
    choice,
    waiting: choice
      ? null
      : `No account in the order can run now, so new work waits. ${passed.join("; ")}.`,
  };
}

function accountWaitReason(bindings: readonly AccountBindingView[]): string {
  if (bindings.length === 0) return "no runner is linked";
  const order: ReadinessState[] = ["waiting", "cooling-down", "auth-required", "unavailable"];
  const best = order
    .map((state) => bindings.find((binding) => binding.readiness.state === state))
    .find((binding) => binding !== undefined)!;
  const detail = best.readiness.detail.replace(/\.$/, "").toLowerCase();
  return best.readiness.resetUnknown ? `${detail}, reset unknown` : detail;
}
