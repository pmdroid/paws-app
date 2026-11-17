import {
  currentRunnerAgentVersionSteps,
  lastRunCommandAccountSteps,
  latestSealedSnapshotSteps,
  runnerStandingSteps,
  runnerTargetForRestoreSteps,
  storedRunnerNameSteps,
  type Db,
  type Q,
  type Steps,
} from "../db";
import type { RunnerCommand } from "../runner-protocol";

const RESTORABLE_AGENTS = new Set(["claude", "codex", "grok"]);

type RestoreSession = NonNullable<Extract<RunnerCommand, { type: "run" }>["restoreSession"]>;

/** Why a moved run starts a new session; the runner reports the last three. */
export type SessionRestoreFailure =
  | "no_snapshot"
  | "other_account"
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

const AGENT_NAMES: Record<string, string> = { claude: "Claude", codex: "Codex", grok: "Grok" };

/**
 * Whether the run's latest sealed session snapshot may be restored on `targetRunnerId`: same
 * agent, the same owner and account as
 * the snapshot, and the agent installed. A different agent version does not refuse the restore: the
 * runner tries `session/load`, and the notice names both versions if the load fails.
 */
export type SessionRestoreInput = {
  runId: string;
  agent: string;
  targetRunnerId: string;
  targetAccount?: { accountId: string; named: boolean };
};

export function* planSessionRestoreSteps(
  q: Q,
  input: SessionRestoreInput,
): Steps<SessionRestorePlan> {
  const snapshot = yield* latestSealedSnapshotSteps(q, input.runId);
  // Another agent's snapshot is not this run's session.
  if (
    !snapshot ||
    !RESTORABLE_AGENTS.has(snapshot.agent) ||
    snapshot.agent !== input.agent ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(snapshot.sessionId)
  )
    return { eligible: false, failure: "no_snapshot" };
  const target = yield* runnerTargetForRestoreSteps(q, input.targetRunnerId);
  if (!target || target.ownerUserId !== snapshot.ownerUserId)
    return { eligible: false, failure: "other_account" };
  const source = yield* lastRunCommandAccountSteps(q, input.runId, snapshot.generation);
  const sourceNamed = source?.named === 1;
  const targetNamed = input.targetAccount?.named === true;
  if (
    sourceNamed !== targetNamed ||
    (sourceNamed && source!.accountId !== input.targetAccount!.accountId)
  )
    return { eligible: false, failure: "other_account" };
  const installed = yield* currentRunnerAgentVersionSteps(q, input.targetRunnerId, snapshot.agent);
  if (installed === null) return { eligible: false, failure: "not_installed" };
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
    targetVersion: installed,
  };
}

/** How the run's earlier runner became unusable, after its name. */
export async function runnerGoneReason(
  store: Db,
  runnerId: string,
  onlineSince: number,
): Promise<string> {
  const runner = await store.run((q) => runnerStandingSteps(q, runnerId));
  if (!runner) return "is gone";
  if (runner.revokedAt !== null || runner.status === "revoked") return "was revoked";
  if (runner.status === "draining") return "is draining";
  if (runner.status === "paused") return "is paused";
  if ((runner.lastSeenAt ?? 0) <= onlineSince) return "is offline";
  return "is unavailable";
}

/** The Linear notice for a moved run, posted once per move. */
export async function sessionMoveNotice(input: {
  store: Db;
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
}): Promise<string> {
  const name = async (id: string) =>
    (await input.store.run((q) => storedRunnerNameSteps(q, id))) ?? id;
  const to = await name(input.to);
  const from = await name(input.from);
  const moved =
    input.gone === undefined
      ? `Moved from ${from} to ${to}.`
      : `Moved this run to ${to} because ${from} ${input.gone}.`;
  const { outcome } = input;
  if (outcome.restored)
    return `${moved} Continuing the agent's session from turn ${outcome.turn}.\n`;
  const agent = AGENT_NAMES[input.agent] ?? input.agent;
  const savedOn =
    outcome.versions && outcome.versions.saved !== outcome.versions.target
      ? await name(outcome.versions.savedOn)
      : undefined;
  const reason = {
    no_snapshot: "no saved session",
    other_account: `${to} is signed in to a different ${agent} account`,
    not_installed: `${agent} isn't installed on ${to}`,
    download: "the saved session couldn't be downloaded",
    integrity: "the saved session didn't match its checksum",
    unpack: "the saved session held a file outside its session folder",
    load:
      outcome.versions && outcome.versions.saved !== outcome.versions.target
        ? `the saved session didn't load: ${agent} ${outcome.versions.saved} on ${savedOn}, ${outcome.versions.target} on ${to}`
        : "the saved session didn't load",
  }[outcome.failure];
  return `${moved} Starting a new session from the last pushed commit: the earlier session couldn't be restored (${reason}).\n`;
}
