import type { Database } from "bun:sqlite";
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
} from "../runner-protocol";
import { immediate } from "./tx";
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

export type CommandAccount = {
  commandId: string;
  workspaceId: string;
  runnerId: string;
  agent: RunnerCodingAgent;
  accountId: string;
  bindingId: string;
  named: boolean;
  policyRevision: string | null;
  recordedAt: number;
};

export type AgentAccountErrorCode =
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

const accountColumns =
  "id,workspace_id AS workspaceId,agent,label,legacy,enabled,created_at AS createdAt,updated_at AS updatedAt,removed_at AS removedAt";
const bindingColumns =
  "id,workspace_id AS workspaceId,account_id AS accountId,agent,runner_id AS runnerId,legacy,quota_scope AS quotaScope,created_at AS createdAt,removed_at AS removedAt";
const commandColumns =
  "command_id AS commandId,workspace_id AS workspaceId,runner_id AS runnerId,agent,account_id AS accountId,binding_id AS bindingId,named,policy_revision AS policyRevision,recorded_at AS recordedAt";
const AGENT_NAMES: Record<RunnerCodingAgent, string> = {
  claude: "Claude",
  codex: "Codex",
  grok: "Grok",
  opencode: "OpenCode",
};

type Flags<T, K extends keyof T> = Omit<T, K> & { [P in K]: number };
const account = (row: Flags<AgentAccount, "legacy" | "enabled">): AgentAccount => ({
  ...row,
  legacy: row.legacy === 1,
  enabled: row.enabled === 1,
});
const binding = (row: Flags<AgentAccountBinding, "legacy">): AgentAccountBinding => ({
  ...row,
  legacy: row.legacy === 1,
});

export function legacyAgentAccountId(workspaceId: string, agent: RunnerCodingAgent): string {
  return `${LEGACY_ACCOUNT_PREFIX}${agent}_${workspaceId}`;
}

export function legacyAgentBindingId(runnerId: string, agent: RunnerCodingAgent): string {
  return `${LEGACY_ACCOUNT_PREFIX}${agent}_${runnerId}`;
}

function accountRow(db: Database, id: string): AgentAccount | null {
  const row = db
    .query<Flags<AgentAccount, "legacy" | "enabled">, [string]>(
      `SELECT ${accountColumns} FROM agent_account WHERE id=?`,
    )
    .get(id);
  return row ? account(row) : null;
}

function bindingRow(db: Database, id: string): AgentAccountBinding | null {
  const row = db
    .query<Flags<AgentAccountBinding, "legacy">, [string]>(
      `SELECT ${bindingColumns} FROM agent_account_binding WHERE id=?`,
    )
    .get(id);
  return row ? binding(row) : null;
}

function runnerWorkspace(db: Database, runnerId: string) {
  const row = db
    .query<{ workspaceId: string; revokedAt: number | null }, [string]>(
      "SELECT workspace_id AS workspaceId,revoked_at AS revokedAt FROM runner WHERE id=?",
    )
    .get(runnerId);
  if (!row) throw new AgentAccountError("not_found", "Runner is unavailable");
  return row;
}

export function getAgentAccount(db: Database, workspaceId: string, id: string): AgentAccount {
  const row = accountRow(db, id);
  if (!row) throw new AgentAccountError("not_found", "Agent account is unavailable");
  if (row.workspaceId !== workspaceId)
    throw new AgentAccountError("foreign_workspace", "Agent account belongs to another workspace");
  return row;
}

export function getAgentBinding(db: Database, workspaceId: string, id: string) {
  const row = bindingRow(db, id);
  if (!row) throw new AgentAccountError("not_found", "Agent account binding is unavailable");
  if (row.workspaceId !== workspaceId)
    throw new AgentAccountError(
      "foreign_workspace",
      "Agent account binding belongs to another workspace",
    );
  return row;
}

export function listAgentAccounts(db: Database, workspaceId: string): AgentAccount[] {
  return db
    .query<Flags<AgentAccount, "legacy" | "enabled">, [string]>(
      `SELECT ${accountColumns} FROM agent_account WHERE workspace_id=? ORDER BY agent,legacy DESC,created_at,rowid`,
    )
    .all(workspaceId)
    .map(account);
}

export function listAgentBindings(
  db: Database,
  workspaceId: string,
  accountId?: string,
): AgentAccountBinding[] {
  if (accountId !== undefined) getAgentAccount(db, workspaceId, accountId);
  return db
    .query<Flags<AgentAccountBinding, "legacy">, [string, string | null]>(
      `SELECT ${bindingColumns} FROM agent_account_binding WHERE workspace_id=?1 AND (?2 IS NULL OR account_id=?2) ORDER BY account_id,created_at,rowid`,
    )
    .all(workspaceId, accountId ?? null)
    .map(binding);
}

export function ensureLegacyAgentBinding(
  db: Database,
  runnerId: string,
  agent: RunnerCodingAgent,
  at: number,
): AgentAccountBinding {
  const { workspaceId } = runnerWorkspace(db, runnerId);
  const accountId = legacyAgentAccountId(workspaceId, agent);
  const id = legacyAgentBindingId(runnerId, agent);
  return immediate(db, () => {
    db.run(
      "INSERT OR IGNORE INTO agent_account(id,workspace_id,agent,label,legacy,enabled,created_at,updated_at) VALUES(?,?,?,?,1,1,?,?)",
      [accountId, workspaceId, agent, `${AGENT_NAMES[agent]} default sign-in`, at, at],
    );
    db.run(
      "INSERT OR IGNORE INTO agent_account_binding(id,workspace_id,account_id,agent,runner_id,legacy,quota_scope,created_at) VALUES(?,?,?,?,?,1,'unknown',?)",
      [id, workspaceId, accountId, agent, runnerId, at],
    );
    return bindingRow(db, id)!;
  });
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

function labelTaken(
  db: Database,
  workspaceId: string,
  agent: RunnerCodingAgent,
  label: string,
  except: string | null,
) {
  return (
    db
      .query(
        "SELECT 1 FROM agent_account WHERE workspace_id=? AND agent=? AND lower(label)=lower(?) AND removed_at IS NULL AND id IS NOT ?",
      )
      .get(workspaceId, agent, label, except) !== null
  );
}

export function createAgentAccount(
  db: Database,
  input: { workspaceId: string; agent: RunnerCodingAgent; label: string; now: number },
): AgentAccount {
  const label = parseLabel(input.label);
  if (!AGENT_NAMES[input.agent]) throw new AgentAccountError("invalid", "Unknown agent");
  return immediate(db, () => {
    if (!db.query("SELECT 1 FROM workspace WHERE id=?").get(input.workspaceId))
      throw new AgentAccountError("not_found", "Workspace is unavailable");
    if (labelTaken(db, input.workspaceId, input.agent, label, null))
      throw new AgentAccountError("duplicate", "Another account for this agent has that label");
    const id = ulid(input.now);
    db.run(
      "INSERT INTO agent_account(id,workspace_id,agent,label,legacy,enabled,created_at,updated_at) VALUES(?,?,?,?,0,1,?,?)",
      [id, input.workspaceId, input.agent, label, input.now, input.now],
    );
    return accountRow(db, id)!;
  });
}

function liveAccount(db: Database, workspaceId: string, id: string) {
  const row = getAgentAccount(db, workspaceId, id);
  if (row.removedAt !== null) throw new AgentAccountError("removed", "Agent account was removed");
  return row;
}

export function renameAgentAccount(
  db: Database,
  input: { workspaceId: string; accountId: string; label: string; now: number },
): AgentAccount {
  const label = parseLabel(input.label);
  return immediate(db, () => {
    const row = liveAccount(db, input.workspaceId, input.accountId);
    if (labelTaken(db, row.workspaceId, row.agent, label, row.id))
      throw new AgentAccountError("duplicate", "Another account for this agent has that label");
    db.run("UPDATE agent_account SET label=?,updated_at=? WHERE id=?", [label, input.now, row.id]);
    return accountRow(db, row.id)!;
  });
}

export function setAgentAccountEnabled(
  db: Database,
  input: { workspaceId: string; accountId: string; enabled: boolean; now: number },
): AgentAccount {
  return immediate(db, () => {
    const row = liveAccount(db, input.workspaceId, input.accountId);
    db.run("UPDATE agent_account SET enabled=?,updated_at=? WHERE id=?", [
      input.enabled ? 1 : 0,
      input.now,
      row.id,
    ]);
    return accountRow(db, row.id)!;
  });
}

export function removeAgentAccount(
  db: Database,
  input: { workspaceId: string; accountId: string; now: number },
): AgentAccount {
  return immediate(db, () => {
    const row = liveAccount(db, input.workspaceId, input.accountId);
    if (row.legacy)
      throw new AgentAccountError("legacy", "The default sign-in account cannot be removed");
    db.run("UPDATE agent_account SET enabled=0,removed_at=?,updated_at=? WHERE id=?", [
      input.now,
      input.now,
      row.id,
    ]);
    db.run(
      "UPDATE agent_account_binding SET removed_at=? WHERE account_id=? AND removed_at IS NULL",
      [input.now, row.id],
    );
    return accountRow(db, row.id)!;
  });
}

export function bindAgentAccount(
  db: Database,
  input: { workspaceId: string; accountId: string; runnerId: string; now: number },
): AgentAccountBinding {
  return immediate(db, () => {
    const row = liveAccount(db, input.workspaceId, input.accountId);
    if (row.legacy)
      throw new AgentAccountError("legacy", "The default sign-in account binds automatically");
    const runner = runnerWorkspace(db, input.runnerId);
    if (runner.workspaceId !== input.workspaceId)
      throw new AgentAccountError("foreign_workspace", "Runner belongs to another workspace");
    if (runner.revokedAt !== null) throw new AgentAccountError("removed", "Runner was revoked");
    if (
      db
        .query(
          "SELECT 1 FROM agent_account_binding WHERE runner_id=? AND account_id=? AND removed_at IS NULL",
        )
        .get(input.runnerId, row.id)
    )
      throw new AgentAccountError("duplicate", "This runner already has a binding for the account");
    const id = ulid(input.now);
    db.run(
      "INSERT INTO agent_account_binding(id,workspace_id,account_id,agent,runner_id,legacy,quota_scope,created_at) VALUES(?,?,?,?,?,0,'account',?)",
      [id, row.workspaceId, row.id, row.agent, input.runnerId, input.now],
    );
    return bindingRow(db, id)!;
  });
}

export function removeAgentBinding(
  db: Database,
  input: { workspaceId: string; bindingId: string; now: number },
): AgentAccountBinding {
  return immediate(db, () => {
    const row = getAgentBinding(db, input.workspaceId, input.bindingId);
    if (row.legacy)
      throw new AgentAccountError("legacy", "The default sign-in binding cannot be removed");
    db.run("UPDATE agent_account_binding SET removed_at=COALESCE(removed_at,?) WHERE id=?", [
      input.now,
      row.id,
    ]);
    return bindingRow(db, row.id)!;
  });
}

export function recordRunnerAccountCapability(
  db: Database,
  runnerId: string,
  capability: RunnerAccountCapability | undefined,
  at: number,
): void {
  if (!capability) {
    db.run("DELETE FROM runner_account_capability WHERE runner_id=?", [runnerId]);
    return;
  }
  const parsed = RunnerAccountCapabilitySchema.parse(capability);
  db.run(
    `INSERT INTO runner_account_capability(runner_id,protocol,bindings,reported_at) VALUES(?,?,?,?)
    ON CONFLICT(runner_id) DO UPDATE SET protocol=excluded.protocol,bindings=excluded.bindings,reported_at=excluded.reported_at`,
    [runnerId, parsed.protocol, JSON.stringify(parsed.bindings), at],
  );
}

export function runnerAccountUnsupported(
  db: Database,
  runnerId: string,
  bindingId: string,
  agent: RunnerCodingAgent,
  options: { signIn?: boolean } = {},
): string | null {
  const version = db
    .query<{ version: string | null }, [string]>(
      "SELECT runner_version AS version FROM runner_host_status WHERE runner_id=?",
    )
    .get(runnerId)?.version;
  if (!runnerReleaseAtLeast(version, AGENT_ACCOUNTS_RUNNER_VERSION))
    return `Named agent accounts need runner ${AGENT_ACCOUNTS_RUNNER_VERSION.join(".")} or later`;
  const row = db
    .query<{ protocol: number; bindings: string }, [string]>(
      "SELECT protocol,bindings FROM runner_account_capability WHERE runner_id=?",
    )
    .get(runnerId);
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

function commandAgent(command: RunnerCommand): RunnerCodingAgent | null {
  if ("profile" in command) return command.profile.agent;
  if ("agent" in command) return command.agent;
  return null;
}

export function recordCommandAccount(
  db: Database,
  command: RunnerCommand,
  at: number,
  policyRevision?: string,
): CommandAccount | null {
  const agent = commandAgent(command);
  if (!agent) return null;
  const named = "account" in command ? command.account : undefined;
  return immediate(db, () => {
    let row: AgentAccountBinding;
    if (!named) {
      const { workspaceId } = runnerWorkspace(db, command.runnerId);
      if (workspaceId !== command.workspaceId)
        throw new AgentAccountError("foreign_workspace", "Runner belongs to another workspace");
      row = ensureLegacyAgentBinding(db, command.runnerId, agent, at);
    } else {
      row = getAgentBinding(db, command.workspaceId, named.bindingId);
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
      const unsupported = runnerAccountUnsupported(db, command.runnerId, row.id, agent, {
        signIn: command.type === "login",
      });
      if (unsupported) throw new AgentAccountError("runner_unsupported", unsupported);
    }
    const owner = accountRow(db, row.accountId)!;
    if (row.removedAt !== null || owner.removedAt !== null)
      throw new AgentAccountError("removed", "Agent account was removed");
    if (!owner.enabled && command.type !== "login" && command.type !== "login_check")
      throw new AgentAccountError("disabled", "Agent account is disabled");
    db.run(
      "INSERT INTO runner_command_account(command_id,workspace_id,runner_id,agent,account_id,binding_id,named,policy_revision,recorded_at) VALUES(?,?,?,?,?,?,?,?,?)",
      [
        command.id,
        row.workspaceId,
        command.runnerId,
        agent,
        row.accountId,
        row.id,
        named ? 1 : 0,
        policyRevision ?? null,
        at,
      ],
    );
    return commandAccount(db, command.id)!;
  });
}

export function commandAccount(db: Database, commandId: string): CommandAccount | null {
  const row = db
    .query<Flags<CommandAccount, "named">, [string]>(
      `SELECT ${commandColumns} FROM runner_command_account WHERE command_id=?`,
    )
    .get(commandId);
  return row ? { ...row, named: row.named === 1 } : null;
}

export function listAgentAccountReferences(db: Database) {
  const references = db
    .query<{ id: string; agent: RunnerCodingAgent; enabled: number; removedAt: number | null }, []>(
      "SELECT id,agent,enabled,removed_at AS removedAt FROM agent_account ORDER BY rowid",
    )
    .all()
    .map((row) => ({
      id: row.id,
      agent: row.agent,
      enabled: row.enabled === 1,
      removed: row.removedAt !== null,
    }));
  const known = new Set(references.map((reference) => reference.id));
  for (const { id: workspaceId } of db
    .query<{ id: string }, []>("SELECT id FROM workspace ORDER BY rowid")
    .all())
    for (const agent of Object.keys(AGENT_NAMES) as RunnerCodingAgent[]) {
      const id = legacyAgentAccountId(workspaceId, agent);
      if (!known.has(id)) references.push({ id, agent, enabled: true, removed: false });
    }
  return references;
}

export type AccountAdmission = {
  agent: RunnerCodingAgent;
  configured: boolean;
  eligible: string[];
  skipped: { accountId: string; reason: AgentAccountErrorCode }[];
};

export function admitAgentAccounts(
  db: Database,
  workspaceId: string,
  agent: RunnerCodingAgent,
  policy?: { agent: string; accounts: readonly string[] },
): AccountAdmission {
  if (policy && policy.agent !== agent)
    throw new AgentAccountError("invalid", "The account policy belongs to another agent");
  const ids = [...new Set(policy?.accounts ?? [legacyAgentAccountId(workspaceId, agent)])];
  const eligible: string[] = [];
  const skipped: AccountAdmission["skipped"] = [];
  for (const id of ids) {
    const row = accountRow(db, id);
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
  return { agent, configured: policy !== undefined, eligible, skipped };
}
