import { and, eq, exists, ne, isNull, sql } from "drizzle-orm";
import { type Q, type Db, type Steps } from "./db";
import { jsonValue, parsedJson } from "./json-text";
import { auditWorkspaceAccessSteps } from "./workspace";
import { agentCatalogSummarySteps, readAgentVersionSteps } from "./agent-versions";

type ReportedStatus = "current" | "previous" | "installing" | "waiting" | "failed";

/** A coding agent version as a runner reported it in its heartbeat. */
type RunnerAgentReport = {
  agent: string;
  version: string;
  status: ReportedStatus;
  target?: string;
  sessions?: number;
  error?: string;
};

/** A package the catalog checked, with the integrity Paws first saw for it on npm. */
export type CatalogPackage = { name: string; version: string; integrity: string };

/** The native build package and its platform packages the catalog checked for an agent version. */
type CatalogPackages = (
  q: Q,
  agent: string,
  nativeVersion: string | null,
) => Steps<CatalogPackage[]>;

/** The version someone chose on the Runners page, sent to the runner until it runs it. */
type RunnerAgentTargetRow = {
  id: string;
  agent: string;
  version: string;
  /** The npm sha512 of the agent package, as the catalog checked it. */
  integrity: string;
  nativeVersion: string | null;
  /** The native and platform packages the runner must install with exactly these integrities. */
  packages: CatalogPackage[];
};

/** What the runner card shows for one coding agent. */
export type RunnerAgentView = {
  agent: string;
  /** The version new sessions start; null before the runner reports one. */
  current: string | null;
  /** The version asked for and how it is going, until the runner runs it. */
  pending: {
    version: string;
    /** `requested` until the runner picks it up. */
    status: "requested" | "installing" | "waiting" | "failed";
    /** Sessions still on the old version while `waiting`. */
    sessions: number | null;
    error: string | null;
    requestedAt: number;
  } | null;
  reportedAt: number | null;
};

/** A request the Runners page cannot make, with a message for the person who made it. */
export class RunnerAgentUpdateError extends Error {}

const NAMES: Record<string, string> = { claude: "Claude", codex: "Codex", grok: "Grok" };
const name = (agent: string) => NAMES[agent] ?? agent;
/** How people know an agent, such as "Claude" for `claude`. */
export const runnerAgentName = name;

/** Replace what the runner reported last, and drop each target it now runs. */
export async function recordRunnerAgents(
  store: Db,
  runnerId: string,
  agents: readonly RunnerAgentReport[],
  reportedAt: number,
): Promise<void> {
  await store.run((q) => recordRunnerAgentsSteps(q, runnerId, agents, reportedAt));
}

export function* recordRunnerAgentsSteps(
  q: Q,
  runnerId: string,
  agents: readonly RunnerAgentReport[],
  reportedAt: number,
) {
  const { runnerAgent, runnerAgentTarget } = q.t;
  yield* q.exec(q.orm.delete(runnerAgent).where(eq(runnerAgent.runnerId, runnerId)));
  for (const agent of agents)
    yield* q.exec(
      q.orm
        .insert(runnerAgent)
        .values({
          runnerId,
          agent: agent.agent,
          version: agent.version,
          status: agent.status,
          error: agent.status === "failed" ? (agent.error ?? null) : null,
          sessions: agent.status === "waiting" ? (agent.sessions ?? null) : null,
          targetId: agent.target ?? null,
          reportedAt,
        })
        .onConflictDoNothing({
          target: [runnerAgent.runnerId, runnerAgent.agent, runnerAgent.status],
        }),
    );
  yield* q.exec(
    q.orm.delete(runnerAgentTarget).where(
      and(
        eq(runnerAgentTarget.runnerId, runnerId),
        exists(
          q.orm
            .select({ one: sql`1` })
            .from(runnerAgent)
            .where(
              and(
                eq(runnerAgent.runnerId, runnerAgentTarget.runnerId),
                eq(runnerAgent.agent, runnerAgentTarget.agent),
                eq(runnerAgent.status, "current"),
                eq(runnerAgent.version, runnerAgentTarget.version),
              ),
            ),
        ),
      ),
    ),
  );
}

type TargetRecord = RunnerAgentTargetRow & { requestedAt: number };

function* targets(q: Q, runnerId: string) {
  const { runnerAgentTarget } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({
        id: runnerAgentTarget.id,
        agent: runnerAgentTarget.agent,
        version: runnerAgentTarget.version,
        integrity: runnerAgentTarget.integrity,
        nativeVersion: runnerAgentTarget.nativeVersion,
        packages: runnerAgentTarget.packages,
        requestedAt: runnerAgentTarget.requestedAt,
      })
      .from(runnerAgentTarget)
      .where(eq(runnerAgentTarget.runnerId, runnerId))
      .orderBy(runnerAgentTarget.agent),
  );
  return rows.map((row): TargetRecord => ({
    ...row,
    packages: parsedJson<CatalogPackage[]>(q, row.packages),
  }));
}

/**
 * Why Paws no longer sends a target, or null. It must still be eligible in the catalog with the
 * integrity it was chosen with.
 */
function* blocked(q: Q, target: TargetRecord) {
  const row = yield* readAgentVersionSteps(q, target.agent, target.version);
  if (!row || row.status !== "eligible" || row.integrity !== target.integrity)
    return `Paws no longer offers ${name(target.agent)} ${target.version}${row?.reason ? `: ${row.reason}` : "."}`;
  return null;
}

/** The targets the heartbeat reply carries: each one the catalog still allows. */
export async function runnerAgentTargets(
  store: Db,
  runnerId: string,
): Promise<RunnerAgentTargetRow[]> {
  return store.run((q) => runnerAgentTargetsSteps(q, runnerId));
}

export function* runnerAgentTargetsSteps(q: Q, runnerId: string) {
  const allowed: RunnerAgentTargetRow[] = [];
  for (const target of yield* targets(q, runnerId)) {
    if ((yield* blocked(q, target)) !== null) continue;
    const { id, agent, version, integrity, nativeVersion, packages } = target;
    allowed.push({ id, agent, version, integrity, nativeVersion, packages });
  }
  return allowed;
}

export async function listRunnerAgents(store: Db, runnerId: string): Promise<RunnerAgentView[]> {
  return store.run((q) => listRunnerAgentsSteps(q, runnerId));
}

export function* listRunnerAgentsSteps(q: Q, runnerId: string) {
  const { runnerAgent } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({
        agent: runnerAgent.agent,
        version: runnerAgent.version,
        status: sql<ReportedStatus>`${runnerAgent.status}`,
        error: runnerAgent.error,
        sessions: runnerAgent.sessions,
        targetId: runnerAgent.targetId,
        reportedAt: runnerAgent.reportedAt,
      })
      .from(runnerAgent)
      .where(eq(runnerAgent.runnerId, runnerId)),
  );
  const views = new Map<string, RunnerAgentView>();
  const view = (agent: string) => {
    let entry = views.get(agent);
    if (!entry)
      views.set(agent, (entry = { agent, current: null, pending: null, reportedAt: null }));
    return entry;
  };
  for (const row of rows) {
    const entry = view(row.agent);
    entry.reportedAt = Math.max(entry.reportedAt ?? 0, row.reportedAt);
    if (row.status === "current") entry.current = row.version;
  }
  for (const target of yield* targets(q, runnerId)) {
    const reported = rows.find(
      (row) =>
        row.agent === target.agent &&
        row.targetId === target.id &&
        (row.status === "installing" || row.status === "waiting" || row.status === "failed"),
    );
    const refusal = yield* blocked(q, target);
    view(target.agent).pending = {
      version: target.version,
      status: refusal ? "failed" : ((reported?.status as "installing") ?? "requested"),
      sessions: !refusal && reported?.status === "waiting" ? reported.sessions : null,
      error: refusal ?? (reported?.status === "failed" ? reported.error : null),
      requestedAt: target.requestedAt,
    };
  }
  return [...views.values()].sort((a, b) => a.agent.localeCompare(b.agent));
}

type Request = { workspaceId: string; userId: string; now: number; id: string };

function* activeRunner(q: Q, runnerId: string, workspaceId: string) {
  const { runner } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ id: runner.id })
      .from(runner)
      .where(
        and(
          eq(runner.id, runnerId),
          eq(runner.workspaceId, workspaceId),
          isNull(runner.revokedAt),
          ne(runner.status, "revoked"),
        ),
      ),
  );
  if (!row) throw new Error("Runner is unavailable.");
}

function* currentVersion(q: Q, runnerId: string, agent: string) {
  const { runnerAgent } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ version: runnerAgent.version })
      .from(runnerAgent)
      .where(
        and(
          eq(runnerAgent.runnerId, runnerId),
          eq(runnerAgent.agent, agent),
          eq(runnerAgent.status, "current"),
        ),
      ),
  );
  return row?.version ?? null;
}

function* saveTarget(
  q: Q,
  runnerId: string,
  target: RunnerAgentTargetRow,
  request: Omit<Request, "id">,
) {
  // The runner refuses a target without the native and platform packages to check.
  if (!target.packages.length)
    throw new RunnerAgentUpdateError(
      `Paws has no checked native build for ${name(target.agent)} ${target.version}, so it cannot send this version.`,
    );
  const { runnerAgentTarget } = q.t;
  const values = {
    id: target.id,
    version: target.version,
    integrity: target.integrity,
    nativeVersion: target.nativeVersion,
    packages: jsonValue(q, target.packages),
    requestedBy: request.userId,
    requestedAt: request.now,
  };
  yield* q.exec(
    q.orm
      .insert(runnerAgentTarget)
      .values({ runnerId, agent: target.agent, ...values })
      .onConflictDoUpdate({
        target: [runnerAgentTarget.runnerId, runnerAgentTarget.agent],
        set: values,
      }),
  );
  yield* auditWorkspaceAccessSteps(q, {
    workspaceId: request.workspaceId,
    userId: request.userId,
    action: "runner.agent_update",
    subject: `${runnerId}:${target.agent}@${target.version}`,
    now: request.now,
  });
}

/** Ask a runner to run `version` of `agent`. Only an eligible catalog version can be chosen. */
type UpdateRequest = Request & {
  runnerId: string;
  agent: string;
  version: string;
  catalogPackages: CatalogPackages;
};

export async function requestRunnerAgentUpdate(store: Db, input: UpdateRequest): Promise<void> {
  await store.transaction((q) => requestRunnerAgentUpdateSteps(q, input));
}

export function* requestRunnerAgentUpdateSteps(q: Q, input: UpdateRequest) {
  yield* activeRunner(q, input.runnerId, input.workspaceId);
  const current = yield* currentVersion(q, input.runnerId, input.agent);
  if (current === null)
    throw new RunnerAgentUpdateError(
      `This runner does not report ${name(input.agent)}. Update the runner package first.`,
    );
  const row = yield* readAgentVersionSteps(q, input.agent, input.version);
  if (!row || row.status !== "eligible")
    throw new RunnerAgentUpdateError(
      `${name(input.agent)} ${input.version} is not an eligible version${row?.reason ? `: ${row.reason}` : "."}`,
    );
  if (current === input.version)
    throw new RunnerAgentUpdateError(
      `This runner already runs ${name(input.agent)} ${input.version}.`,
    );
  yield* saveTarget(
    q,
    input.runnerId,
    {
      id: input.id,
      agent: input.agent,
      version: input.version,
      integrity: row.integrity,
      nativeVersion: row.nativeVersion,
      packages: yield* input.catalogPackages(q, input.agent, row.nativeVersion),
    },
    input,
  );
}

/**
 * Ask every active runner in the workspace to run the newest eligible version of each agent it
 * reports. Returns how many agents were asked to update.
 */
type UpdateAllRequest = Omit<Request, "id"> & {
  id: () => string;
  catalogPackages: CatalogPackages;
};

export async function requestAllRunnerAgentUpdates(
  store: Db,
  input: UpdateAllRequest,
): Promise<number> {
  return store.transaction((q) => requestAllRunnerAgentUpdatesSteps(q, input));
}

export function* requestAllRunnerAgentUpdatesSteps(q: Q, input: UpdateAllRequest) {
  const { runner, runnerAgent, runnerAgentTarget } = q.t;
  const offered = new Map(
    (yield* agentCatalogSummarySteps(q))
      .filter((entry) => entry.offered !== null)
      .map((entry) => [entry.agent, entry.offered!] as const),
  );
  const rows = yield* q.all(
    q.orm
      .select({
        runnerId: runnerAgent.runnerId,
        agent: runnerAgent.agent,
        version: runnerAgent.version,
      })
      .from(runnerAgent)
      .innerJoin(runner, eq(runner.id, runnerAgent.runnerId))
      .where(
        and(
          eq(runner.workspaceId, input.workspaceId),
          isNull(runner.revokedAt),
          ne(runner.status, "revoked"),
          eq(runnerAgent.status, "current"),
        ),
      )
      .orderBy(runnerAgent.runnerId, runnerAgent.agent),
  );
  let count = 0;
  for (const row of rows) {
    const version = offered.get(row.agent);
    // Only forward: a runner already on a newer version (one still inside its 48 hours, say)
    // is never moved back to the catalog's newest eligible one.
    if (!version || Bun.semver.order(version, row.version) <= 0) continue;
    const pending = yield* q.one(
      q.orm
        .select({ id: runnerAgentTarget.id, version: runnerAgentTarget.version })
        .from(runnerAgentTarget)
        .where(
          and(eq(runnerAgentTarget.runnerId, row.runnerId), eq(runnerAgentTarget.agent, row.agent)),
        ),
    );
    // A request on its way is left alone; a failed one is asked again under a new id, which
    // the installer treats as a new request.
    const failed =
      pending !== undefined &&
      (yield* q.one(
        q.orm
          .select({ one: sql`1` })
          .from(runnerAgent)
          .where(
            and(
              eq(runnerAgent.runnerId, row.runnerId),
              eq(runnerAgent.agent, row.agent),
              eq(runnerAgent.status, "failed"),
              eq(runnerAgent.targetId, pending.id),
            ),
          ),
      )) !== undefined;
    if (pending?.version === version && !failed) continue;
    const catalog = (yield* readAgentVersionSteps(q, row.agent, version))!;
    yield* saveTarget(
      q,
      row.runnerId,
      {
        id: input.id(),
        agent: row.agent,
        version,
        integrity: catalog.integrity,
        nativeVersion: catalog.nativeVersion,
        packages: yield* input.catalogPackages(q, row.agent, catalog.nativeVersion),
      },
      input,
    );
    count++;
  }
  return count;
}
