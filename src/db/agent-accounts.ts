import type { Database } from "bun:sqlite";
import {
  aliasedTable,
  type AnyColumn,
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import {
  AGENT_ACCOUNTS_RUNNER_VERSION,
  LEGACY_ACCOUNT_PREFIX,
  RUNNER_ACCOUNT_PROTOCOL,
  RunnerAccountCapabilitySchema,
  runnerAccountAgentUnsupported,
  runnerReleaseAtLeast,
  type RunnerAccountCapability,
  type RunnerCodingAgent,
  type RunnerCommand,
  type RunnerRetroCommand,
} from "../runner-protocol";
import { settled, sqliteDb, type Q, type Db } from "./db";
import { jsonText, jsonValue } from "./json-text";
import { TEARDOWN_UNRESOLVED } from "./runner-capacity";
import { runnerLeaseCutoff } from "./runner-lease";
import { ulid } from "./ulid";

export type AgentAccount = {
  id: string;
  workspaceId: string;
  agent: RunnerCodingAgent;
  label: string;
  legacy: boolean;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  removedAt: number | null;
};

export type AgentAccountBinding = {
  id: string;
  workspaceId: string;
  accountId: string;
  agent: RunnerCodingAgent;
  runnerId: string;
  legacy: boolean;
  quotaScope: "account" | "unknown";
  createdAt: number;
  removedAt: number | null;
};

type CommandAccount = {
  commandId: string;
  workspaceId: string;
  runnerId: string;
  agent: RunnerCodingAgent;
  accountId: string;
  bindingId: string;
  named: boolean;
  recordedAt: number;
};

type AgentAccountErrorCode =
  | "not_found"
  | "foreign_workspace"
  | "duplicate"
  | "invalid"
  | "removed"
  | "disabled"
  | "legacy"
  | "binding_mismatch"
  | "runner_unsupported";

export class AgentAccountError extends Error {
  override readonly name = "AgentAccountError";
  constructor(
    readonly code: AgentAccountErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const AGENT_NAMES: Record<RunnerCodingAgent, string> = {
  claude: "Claude",
  codex: "Codex",
  grok: "Grok",
  opencode: "OpenCode",
};

const accountColumns = (q: Q) => {
  const a = q.t.agentAccount;
  return {
    id: a.id,
    workspaceId: a.workspaceId,
    agent: a.agent,
    label: a.label,
    legacy: a.legacy,
    enabled: a.enabled,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    removedAt: a.removedAt,
  };
};
const account = (
  row: Omit<Q["t"]["agentAccount"]["$inferSelect"], "concurrency">,
): AgentAccount => ({
  ...row,
  agent: row.agent as RunnerCodingAgent,
  legacy: row.legacy === 1,
  enabled: row.enabled === 1,
});
const binding = (row: Q["t"]["agentAccountBinding"]["$inferSelect"]): AgentAccountBinding => ({
  ...row,
  agent: row.agent as RunnerCodingAgent,
  legacy: row.legacy === 1,
  quotaScope: row.quotaScope as AgentAccountBinding["quotaScope"],
});

const added = (q: Q, id: AnyColumn) => (q.dialect === "sqlite" ? sql`rowid` : asc(id));

export function legacyAgentAccountId(workspaceId: string, agent: RunnerCodingAgent): string {
  return `${LEGACY_ACCOUNT_PREFIX}${agent}_${workspaceId}`;
}

export function legacyAgentBindingId(runnerId: string, agent: RunnerCodingAgent): string {
  return `${LEGACY_ACCOUNT_PREFIX}${agent}_${runnerId}`;
}

function* accountRowSteps(q: Q, id: string) {
  const { agentAccount } = q.t;
  const row = yield* q.one(
    q.orm.select(accountColumns(q)).from(agentAccount).where(eq(agentAccount.id, id)),
  );
  return row ? account(row) : null;
}

function* bindingRowSteps(q: Q, id: string) {
  const { agentAccountBinding } = q.t;
  const row = yield* q.one(
    q.orm.select().from(agentAccountBinding).where(eq(agentAccountBinding.id, id)),
  );
  return row ? binding(row) : null;
}

function* runnerWorkspaceSteps(q: Q, runnerId: string) {
  const { runner } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ workspaceId: runner.workspaceId, revokedAt: runner.revokedAt })
      .from(runner)
      .where(eq(runner.id, runnerId)),
  );
  if (!row) throw new AgentAccountError("not_found", "Runner is unavailable");
  return row;
}

export function* getAgentAccountSteps(q: Q, workspaceId: string, id: string) {
  const row = yield* accountRowSteps(q, id);
  if (!row) throw new AgentAccountError("not_found", "Agent account is unavailable");
  if (row.workspaceId !== workspaceId)
    throw new AgentAccountError("foreign_workspace", "Agent account belongs to another workspace");
  return row;
}

export async function getAgentAccount(
  store: Db,
  workspaceId: string,
  id: string,
): Promise<AgentAccount> {
  return store.run((q) => getAgentAccountSteps(q, workspaceId, id));
}

export function* getAgentBindingSteps(q: Q, workspaceId: string, id: string) {
  const row = yield* bindingRowSteps(q, id);
  if (!row) throw new AgentAccountError("not_found", "Agent account binding is unavailable");
  if (row.workspaceId !== workspaceId)
    throw new AgentAccountError(
      "foreign_workspace",
      "Agent account binding belongs to another workspace",
    );
  return row;
}

export async function getAgentBinding(store: Db, workspaceId: string, id: string) {
  return store.run((q) => getAgentBindingSteps(q, workspaceId, id));
}

export function* listAgentAccountsSteps(q: Q, workspaceId: string) {
  const { agentAccount: a } = q.t;
  const rows = yield* q.all(
    q.orm
      .select(accountColumns(q))
      .from(a)
      .where(eq(a.workspaceId, workspaceId))
      .orderBy(asc(a.agent), desc(a.legacy), asc(a.createdAt), added(q, a.id)),
  );
  return rows.map(account);
}

export async function listAgentAccounts(store: Db, workspaceId: string): Promise<AgentAccount[]> {
  return store.run((q) => listAgentAccountsSteps(q, workspaceId));
}

export function* listAgentBindingsSteps(q: Q, workspaceId: string, accountId?: string) {
  const { agentAccountBinding: b } = q.t;
  if (accountId !== undefined) yield* getAgentAccountSteps(q, workspaceId, accountId);
  const rows = yield* q.all(
    q.orm
      .select()
      .from(b)
      .where(
        and(
          eq(b.workspaceId, workspaceId),
          accountId === undefined ? undefined : eq(b.accountId, accountId),
        ),
      )
      .orderBy(asc(b.accountId), asc(b.createdAt), added(q, b.id)),
  );
  return rows.map(binding);
}

export async function listAgentBindings(
  store: Db,
  workspaceId: string,
  accountId?: string,
): Promise<AgentAccountBinding[]> {
  return store.run((q) => listAgentBindingsSteps(q, workspaceId, accountId));
}

export function* ensureLegacyAgentBindingSteps(
  q: Q,
  runnerId: string,
  agent: RunnerCodingAgent,
  at: number,
) {
  const { agentAccount, agentAccountBinding } = q.t;
  const { workspaceId } = yield* runnerWorkspaceSteps(q, runnerId);
  const accountId = legacyAgentAccountId(workspaceId, agent);
  const id = legacyAgentBindingId(runnerId, agent);
  yield* q.exec(
    q.orm
      .insert(agentAccount)
      .values({
        id: accountId,
        workspaceId,
        agent,
        label: `${AGENT_NAMES[agent]} default sign-in`,
        legacy: 1,
        enabled: 1,
        createdAt: at,
        updatedAt: at,
      })
      .onConflictDoNothing(),
  );
  yield* q.exec(
    q.orm
      .insert(agentAccountBinding)
      .values({
        id,
        workspaceId,
        accountId,
        agent,
        runnerId,
        legacy: 1,
        quotaScope: "unknown",
        createdAt: at,
      })
      .onConflictDoNothing(),
  );
  return (yield* bindingRowSteps(q, id))!;
}

export async function ensureLegacyAgentBinding(
  store: Db,
  runnerId: string,
  agent: RunnerCodingAgent,
  at: number,
): Promise<AgentAccountBinding> {
  return store.transaction((q) => ensureLegacyAgentBindingSteps(q, runnerId, agent, at));
}

function parseLabel(value: string): string {
  const label = value.trim();
  if (
    label.length < 1 ||
    label.length > 80 ||
    [...label].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    throw new AgentAccountError("invalid", "Agent account label must be 1 to 80 characters");
  return label;
}

function* labelTakenSteps(
  q: Q,
  workspaceId: string,
  agent: RunnerCodingAgent,
  label: string,
  except: string | null,
) {
  const { agentAccount: a } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(a)
      .where(
        and(
          eq(a.workspaceId, workspaceId),
          eq(a.agent, agent),
          sql`lower(${a.label})=lower(${label})`,
          isNull(a.removedAt),
          except === null ? undefined : ne(a.id, except),
        ),
      ),
  );
  return row !== undefined;
}

export function* createAgentAccountSteps(
  q: Q,
  input: { workspaceId: string; agent: RunnerCodingAgent; label: string; now: number },
) {
  const { agentAccount, workspace } = q.t;
  const label = parseLabel(input.label);
  if (!AGENT_NAMES[input.agent]) throw new AgentAccountError("invalid", "Unknown agent");
  const found = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(workspace)
      .where(eq(workspace.id, input.workspaceId)),
  );
  if (!found) throw new AgentAccountError("not_found", "Workspace is unavailable");
  if (yield* labelTakenSteps(q, input.workspaceId, input.agent, label, null))
    throw new AgentAccountError("duplicate", "Another account for this agent has that label");
  const id = ulid(input.now);
  yield* q.exec(
    q.orm.insert(agentAccount).values({
      id,
      workspaceId: input.workspaceId,
      agent: input.agent,
      label,
      legacy: 0,
      enabled: 1,
      createdAt: input.now,
      updatedAt: input.now,
    }),
  );
  return (yield* accountRowSteps(q, id))!;
}

export async function createAgentAccount(
  store: Db,
  input: { workspaceId: string; agent: RunnerCodingAgent; label: string; now: number },
): Promise<AgentAccount> {
  return store.transaction((q) => createAgentAccountSteps(q, input));
}

function* liveAccountSteps(q: Q, workspaceId: string, id: string) {
  const row = yield* getAgentAccountSteps(q, workspaceId, id);
  if (row.removedAt !== null) throw new AgentAccountError("removed", "Agent account was removed");
  return row;
}

export function* renameAgentAccountSteps(
  q: Q,
  input: { workspaceId: string; accountId: string; label: string; now: number },
) {
  const { agentAccount } = q.t;
  const label = parseLabel(input.label);
  const row = yield* liveAccountSteps(q, input.workspaceId, input.accountId);
  if (yield* labelTakenSteps(q, row.workspaceId, row.agent, label, row.id))
    throw new AgentAccountError("duplicate", "Another account for this agent has that label");
  yield* q.exec(
    q.orm
      .update(agentAccount)
      .set({ label, updatedAt: input.now })
      .where(eq(agentAccount.id, row.id)),
  );
  return (yield* accountRowSteps(q, row.id))!;
}

export async function renameAgentAccount(
  store: Db,
  input: { workspaceId: string; accountId: string; label: string; now: number },
): Promise<AgentAccount> {
  return store.transaction((q) => renameAgentAccountSteps(q, input));
}

export function* setAgentAccountEnabledSteps(
  q: Q,
  input: { workspaceId: string; accountId: string; enabled: boolean; now: number },
) {
  const { agentAccount } = q.t;
  const row = yield* liveAccountSteps(q, input.workspaceId, input.accountId);
  yield* q.exec(
    q.orm
      .update(agentAccount)
      .set({ enabled: input.enabled ? 1 : 0, updatedAt: input.now })
      .where(eq(agentAccount.id, row.id)),
  );
  return (yield* accountRowSteps(q, row.id))!;
}

export async function setAgentAccountEnabled(
  store: Db,
  input: { workspaceId: string; accountId: string; enabled: boolean; now: number },
): Promise<AgentAccount> {
  return store.transaction((q) => setAgentAccountEnabledSteps(q, input));
}

export function* setAgentAccountConcurrencySteps(
  q: Q,
  input: { workspaceId: string; accountId: string; concurrency: number | null; now: number },
) {
  const { agentAccount } = q.t;
  if (
    input.concurrency !== null &&
    (!Number.isSafeInteger(input.concurrency) || input.concurrency < 1 || input.concurrency > 64)
  )
    throw new AgentAccountError("invalid", "Agent account concurrency must be 1 to 64");
  const row = yield* liveAccountSteps(q, input.workspaceId, input.accountId);
  yield* q.exec(
    q.orm
      .update(agentAccount)
      .set({ concurrency: input.concurrency, updatedAt: input.now })
      .where(eq(agentAccount.id, row.id)),
  );
  return input.concurrency;
}

export async function setAgentAccountConcurrency(
  store: Db,
  input: { workspaceId: string; accountId: string; concurrency: number | null; now: number },
): Promise<number | null> {
  return store.transaction((q) => setAgentAccountConcurrencySteps(q, input));
}

export function* removeAgentAccountSteps(
  q: Q,
  input: { workspaceId: string; accountId: string; now: number },
) {
  const { agentAccount, agentAccountBinding } = q.t;
  const row = yield* liveAccountSteps(q, input.workspaceId, input.accountId);
  if (row.legacy)
    throw new AgentAccountError("legacy", "The default sign-in account cannot be removed");
  yield* q.exec(
    q.orm
      .update(agentAccount)
      .set({ enabled: 0, removedAt: input.now, updatedAt: input.now })
      .where(eq(agentAccount.id, row.id)),
  );
  yield* q.exec(
    q.orm
      .update(agentAccountBinding)
      .set({ removedAt: input.now })
      .where(and(eq(agentAccountBinding.accountId, row.id), isNull(agentAccountBinding.removedAt))),
  );
  return (yield* accountRowSteps(q, row.id))!;
}

export async function removeAgentAccount(
  store: Db,
  input: { workspaceId: string; accountId: string; now: number },
): Promise<AgentAccount> {
  return store.transaction((q) => removeAgentAccountSteps(q, input));
}

export function* bindAgentAccountSteps(
  q: Q,
  input: { workspaceId: string; accountId: string; runnerId: string; now: number },
) {
  const { agentAccountBinding: b } = q.t;
  const row = yield* liveAccountSteps(q, input.workspaceId, input.accountId);
  if (row.legacy)
    throw new AgentAccountError("legacy", "The default sign-in account binds automatically");
  const runner = yield* runnerWorkspaceSteps(q, input.runnerId);
  if (runner.workspaceId !== input.workspaceId)
    throw new AgentAccountError("foreign_workspace", "Runner belongs to another workspace");
  if (runner.revokedAt !== null) throw new AgentAccountError("removed", "Runner was revoked");
  const bound = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(b)
      .where(and(eq(b.runnerId, input.runnerId), eq(b.accountId, row.id), isNull(b.removedAt))),
  );
  if (bound)
    throw new AgentAccountError("duplicate", "This runner already has a binding for the account");
  const id = ulid(input.now);
  yield* q.exec(
    q.orm.insert(b).values({
      id,
      workspaceId: row.workspaceId,
      accountId: row.id,
      agent: row.agent,
      runnerId: input.runnerId,
      legacy: 0,
      quotaScope: "account",
      createdAt: input.now,
    }),
  );
  return (yield* bindingRowSteps(q, id))!;
}

export async function bindAgentAccount(
  store: Db,
  input: { workspaceId: string; accountId: string; runnerId: string; now: number },
): Promise<AgentAccountBinding> {
  return store.transaction((q) => bindAgentAccountSteps(q, input));
}

export function* removeAgentBindingSteps(
  q: Q,
  input: { workspaceId: string; bindingId: string; now: number },
) {
  const { agentAccountBinding: b } = q.t;
  const row = yield* getAgentBindingSteps(q, input.workspaceId, input.bindingId);
  if (row.legacy)
    throw new AgentAccountError("legacy", "The default sign-in binding cannot be removed");
  yield* q.exec(
    q.orm
      .update(b)
      .set({ removedAt: sql`COALESCE(${b.removedAt},${input.now})` })
      .where(eq(b.id, row.id)),
  );
  return (yield* bindingRowSteps(q, row.id))!;
}

export async function removeAgentBinding(
  store: Db,
  input: { workspaceId: string; bindingId: string; now: number },
): Promise<AgentAccountBinding> {
  return store.transaction((q) => removeAgentBindingSteps(q, input));
}

export function* recordRunnerAccountCapabilitySteps(
  q: Q,
  runnerId: string,
  capability: RunnerAccountCapability | undefined,
  at: number,
) {
  const { runnerAccountCapability: c } = q.t;
  if (!capability) {
    yield* q.exec(q.orm.delete(c).where(eq(c.runnerId, runnerId)));
    return;
  }
  const parsed = RunnerAccountCapabilitySchema.parse(capability);
  const set = {
    protocol: parsed.protocol,
    bindings: jsonValue(q, parsed.bindings),
    reportedAt: at,
  };
  yield* q.exec(
    q.orm
      .insert(c)
      .values({ runnerId, ...set })
      .onConflictDoUpdate({ target: c.runnerId, set }),
  );
}

export async function recordRunnerAccountCapability(
  store: Db,
  runnerId: string,
  capability: RunnerAccountCapability | undefined,
  at: number,
): Promise<void> {
  await store.run((q) => recordRunnerAccountCapabilitySteps(q, runnerId, capability, at));
}

export function* runnerAccountUnsupportedSteps(
  q: Q,
  runnerId: string,
  bindingId: string,
  agent: RunnerCodingAgent,
  options: { signIn?: boolean } = {},
) {
  const { runnerAccountCapability: c, runnerHostStatus: h } = q.t;
  const status = yield* q.one(
    q.orm.select({ version: h.runnerVersion }).from(h).where(eq(h.runnerId, runnerId)),
  );
  if (!runnerReleaseAtLeast(status?.version, AGENT_ACCOUNTS_RUNNER_VERSION))
    return `Named agent accounts need runner ${AGENT_ACCOUNTS_RUNNER_VERSION.join(".")} or later`;
  const row = yield* q.one(
    q.orm
      .select({ protocol: c.protocol, bindings: jsonText(q, c.bindings) })
      .from(c)
      .where(eq(c.runnerId, runnerId)),
  );
  if (!row || row.protocol < RUNNER_ACCOUNT_PROTOCOL)
    return "The runner has not reported agent account support";
  const agentUnsupported = runnerAccountAgentUnsupported(agent);
  if (agentUnsupported) return agentUnsupported;
  if (options.signIn) return null;
  const capability = RunnerAccountCapabilitySchema.safeParse({
    protocol: row.protocol,
    bindings: JSON.parse(row.bindings),
  });
  if (
    !capability.success ||
    !capability.data.bindings.some(
      (entry) => entry.bindingId === bindingId && entry.agent === agent,
    )
  )
    return "The runner has not reported this account binding";
  return null;
}

export async function runnerAccountUnsupported(
  store: Db,
  runnerId: string,
  bindingId: string,
  agent: RunnerCodingAgent,
  options: { signIn?: boolean } = {},
): Promise<string | null> {
  return store.run((q) => runnerAccountUnsupportedSteps(q, runnerId, bindingId, agent, options));
}

function commandAgent(command: RunnerCommand | RunnerRetroCommand): RunnerCodingAgent | null {
  if ("profile" in command) return command.profile.agent;
  if ("agent" in command) return command.agent;
  return null;
}

export function* recordCommandAccountSteps(
  q: Q,
  command: RunnerCommand | RunnerRetroCommand,
  at: number,
) {
  const agent = commandAgent(command);
  if (!agent) return null;
  const named = "account" in command ? command.account : undefined;
  let row: AgentAccountBinding;
  if (!named) {
    const { workspaceId } = yield* runnerWorkspaceSteps(q, command.runnerId);
    if (workspaceId !== command.workspaceId)
      throw new AgentAccountError("foreign_workspace", "Runner belongs to another workspace");
    row = yield* ensureLegacyAgentBindingSteps(q, command.runnerId, agent, at);
  } else {
    row = yield* getAgentBindingSteps(q, command.workspaceId, named.bindingId);
    if (
      row.legacy ||
      row.accountId !== named.accountId ||
      row.runnerId !== command.runnerId ||
      row.agent !== agent
    )
      throw new AgentAccountError(
        "binding_mismatch",
        "Agent account binding does not match the command",
      );
    const unsupported = yield* runnerAccountUnsupportedSteps(q, command.runnerId, row.id, agent, {
      signIn: command.type === "login",
    });
    if (unsupported) throw new AgentAccountError("runner_unsupported", unsupported);
  }
  const owner = (yield* accountRowSteps(q, row.accountId))!;
  if (row.removedAt !== null || owner.removedAt !== null)
    throw new AgentAccountError("removed", "Agent account was removed");
  if (!owner.enabled && command.type !== "login" && command.type !== "login_check")
    throw new AgentAccountError("disabled", "Agent account is disabled");
  yield* q.exec(
    q.orm.insert(q.t.runnerCommandAccount).values({
      commandId: command.id,
      workspaceId: row.workspaceId,
      runnerId: command.runnerId,
      agent,
      accountId: row.accountId,
      bindingId: row.id,
      named: named ? 1 : 0,
      recordedAt: at,
    }),
  );
  return (yield* commandAccountSteps(q, command.id))!;
}

export function recordCommandAccount(
  db: Database,
  command: RunnerCommand | RunnerRetroCommand,
  at: number,
): CommandAccount | null {
  return settled(sqliteDb(db).transaction((q) => recordCommandAccountSteps(q, command, at)));
}

export function* commandAccountSteps(q: Q, commandId: string) {
  const { runnerCommandAccount: c } = q.t;
  const row = yield* q.one(q.orm.select().from(c).where(eq(c.commandId, commandId)));
  return row ? { ...row, agent: row.agent as RunnerCodingAgent, named: row.named === 1 } : null;
}

export async function commandAccount(store: Db, commandId: string): Promise<CommandAccount | null> {
  return store.run((q) => commandAccountSteps(q, commandId));
}

type AccountAdmission = {
  agent: RunnerCodingAgent;
  eligible: string[];
  skipped: { accountId: string; reason: AgentAccountErrorCode }[];
};

export function* admitAgentAccountsSteps(q: Q, workspaceId: string, agent: RunnerCodingAgent) {
  const ids = [legacyAgentAccountId(workspaceId, agent)];
  const eligible: string[] = [];
  const skipped: AccountAdmission["skipped"] = [];
  for (const id of ids) {
    const row = yield* accountRowSteps(q, id);
    const reason: AgentAccountErrorCode | null = !row
      ? id === legacyAgentAccountId(workspaceId, agent)
        ? null
        : "not_found"
      : row.workspaceId !== workspaceId
        ? "foreign_workspace"
        : row.agent !== agent
          ? "binding_mismatch"
          : row.removedAt !== null
            ? "removed"
            : !row.enabled
              ? "disabled"
              : null;
    if (reason) skipped.push({ accountId: id, reason });
    else eligible.push(id);
  }
  return { agent, eligible, skipped };
}

export async function admitAgentAccounts(
  store: Db,
  workspaceId: string,
  agent: RunnerCodingAgent,
): Promise<AccountAdmission> {
  return store.run((q) => admitAgentAccountsSteps(q, workspaceId, agent));
}

export function* liveAccountBindingSteps(q: Q, runnerId: string, accountId: string) {
  const { agentAccountBinding: b } = q.t;
  const row = yield* q.one(
    q.orm
      .select()
      .from(b)
      .where(and(eq(b.runnerId, runnerId), eq(b.accountId, accountId), isNull(b.removedAt)))
      .orderBy(asc(b.createdAt), added(q, b.id))
      .limit(1),
  );
  return row ? binding(row) : null;
}

export async function liveAccountBinding(
  store: Db,
  runnerId: string,
  accountId: string,
): Promise<AgentAccountBinding | null> {
  return store.run((q) => liveAccountBindingSteps(q, runnerId, accountId));
}

export function* agentAccountConcurrencySteps(q: Q, accountId: string) {
  const { agentAccount } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ concurrency: agentAccount.concurrency })
      .from(agentAccount)
      .where(eq(agentAccount.id, accountId)),
  );
  return row?.concurrency ?? null;
}

export async function agentAccountConcurrency(
  store: Db,
  accountId: string,
): Promise<number | null> {
  return store.run((q) => agentAccountConcurrencySteps(q, accountId));
}

export function* accountSlotsInUseSteps(
  q: Q,
  accountId: string,
  at: number,
  exceptCommandId: string | null = null,
) {
  const { retroDispatch: d, runnerCommandAccount: a, runnerExecutionUsage: u } = q.t;
  const { runnerHelper: h, runnerCommand: c } = q.t;
  const w = aliasedTable(q.t.runnerWork, "w");
  const retros = yield* q.one(
    q.orm
      .select({ count: count() })
      .from(d)
      .innerJoin(a, eq(a.commandId, d.commandId))
      .where(
        and(
          eq(a.accountId, accountId),
          exceptCommandId === null ? undefined : ne(d.commandId, exceptCommandId),
          isNull(d.releasedAt),
        ),
      ),
  );
  const usage = yield* q.one(
    q.orm
      .select({ count: count() })
      .from(u)
      .innerJoin(a, eq(a.commandId, u.commandId))
      .leftJoin(h, eq(h.id, u.commandId))
      .leftJoin(c, eq(c.id, u.commandId))
      .leftJoin(w, and(eq(w.runId, c.runId), eq(w.commandId, u.commandId)))
      .where(
        and(
          eq(a.accountId, accountId),
          exceptCommandId === null ? undefined : ne(u.commandId, exceptCommandId),
          or(
            and(isNotNull(h.id), gt(h.expiresAt, at), or(isNull(h.endedAt), isNull(h.result))),
            and(
              isNotNull(w.runId),
              or(
                and(isNull(w.endedAt), gt(w.leaseUntil, runnerLeaseCutoff(at))),
                sql.raw(TEARDOWN_UNRESOLVED),
              ),
            ),
            and(
              isNull(h.id),
              isNotNull(c.id),
              isNull(c.runId),
              isNull(u.endedAt),
              gt(c.expiresAt, at),
            ),
          ),
        ),
      ),
  );
  return retros!.count + usage!.count;
}

export async function accountSlotsInUse(
  store: Db,
  accountId: string,
  at: number,
  exceptCommandId: string | null = null,
): Promise<number> {
  return store.run((q) => accountSlotsInUseSteps(q, accountId, at, exceptCommandId));
}

export function* storedAgentBindingIdSteps(q: Q, id: string) {
  const { agentAccountBinding: b } = q.t;
  const row = yield* q.one(q.orm.select({ id: b.id }).from(b).where(eq(b.id, id)));
  return row?.id ?? null;
}

export async function storedAgentBindingId(store: Db, id: string): Promise<string | null> {
  return store.run((q) => storedAgentBindingIdSteps(q, id));
}

export type RunnerNamedBinding = {
  bindingId: string;
  accountId: string;
  agent: RunnerCodingAgent;
  label: string;
  enabled: number;
};

export function* runnerNamedBindingsSteps(q: Q, runnerId: string, workspaceId: string) {
  const { agentAccountBinding: b, agentAccount: a } = q.t;
  return yield* q.all(
    q.orm
      .select({
        bindingId: b.id,
        accountId: b.accountId,
        agent: sql<RunnerCodingAgent>`${b.agent}`,
        label: a.label,
        enabled: a.enabled,
      })
      .from(b)
      .innerJoin(a, eq(a.id, b.accountId))
      .where(
        and(
          eq(b.runnerId, runnerId),
          eq(b.workspaceId, workspaceId),
          eq(b.legacy, 0),
          isNull(b.removedAt),
          isNull(a.removedAt),
        ),
      )
      .orderBy(asc(a.agent), asc(a.createdAt), asc(b.createdAt)),
  );
}

export async function runnerNamedBindings(
  store: Db,
  runnerId: string,
  workspaceId: string,
): Promise<RunnerNamedBinding[]> {
  return store.run((q) => runnerNamedBindingsSteps(q, runnerId, workspaceId));
}

export function* bindingRunningCountSteps(q: Q, bindingId: string, at: number) {
  const { runnerWork: w, runnerHelper: h, runnerCommandAccount: c } = q.t;
  const work = yield* q.one(
    q.orm
      .select({ count: count() })
      .from(w)
      .innerJoin(c, eq(c.commandId, w.commandId))
      .where(
        and(eq(c.bindingId, bindingId), isNull(w.endedAt), gt(w.leaseUntil, runnerLeaseCutoff(at))),
      ),
  );
  const helpers = yield* q.one(
    q.orm
      .select({ count: count() })
      .from(h)
      .innerJoin(c, eq(c.commandId, h.id))
      .where(
        and(eq(c.bindingId, bindingId), isNull(h.endedAt), isNull(h.result), gt(h.expiresAt, at)),
      ),
  );
  return work!.count + helpers!.count;
}

export async function bindingRunningCount(
  store: Db,
  bindingId: string,
  at: number,
): Promise<number> {
  return store.run((q) => bindingRunningCountSteps(q, bindingId, at));
}
