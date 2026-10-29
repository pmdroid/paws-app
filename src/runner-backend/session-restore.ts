import type { Database } from "bun:sqlite";
import {
  CLAUDE_SESSION_RESTORE_RUNNER_VERSION,
  CODEX_SESSION_RUNNER_VERSION,
  GROK_SESSION_RUNNER_VERSION,
  type RunnerCommand,
  type RunnerVersion,
} from "../runner-protocol";

/** The runner release each agent's restore needs. */
const RESTORE_RUNNER_VERSION = new Map<string, RunnerVersion>([
  ["claude", CLAUDE_SESSION_RESTORE_RUNNER_VERSION],
  ["codex", CODEX_SESSION_RUNNER_VERSION],
  ["grok", GROK_SESSION_RESTORE_RUNNER_VERSION],
  ["opencode", CODEX_SESSION_RUNNER_VERSION],
]);

type RestoreSession = NonNullable<Extract<RunnerCommand, { type: "run" }>["restoreSession"]>;

/** Why a moved run starts a new session; the runner reports the last three. */
export type SessionRestoreFailure =
  | "no_snapshot"
  | "old_runner"
  | "other_account"
  | "login_not_ready"
  | "not_installed"
  | "download"
  | "integrity"
  | "unpack"
  | "load";

export type SessionRestorePlan =
  | {
      eligible: true;
      restoreSession: RestoreSession;
      commitSha: string;
      turn: number;
      /** The runner that saved the snapshot and the target's current agent version. */
      sourceRunnerId: string;
      targetVersion: string;
    }
  | { eligible: false; failure: SessionRestoreFailure };

const AGENT_NAMES: Record<string, string> = { claude: "Claude", codex: "Codex", grok: "Grok", opencode: "OpenCode" };

export function versionAtLeast(
  version: string | null | undefined,
  minimum: RunnerVersion,
): boolean {
  const parts = version
    ?.match(/^(\d+)\.(\d+)\.(\d+)/)
    ?.slice(1)
    .map(Number);
  if (!parts) return false;
  for (const [index, part] of parts.entries())
    if (part !== minimum[index]) return part > minimum[index]!;
  return true;
}

/**
 * Whether the run's latest sealed session snapshot may be restored on `targetRunnerId`: same
 * agent, a runner release that restores, the same owner as the snapshot, that owner's agent login
 * ready, and the agent installed. A different agent version does not refuse the restore: the
 * runner tries `session/load`, and the notice names both versions if the load fails.
 */
export function planSessionRestore(
  db: Database,
  input: { runId: string; agent: string; targetRunnerId: string },
): SessionRestorePlan {
  const snapshot = db
    .query<
      {
        generation: number;
        runnerId: string;
        ownerUserId: string;
        agent: string;
        agentVersion: string;
        sessionId: string;
        commitSha: string;
        turn: number;
        sealedSize: number;
        sha256: string;
      },
      [string]
    >(
      `SELECT generation,runner_id AS runnerId,owner_user_id AS ownerUserId,agent,
       agent_version AS agentVersion,session_id AS sessionId,commit_sha AS commitSha,turn,
       sealed_size AS sealedSize,sha256 FROM agent_session_snapshot
       WHERE run_id=? AND status='sealed' ORDER BY generation DESC LIMIT 1`,
    )
    .get(input.runId);
  // Another agent's snapshot is not this run's session.
  const minimum = snapshot && RESTORE_RUNNER_VERSION.get(snapshot.agent);
  if (
    !snapshot ||
    !minimum ||
    snapshot.agent !== input.agent ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(snapshot.sessionId)
  )
    return { eligible: false, failure: "no_snapshot" };
  const target = db
    .query<{ ownerUserId: string; version: string | null }, [string]>(
      `SELECT r.owner_user_id AS ownerUserId,h.runner_version AS version FROM runner r
       LEFT JOIN runner_host_status h ON h.runner_id=r.id WHERE r.id=?`,
    )
    .get(input.targetRunnerId);
  if (!target || !versionAtLeast(target.version, minimum))
    return { eligible: false, failure: "old_runner" };
  if (target.ownerUserId !== snapshot.ownerUserId)
    return { eligible: false, failure: "other_account" };
  if (
    !db
      .query(
        "SELECT 1 FROM runner_agent_policy WHERE runner_id=? AND agent=? AND ready=1 AND auth_expired=0",
      )
      .get(input.targetRunnerId, snapshot.agent)
  )
    return { eligible: false, failure: "login_not_ready" };
  const installed = db
    .query<{ version: string }, [string, string]>(
      "SELECT version FROM runner_agent WHERE runner_id=? AND agent=? AND status='current'",
    )
    .get(input.targetRunnerId, snapshot.agent);
  if (!installed) return { eligible: false, failure: "not_installed" };
  return {
    eligible: true,
    restoreSession: {
      generation: snapshot.generation,
      agent: snapshot.agent as RestoreSession["agent"],
      agentVersion: snapshot.agentVersion,
      sessionId: snapshot.sessionId,
      sha256: snapshot.sha256,
      sizeBytes: snapshot.sealedSize,
    },
    commitSha: snapshot.commitSha,
    turn: snapshot.turn,
    sourceRunnerId: snapshot.runnerId,
    targetVersion: installed.version,
  };
}

/** How the run's earlier runner became unusable, after its name. */
export function runnerGoneReason(db: Database, runnerId: string, onlineSince: number): string {
  const runner = db
    .query<{ status: string; revokedAt: number | null; lastSeenAt: number | null }, [string]>(
      "SELECT status,revoked_at AS revokedAt,last_seen_at AS lastSeenAt FROM runner WHERE id=?",
    )
    .get(runnerId);
  if (!runner) return "is gone";
  if (runner.revokedAt !== null || runner.status === "revoked") return "was revoked";
  if (runner.status === "draining") return "is draining";
  if (runner.status === "paused") return "is paused";
  if ((runner.lastSeenAt ?? 0) <= onlineSince) return "is offline";
  return "is unavailable";
}

/** The Linear notice for a moved run, posted once per move. */
export function sessionMoveNotice(input: {
  db: Database;
  from: string;
  to: string;
  /** How the earlier runner became unusable; absent when it handed the session over. */
  gone?: string;
  agent: string;
  outcome:
    | { restored: true; turn: number }
    | {
        restored: false;
        failure: SessionRestoreFailure;
        versions?: { saved: string; savedOn: string; target: string };
      };
}): string {
  const name = (id: string) =>
    input.db.query<{ name: string }, [string]>("SELECT name FROM runner WHERE id=?").get(id)
      ?.name ?? id;
  const to = name(input.to);
  const moved =
    input.gone === undefined
      ? `Moved from ${name(input.from)} to ${to}.`
      : `Moved this run to ${to} because ${name(input.from)} ${input.gone}.`;
  const { outcome } = input;
  if (outcome.restored)
    return `${moved} Continuing the agent's session from turn ${outcome.turn}.\n`;
  const agent = AGENT_NAMES[input.agent] ?? input.agent;
  const reason = {
    no_snapshot: "no saved session",
    old_runner: `${to}'s runner is too old`,
    other_account: `${to} is signed in to a different ${agent} account`,
    login_not_ready: `${to} isn't signed in to ${agent}`,
    not_installed: `${agent} isn't installed on ${to}`,
    download: "the saved session couldn't be downloaded",
    integrity: "the saved session didn't match its checksum",
    unpack: "the saved session held a file outside its session folder",
    load:
      outcome.versions && outcome.versions.saved !== outcome.versions.target
        ? `the saved session didn't load: ${agent} ${outcome.versions.saved} on ${name(outcome.versions.savedOn)}, ${outcome.versions.target} on ${to}`
        : "the saved session didn't load",
  }[outcome.failure];
  return `${moved} Starting a new session from the last pushed commit: the earlier session couldn't be restored (${reason}).\n`;
}
