import type { Database } from "bun:sqlite";
import {
  aliasedTable,
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  getTableColumns,
  gt,
  inArray,
  isNull,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { settled, sqliteDb, type Q, type Steps } from "./db";
import { jsonField } from "./json-text";
import { auditWorkspaceAccessSteps, workspaceMemberUsableWhere } from "./workspace";
import { endRevokedRunnerAuthoritySteps, runnerLeaseCutoff } from "./runner-lease";
import { conversationsInUseSteps, workHelperSql } from "./runner-capacity";
import {
  AGENT_USER_RUNNER_VERSION,
  runnerReleaseAtLeast,
  type RunnerAgentUser,
} from "../runner-protocol";
import type { RunnerSessionMove } from "./runner-session-moves";
import { listSkillsSteps, runnerSkillStatesSteps, type RunnerSkillView } from "./skills";
import { listRunnerRuntimesSteps, type RunnerRuntimeStatus } from "./runner-runtimes";
import { listRunnerAgentsSteps, type RunnerAgentView } from "./runner-agents";
import { runnerRepositoryListsSteps, type RunnerRepositoryLists } from "./runner-repositories";

export type RunnerRecord = {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  name: string;
  status: "active" | "paused" | "draining" | "revoked";
  fence: number;
};
type StoredRunnerCertificate = {
  fingerprint: string;
  serial: string;
  pem: string;
  notBefore: number;
  notAfter: number;
};

function runnerColumns({ t: { runner } }: Q) {
  return {
    id: runner.id,
    workspaceId: runner.workspaceId,
    ownerUserId: runner.ownerUserId,
    name: runner.name,
    status: sql<RunnerRecord["status"]>`${runner.status}`,
    fence: runner.fence,
  };
}

export function getRunner(db: Database, id: string): RunnerRecord | null {
  return settled(sqliteDb(db).run((q) => getRunnerSteps(q, id)));
}

export function* getRunnerSteps(q: Q, id: string): Steps<RunnerRecord | null> {
  const { runner } = q.t;
  const row = yield* q.one(q.orm.select(runnerColumns(q)).from(runner).where(eq(runner.id, id)));
  return row ?? null;
}

export function* listRunnersSteps(q: Q, workspaceId: string): Steps<RunnerRecord[]> {
  const { runner } = q.t;
  return yield* q.all(
    q.orm
      .select(runnerColumns(q))
      .from(runner)
      .where(eq(runner.workspaceId, workspaceId))
      .orderBy(runner.createdAt, runner.id),
  );
}

export type RunnerHostSample = {
  cpuPercent?: number;
  cpuCount?: number;
  memoryTotalBytes?: number;
  memoryAvailableBytes?: number;
  load1?: number;
  load5?: number;
  load15?: number;
  diskTotalBytes?: number;
  diskFreeBytes?: number;
  osId?: string;
  osVersion?: string;
  runnerVersion?: string;
  miseVersion?: string;
  /** Absent when the runner does not report them. */
  strayProcesses?: RunnerStrayProcess[];
  agentUser?: RunnerAgentUser;
};

/** A process of the runner user outside the runner's process tree, as last reported. */
export type RunnerStrayProcess = {
  pid: number;
  name: string;
  ageSeconds: number;
  cpuPercent: number;
};

type RunnerOverview = RunnerRecord & {
  hasRunWork: boolean;
  /** The owner's display name, so the Runners page can say whose host it is. */
  ownerName: string | null;
  metrics: {
    cpuPercent: number | null;
    cpuCount: number | null;
    memoryTotalBytes: number | null;
    memoryAvailableBytes: number | null;
    load1: number | null;
    load5: number | null;
    load15: number | null;
    diskTotalBytes: number | null;
    diskFreeBytes: number | null;
    /** Null when the runner release does not report them. */
    strayProcesses: RunnerStrayProcess[] | null;
    reportedAt: number;
  } | null;
  os: { id: string | null; version: string | null } | null;
  version: string | null;
  agentUser: RunnerAgentUser | null;
  idle: boolean;
  slots: { used: number; total: number };
  /** Desired is set in Paws; applied and ceiling are what the runner last reported. */
  concurrency: { desired: number | null; applied: number; ceiling: number | null } | null;
  conversations: { used: number; total: number } | null;
  /** Sessions holding a live work lease on this runner, oldest first. */
  running: RunnerSession[];
  skills: RunnerSkillView[];
  /** Runtimes mise installed for tasks on this runner, and failed installs, as last reported. */
  runtimes: RunnerRuntimeStatus[];
  /** Coding agent versions as last reported, and the version asked for from the Runners page. */
  codingAgents: RunnerAgentView[];
  repositories: RunnerRepositoryLists;
};

type RunnerSessionPhase = "working" | "closeout" | "fixing" | "merging";
type RunnerSession = {
  runId: string;
  identifier: string;
  title: string;
  phase: RunnerSessionPhase;
  startedAt: number;
  /** The runner can hand it over now: its work lease is live, not only its Closeout slot. */
  movable: boolean;
  /** Its move off this runner; null once it lands on another runner. */
  move: RunnerSessionMove | null;
};

/** 1 when the condition holds, else 0: a boolean is 0 or 1 on SQLite and true or false on Postgres. */
const flag = (condition: SQL | undefined) =>
  sql<number>`CASE WHEN ${condition} THEN 1 ELSE 0 END`.mapWith(Number);

function* listRunnerSessionsSteps(
  q: Q,
  workspaceId: string,
  now: number,
): Steps<Map<string, RunnerSession[]>> {
  const { closeoutProgress, run, runnerSessionMove: move, runnerWork: work, workItem: item } = q.t;
  const cutoff = runnerLeaseCutoff(now);
  const liveLease = and(isNull(work.endedAt), gt(work.leaseUntil, cutoff));
  const stage = jsonField(q, item.checkpoint, "phase");
  const progress = aliasedTable(closeoutProgress, "p");
  const latestDecision = q.orm
    .select({ decision: progress.decision })
    .from(progress)
    .where(eq(progress.itemId, item.id))
    .orderBy(
      desc(progress.updatedAt),
      q.dialect === "sqlite" ? sql`p.rowid DESC` : desc(progress.id),
    )
    .limit(1);
  const rows = yield* q.all(
    q.orm
      .select({
        runnerId: work.runnerId,
        runId: work.runId,
        identifier: item.linearIdentifier,
        title: item.title,
        phase: sql<RunnerSessionPhase>`CASE
          WHEN ${item.state}='verifying' OR ${stage}='verifying' THEN 'closeout'
          WHEN ${item.state}='merge_queue' OR ${stage}='merge_queue' THEN 'merging'
          WHEN ${latestDecision}='rejected' THEN 'fixing'
          ELSE 'working'
        END`,
        startedAt: run.createdAt,
        movable: flag(liveLease),
        moveStatus: sql<RunnerSessionMove["status"] | null>`${move.status}`,
        moveReason: move.reason,
      })
      .from(work)
      .innerJoin(run, eq(run.id, work.runId))
      .innerJoin(item, eq(item.id, run.itemId))
      .leftJoin(move, and(eq(move.runId, work.runId), eq(move.runnerId, work.runnerId)))
      .where(
        and(
          or(liveLease, inArray(run.status, ["active", "provisioning"])),
          eq(work.workspaceId, workspaceId),
        ),
      )
      .orderBy(run.createdAt, work.runId),
  );
  const sessions = new Map<string, RunnerSession[]>();
  for (const { runnerId, movable, moveStatus, moveReason, ...session } of rows)
    sessions.set(runnerId, [
      ...(sessions.get(runnerId) ?? []),
      {
        ...session,
        movable: movable === 1,
        move: moveStatus ? { status: moveStatus, reason: moveReason } : null,
      },
    ]);
  return sessions;
}

/** Keeps only the latest host sample per runner. */
export function recordRunnerHostStatus(
  db: Database,
  runnerId: string,
  sample: RunnerHostSample,
  reportedAt: number,
): void {
  settled(sqliteDb(db).run((q) => recordRunnerHostStatusSteps(q, runnerId, sample, reportedAt)));
}

export function* recordRunnerHostStatusSteps(
  q: Q,
  runnerId: string,
  sample: RunnerHostSample,
  reportedAt: number,
) {
  const { runnerHostStatus } = q.t;
  const values = {
    cpuPercent: sample.cpuPercent ?? null,
    cpuCount: sample.cpuCount ?? null,
    memoryTotalBytes: sample.memoryTotalBytes ?? null,
    memoryAvailableBytes: sample.memoryAvailableBytes ?? null,
    load1: sample.load1 ?? null,
    load5: sample.load5 ?? null,
    load15: sample.load15 ?? null,
    diskTotalBytes: sample.diskTotalBytes ?? null,
    diskFreeBytes: sample.diskFreeBytes ?? null,
    osId: sample.osId ?? null,
    osVersion: sample.osVersion ?? null,
    runnerVersion: sample.runnerVersion ?? null,
    miseVersion: sample.miseVersion ?? null,
    strayProcesses: sample.strayProcesses ? JSON.stringify(sample.strayProcesses) : null,
    agentUser: sample.agentUser ?? null,
    reportedAt,
  };
  yield* q.exec(
    q.orm
      .insert(runnerHostStatus)
      .values({ runnerId, ...values })
      .onConflictDoUpdate({ target: runnerHostStatus.runnerId, set: values }),
  );
}

export type RunnerAgentLimit = { window: string; usedPercent: number; resetsAt: number | null };

type RunnerAgentUsageReport = {
  runnerId: string;
  agent: string;
  limits: RunnerAgentLimit[];
  observedAt: number;
};

export function recordRunnerAgentUsage(db: Database, usage: RunnerAgentUsageReport): void {
  settled(sqliteDb(db).run((q) => recordRunnerAgentUsageSteps(q, usage)));
}

export function* recordRunnerAgentUsageSteps(q: Q, usage: RunnerAgentUsageReport) {
  const { runnerAgentUsage: stored } = q.t;
  const limitsJson = JSON.stringify(usage.limits);
  yield* q.exec(
    q.orm
      .insert(stored)
      .values({
        runnerId: usage.runnerId,
        agent: usage.agent,
        limitsJson,
        observedAt: usage.observedAt,
      })
      .onConflictDoUpdate({
        target: [stored.runnerId, stored.agent],
        set: { limitsJson, observedAt: usage.observedAt },
        setWhere: sql`excluded.observed_at>=${stored.observedAt}`,
      }),
  );
}

export function runnerAgentUsage(
  db: Database,
  runnerId: string,
  agent: string,
): { limits: RunnerAgentLimit[]; observedAt: number } | null {
  return settled(sqliteDb(db).run((q) => runnerAgentUsageSteps(q, runnerId, agent)));
}

export function* runnerAgentUsageSteps(q: Q, runnerId: string, agent: string) {
  const { runnerAgentUsage: stored } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ limits: stored.limitsJson, observedAt: stored.observedAt })
      .from(stored)
      .where(and(eq(stored.runnerId, runnerId), eq(stored.agent, agent))),
  );
  return row
    ? { limits: JSON.parse(row.limits) as RunnerAgentLimit[], observedAt: row.observedAt }
    : null;
}

/** Runners with their latest host sample. Idle means no open work and no pending command. */
export function listRunnerOverview(
  db: Database,
  workspaceId: string,
  now: number,
): RunnerOverview[] {
  return settled(sqliteDb(db).run((q) => listRunnerOverviewSteps(q, workspaceId, now)));
}

export function* listRunnerOverviewSteps(
  q: Q,
  workspaceId: string,
  now: number,
): Steps<RunnerOverview[]> {
  const {
    run,
    runner,
    runnerCapacity: capacity,
    runnerCommand: command,
    runnerHelper: helper,
    runnerHostStatus: host,
    runnerWork: work,
    workspaceUser: owner,
  } = q.t;
  const cutoff = runnerLeaseCutoff(now);
  const sessions = yield* listRunnerSessionsSteps(q, workspaceId, now);
  const pins = yield* listSkillsSteps(q);
  const conversations = yield* conversationsInUseSteps(
    q,
    (yield* listRunnersSteps(q, workspaceId)).map((entry) => entry.id),
    now,
  );
  const one = { one: sql`1` };
  const onRunner = eq(work.runnerId, runner.id);
  const commandOnRunner = eq(command.runnerId, runner.id);
  const helperOnRunner = eq(helper.runnerId, runner.id);
  const workSlots = q.orm
    .select({ used: count() })
    .from(work)
    .innerJoin(run, eq(run.id, work.runId))
    .where(
      and(
        onRunner,
        or(
          and(isNull(work.endedAt), gt(work.leaseUntil, cutoff)),
          inArray(run.status, ["active", "provisioning"]),
        ),
      ),
    );
  const helperSlots = q.orm
    .select({ used: count() })
    .from(helper)
    .where(
      and(
        helperOnRunner,
        isNull(helper.endedAt),
        gt(helper.expiresAt, now),
        workHelperSql(q, "runner_helper"),
      ),
    );
  const least = q.dialect === "sqlite" ? sql`MIN` : sql`LEAST`;
  const rows = yield* q.all(
    q.orm
      .select({
        ...runnerColumns(q),
        hasRunWork: flag(
          or(
            exists(q.orm.select(one).from(work).where(onRunner)),
            exists(
              q.orm
                .select(one)
                .from(command)
                .where(
                  and(commandOnRunner, inArray(command.kind, ["run", "review", "check", "task"])),
                ),
            ),
            exists(q.orm.select(one).from(helper).where(helperOnRunner)),
          ),
        ),
        cpuPercent: host.cpuPercent,
        cpuCount: host.cpuCount,
        memoryTotalBytes: host.memoryTotalBytes,
        memoryAvailableBytes: host.memoryAvailableBytes,
        load1: host.load1,
        load5: host.load5,
        load15: host.load15,
        diskTotalBytes: host.diskTotalBytes,
        diskFreeBytes: host.diskFreeBytes,
        osId: host.osId,
        osVersion: host.osVersion,
        runnerVersion: host.runnerVersion,
        strayProcesses: host.strayProcesses,
        agentUser: sql<RunnerAgentUser | null>`${host.agentUser}`,
        reportedAt: host.reportedAt,
        busy: flag(
          or(
            exists(
              q.orm
                .select(one)
                .from(work)
                .where(and(onRunner, isNull(work.endedAt))),
            ),
            exists(
              q.orm
                .select(one)
                .from(command)
                .where(
                  and(commandOnRunner, isNull(command.acknowledgedAt), gt(command.expiresAt, now)),
                ),
            ),
          ),
        ),
        used: sql<number>`${workSlots} + ${helperSlots}`.mapWith(Number),
        // LEAST ignores a NULL where SQLite's MIN returns it, so a runner with no capacity row is
        // decided before either runs.
        total: sql<number>`CASE WHEN ${capacity.capacity} IS NULL THEN 1
          ELSE ${least}(${capacity.capacity},COALESCE(${capacity.desired},16)) END`.mapWith(Number),
        applied: capacity.capacity,
        ceiling: capacity.ceiling,
        desired: capacity.desired,
        conversation: capacity.conversation,
        ownerName: owner.name,
      })
      .from(runner)
      .leftJoin(host, eq(host.runnerId, runner.id))
      .leftJoin(capacity, eq(capacity.runnerId, runner.id))
      .leftJoin(owner, eq(owner.id, runner.ownerUserId))
      .where(eq(runner.workspaceId, workspaceId))
      .orderBy(runner.createdAt, runner.id),
  );
  const overview: RunnerOverview[] = [];
  for (const row of rows)
    overview.push({
      id: row.id,
      workspaceId: row.workspaceId,
      ownerUserId: row.ownerUserId,
      ownerName: row.ownerName,
      hasRunWork: row.hasRunWork === 1,
      name: row.name,
      status: row.status,
      fence: row.fence,
      metrics:
        row.reportedAt === null
          ? null
          : {
              cpuPercent: row.cpuPercent,
              cpuCount: row.cpuCount,
              memoryTotalBytes: row.memoryTotalBytes,
              memoryAvailableBytes: row.memoryAvailableBytes,
              load1: row.load1,
              load5: row.load5,
              load15: row.load15,
              diskTotalBytes: row.diskTotalBytes,
              diskFreeBytes: row.diskFreeBytes,
              strayProcesses:
                row.strayProcesses === null
                  ? null
                  : (JSON.parse(row.strayProcesses) as RunnerStrayProcess[]),
              reportedAt: row.reportedAt,
            },
      os:
        row.osId === null && row.osVersion === null
          ? null
          : { id: row.osId, version: row.osVersion },
      version: row.runnerVersion,
      agentUser:
        row.agentUser ??
        (row.runnerVersion !== null &&
        !runnerReleaseAtLeast(row.runnerVersion, AGENT_USER_RUNNER_VERSION)
          ? "runner"
          : null),
      idle: row.busy === 0,
      slots: { used: row.used, total: row.total },
      conversations:
        row.conversation === null
          ? null
          : { used: conversations.get(row.id) ?? 0, total: row.conversation },
      concurrency:
        row.applied === null
          ? null
          : { desired: row.desired, applied: row.applied, ceiling: row.ceiling },
      running: sessions.get(row.id) ?? [],
      skills: yield* runnerSkillStatesSteps(q, row.id, pins),
      runtimes: yield* listRunnerRuntimesSteps(q, row.id),
      codingAgents: yield* listRunnerAgentsSteps(q, row.id),
      repositories: yield* runnerRepositoryListsSteps(q, row.id),
    });
  return overview;
}

export function runnerForCertificate(
  db: Database,
  fingerprint: string,
  now: number,
): RunnerRecord | null {
  return settled(sqliteDb(db).run((q) => runnerForCertificateSteps(q, fingerprint, now)));
}

export function* runnerForCertificateSteps(
  q: Q,
  fingerprint: string,
  now: number,
): Steps<RunnerRecord | null> {
  const { runner, runnerCertificate: certificate, workspaceMember: member } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ id: runner.id })
      .from(certificate)
      .innerJoin(runner, eq(runner.id, certificate.runnerId))
      .innerJoin(
        member,
        and(eq(member.workspaceId, runner.workspaceId), eq(member.userId, runner.ownerUserId)),
      )
      .where(
        and(
          eq(certificate.fingerprint, fingerprint),
          isNull(certificate.revokedAt),
          lte(certificate.notBefore, now),
          gt(certificate.acceptedUntil, now),
          isNull(runner.revokedAt),
          ne(runner.status, "revoked"),
          workspaceMemberUsableWhere(member),
        ),
      ),
  );
  return row ? yield* getRunnerSteps(q, row.id) : null;
}

function* insertCertificateSteps(q: Q, runnerId: string, certificate: StoredRunnerCertificate) {
  yield* q.exec(
    q.orm.insert(q.t.runnerCertificate).values({
      fingerprint: certificate.fingerprint,
      serial: certificate.serial,
      runnerId,
      pem: certificate.pem,
      notBefore: certificate.notBefore,
      notAfter: certificate.notAfter,
      acceptedUntil: certificate.notAfter,
    }),
  );
}

type RunnerEnrollmentRequest = {
  id: string;
  tokenHash: string;
  workspaceId: string;
  userId: string;
  name: string;
  expiresAt: number;
  now: number;
};

export function createRunnerEnrollment(db: Database, input: RunnerEnrollmentRequest): void {
  settled(sqliteDb(db).transaction((q) => createRunnerEnrollmentSteps(q, input)));
}

export function* createRunnerEnrollmentSteps(q: Q, input: RunnerEnrollmentRequest) {
  const { runnerEnrollment: enrollment } = q.t;
  yield* q.exec(
    q.orm
      .delete(enrollment)
      .where(and(isNull(enrollment.usedAt), lte(enrollment.expiresAt, input.now))),
  );
  const pending = yield* q.one(
    q.orm
      .select({ count: count() })
      .from(enrollment)
      .where(
        and(
          eq(enrollment.workspaceId, input.workspaceId),
          isNull(enrollment.usedAt),
          gt(enrollment.expiresAt, input.now),
        ),
      ),
  );
  if (pending!.count >= 100) throw new Error("Too many runner enrollments. Try again shortly.");
  yield* q.exec(
    q.orm.insert(enrollment).values({
      id: input.id,
      tokenHash: input.tokenHash,
      workspaceId: input.workspaceId,
      userId: input.userId,
      name: input.name,
      expiresAt: input.expiresAt,
    }),
  );
}

type RunnerEnrollment = {
  id: string;
  workspaceId: string;
  userId: string;
  name: string;
  expiresAt: number;
};

/**
 * The unused, unexpired enrollment for `tokenHash` whose member is still active, or null.
 */
export function findRunnerEnrollment(
  db: Database,
  tokenHash: string,
  now: number,
): RunnerEnrollment | null {
  return settled(sqliteDb(db).run((q) => findRunnerEnrollmentSteps(q, tokenHash, now)));
}

export function* findRunnerEnrollmentSteps(
  q: Q,
  tokenHash: string,
  now: number,
): Steps<RunnerEnrollment | null> {
  const { runnerEnrollment: enrollment, workspaceMember: member } = q.t;
  const row = yield* q.one(
    q.orm
      .select({
        id: enrollment.id,
        workspaceId: enrollment.workspaceId,
        userId: enrollment.userId,
        name: enrollment.name,
        expiresAt: enrollment.expiresAt,
      })
      .from(enrollment)
      .innerJoin(
        member,
        and(eq(member.workspaceId, enrollment.workspaceId), eq(member.userId, enrollment.userId)),
      )
      .where(
        and(
          eq(enrollment.tokenHash, tokenHash),
          isNull(enrollment.usedAt),
          isNull(enrollment.runnerId),
          gt(enrollment.expiresAt, now),
          workspaceMemberUsableWhere(member),
        ),
      ),
  );
  return row ?? null;
}

type RunnerEnrollInput = {
  tokenHash: string;
  runnerId: string;
  name: string;
  certificate: StoredRunnerCertificate;
  now: number;
};

/**
 * Use an enrollment: create the runner owned by the enrollment's member, store its certificate,
 * mark the token used and audit `runner.paired` with that member as actor. Throws, writing
 * nothing, when the token is used, expired or its member may no longer own a runner.
 */
export function enrollRunner(db: Database, input: RunnerEnrollInput): RunnerEnrollment {
  return settled(sqliteDb(db).transaction((q) => enrollRunnerSteps(q, input)));
}

export function* enrollRunnerSteps(q: Q, input: RunnerEnrollInput): Steps<RunnerEnrollment> {
  const { runner, runnerEnrollment } = q.t;
  const enrollment = yield* findRunnerEnrollmentSteps(q, input.tokenHash, input.now);
  if (!enrollment) throw new Error("Runner enrollment is invalid or expired.");
  yield* q.exec(
    q.orm.insert(runner).values({
      id: input.runnerId,
      workspaceId: enrollment.workspaceId,
      ownerUserId: enrollment.userId,
      name: input.name,
      status: "paused",
      createdAt: input.now,
    }),
  );
  yield* insertCertificateSteps(q, input.runnerId, input.certificate);
  const used = yield* q.all(
    q.orm
      .update(runnerEnrollment)
      .set({ usedAt: input.now, runnerId: input.runnerId })
      .where(and(eq(runnerEnrollment.id, enrollment.id), isNull(runnerEnrollment.usedAt)))
      .returning({ id: runnerEnrollment.id }),
  );
  if (used.length !== 1) throw new Error("Runner enrollment is invalid or expired.");
  yield* auditWorkspaceAccessSteps(q, {
    workspaceId: enrollment.workspaceId,
    userId: enrollment.userId,
    action: "runner.paired",
    subject: input.runnerId,
    now: input.now,
  });
  return enrollment;
}

export function isCurrentRunnerCertificate(db: Database, fingerprint: string): boolean {
  return settled(sqliteDb(db).run((q) => isCurrentRunnerCertificateSteps(q, fingerprint)));
}

/** The latest certificate is the last one written; Postgres has no rowid, so the newest by validity. */
export function* isCurrentRunnerCertificateSteps(q: Q, fingerprint: string): Steps<boolean> {
  const { runnerCertificate: certificate } = q.t;
  const latest = aliasedTable(certificate, "latest");
  const latestFingerprint = q.orm
    .select({ fingerprint: latest.fingerprint })
    .from(latest)
    .where(eq(latest.runnerId, certificate.runnerId))
    .orderBy(
      ...(q.dialect === "sqlite"
        ? [sql`latest.rowid DESC`]
        : [desc(latest.notBefore), desc(latest.fingerprint)]),
    )
    .limit(1);
  const row = yield* q.one(
    q.orm
      .select({ fingerprint: certificate.fingerprint })
      .from(certificate)
      .where(
        and(
          eq(certificate.fingerprint, fingerprint),
          sql`${certificate.fingerprint}=${latestFingerprint}`,
        ),
      ),
  );
  return row !== undefined;
}

type RunnerCertificateRenewal = {
  previousFingerprint: string;
  certificate: StoredRunnerCertificate;
  now: number;
};

export function renewRunnerCertificate(
  db: Database,
  input: RunnerCertificateRenewal,
): RunnerRecord {
  return settled(sqliteDb(db).transaction((q) => renewRunnerCertificateSteps(q, input)));
}

export function* renewRunnerCertificateSteps(
  q: Q,
  input: RunnerCertificateRenewal,
): Steps<RunnerRecord> {
  const { runnerCertificate } = q.t;
  const owner = yield* runnerForCertificateSteps(q, input.previousFingerprint, input.now);
  if (!owner) throw new Error("Runner identity is revoked or expired.");
  if (!(yield* isCurrentRunnerCertificateSteps(q, input.previousFingerprint)))
    throw new Error("Runner certificate has been superseded.");
  const least = q.dialect === "sqlite" ? sql`MIN` : sql`LEAST`;
  yield* q.exec(
    q.orm
      .update(runnerCertificate)
      .set({
        acceptedUntil: sql`${least}(${runnerCertificate.acceptedUntil},${input.now + 5 * 60_000})`,
      })
      .where(eq(runnerCertificate.fingerprint, input.previousFingerprint)),
  );
  yield* insertCertificateSteps(q, owner.id, input.certificate);
  yield* auditWorkspaceAccessSteps(q, {
    workspaceId: owner.workspaceId,
    userId: owner.ownerUserId,
    action: "runner.certificate.renewed",
    subject: owner.id,
    now: input.now,
  });
  return owner;
}

type RunnerStatusUpdate = {
  runnerId: string;
  workspaceId: string;
  userId: string;
  status: RunnerRecord["status"];
  now: number;
};

export function updateRunnerStatus(db: Database, input: RunnerStatusUpdate): string[] {
  return settled(sqliteDb(db).transaction((q) => updateRunnerStatusSteps(q, input)));
}

export function* updateRunnerStatusSteps(q: Q, input: RunnerStatusUpdate): Steps<string[]> {
  const { memberVm, runner, runnerCertificate } = q.t;
  const revoked = input.status === "revoked";
  const changed = yield* q.all(
    q.orm
      .update(runner)
      .set({
        status: input.status,
        revokedAt: revoked ? input.now : null,
        ...(revoked ? { fence: sql`${runner.fence}+1` } : {}),
      })
      .where(
        and(
          eq(runner.id, input.runnerId),
          eq(runner.workspaceId, input.workspaceId),
          isNull(runner.revokedAt),
        ),
      )
      .returning({ id: runner.id }),
  );
  if (changed.length !== 1) throw new Error("Runner is unavailable.");
  const certificates = yield* q.all(
    q.orm
      .select({ fingerprint: runnerCertificate.fingerprint })
      .from(runnerCertificate)
      .where(
        and(eq(runnerCertificate.runnerId, input.runnerId), isNull(runnerCertificate.revokedAt)),
      ),
  );
  if (revoked) {
    yield* q.exec(
      q.orm
        .update(runnerCertificate)
        .set({ revokedAt: input.now })
        .where(eq(runnerCertificate.runnerId, input.runnerId)),
    );
    yield* q.exec(
      q.orm
        .update(memberVm)
        .set({ runnerId: null, updatedAt: input.now })
        .where(eq(memberVm.runnerId, input.runnerId)),
    );
    yield* endRevokedRunnerAuthoritySteps(q, input.now);
  }
  yield* auditWorkspaceAccessSteps(q, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    action: `runner.${input.status}`,
    subject: input.runnerId,
    now: input.now,
  });
  return revoked ? certificates.map((row) => row.fingerprint) : [];
}

export function runRunnerName(db: Database, runId: string): string | null {
  return settled(sqliteDb(db).run((q) => runRunnerNameSteps(q, runId)));
}

export function* runRunnerNameSteps(q: Q, runId: string) {
  const { runner, runnerWork } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ name: runner.name })
      .from(runnerWork)
      .innerJoin(runner, eq(runner.id, runnerWork.runnerId))
      .where(eq(runnerWork.runId, runId)),
  );
  return row?.name ?? null;
}

export type RunnerAvailability = {
  id: string;
  name: string;
  status: RunnerRecord["status"];
  revoked: boolean;
  lastSeenAt: number | null;
};

/** The runner that holds a run's remote work, as last reported. */
export function runRunnerAvailability(db: Database, runId: string): RunnerAvailability | null {
  return settled(sqliteDb(db).run((q) => runRunnerAvailabilitySteps(q, runId)));
}

export function* runRunnerAvailabilitySteps(q: Q, runId: string): Steps<RunnerAvailability | null> {
  const { runner, runnerWork } = q.t;
  const row = yield* q.one(
    q.orm
      .select({
        id: runner.id,
        name: runner.name,
        status: sql<RunnerRecord["status"]>`${runner.status}`,
        revokedAt: runner.revokedAt,
        lastSeenAt: runner.lastSeenAt,
      })
      .from(runnerWork)
      .innerJoin(runner, eq(runner.id, runnerWork.runnerId))
      .where(eq(runnerWork.runId, runId)),
  );
  if (!row) return null;
  const { revokedAt, ...availability } = row;
  return { ...availability, revoked: revokedAt !== null };
}

export function storedRunnerName(db: Database, id: string): string | null {
  return settled(sqliteDb(db).run((q) => storedRunnerNameSteps(q, id)));
}

export function* storedRunnerNameSteps(q: Q, id: string) {
  const { runner } = q.t;
  const row = yield* q.one(
    q.orm.select({ name: runner.name }).from(runner).where(eq(runner.id, id)),
  );
  return row?.name ?? null;
}

export function runnerHostVersion(db: Database, runnerId: string): string | null {
  return settled(sqliteDb(db).run((q) => runnerHostVersionSteps(q, runnerId)));
}

export function* runnerHostVersionSteps(q: Q, runnerId: string) {
  const { runnerHostStatus } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ version: runnerHostStatus.runnerVersion })
      .from(runnerHostStatus)
      .where(eq(runnerHostStatus.runnerId, runnerId)),
  );
  return row?.version ?? null;
}

export function runnerTargetForRestore(
  db: Database,
  runnerId: string,
): { ownerUserId: string; version: string | null } | null {
  return settled(sqliteDb(db).run((q) => runnerTargetForRestoreSteps(q, runnerId)));
}

export function* runnerTargetForRestoreSteps(q: Q, runnerId: string) {
  const { runner, runnerHostStatus } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ ownerUserId: runner.ownerUserId, version: runnerHostStatus.runnerVersion })
      .from(runner)
      .leftJoin(runnerHostStatus, eq(runnerHostStatus.runnerId, runner.id))
      .where(eq(runner.id, runnerId)),
  );
  return row ?? null;
}

export function runnerStanding(
  db: Database,
  runnerId: string,
): { status: string; revokedAt: number | null; lastSeenAt: number | null } | null {
  return settled(sqliteDb(db).run((q) => runnerStandingSteps(q, runnerId)));
}

export function* runnerStandingSteps(q: Q, runnerId: string) {
  const { runner } = q.t;
  const row = yield* q.one(
    q.orm
      .select({
        status: runner.status,
        revokedAt: runner.revokedAt,
        lastSeenAt: runner.lastSeenAt,
      })
      .from(runner)
      .where(eq(runner.id, runnerId)),
  );
  return row ?? null;
}

export function runnerOwner(
  db: Database,
  runnerId: string,
): { workspaceId: string; userId: string } | null {
  return settled(sqliteDb(db).run((q) => runnerOwnerSteps(q, runnerId)));
}

export function* runnerOwnerSteps(q: Q, runnerId: string) {
  const { runner } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ workspaceId: runner.workspaceId, userId: runner.ownerUserId })
      .from(runner)
      .where(eq(runner.id, runnerId)),
  );
  return row ?? null;
}

export function recentRunners(
  db: Database,
  seenAfter: number,
): { id: string; workspaceId: string }[] {
  return settled(sqliteDb(db).run((q) => recentRunnersSteps(q, seenAfter)));
}

export function* recentRunnersSteps(q: Q, seenAfter: number) {
  const { runner } = q.t;
  return yield* q.all(
    q.orm
      .select({ id: runner.id, workspaceId: runner.workspaceId })
      .from(runner)
      .where(
        and(
          eq(runner.status, "active"),
          isNull(runner.revokedAt),
          gt(runner.lastSeenAt, seenAfter),
        ),
      )
      .orderBy(desc(runner.lastSeenAt), runner.id),
  );
}

export type UsableRunner = {
  workspaceId: string;
  userId: string;
  fence: number;
  status: string;
};

/** The runner, unless it is revoked or its owner can no longer use the workspace. */
export function* usableRunnerSteps(q: Q, runnerId: string): Steps<UsableRunner | null> {
  const { runner, workspaceMember: member } = q.t;
  const row = yield* q.one(
    q.orm
      .select({
        workspaceId: runner.workspaceId,
        userId: runner.ownerUserId,
        fence: runner.fence,
        status: runner.status,
      })
      .from(runner)
      .innerJoin(
        member,
        and(eq(member.workspaceId, runner.workspaceId), eq(member.userId, runner.ownerUserId)),
      )
      .where(
        and(
          eq(runner.id, runnerId),
          isNull(runner.revokedAt),
          ne(runner.status, "revoked"),
          workspaceMemberUsableWhere(member),
        ),
      ),
  );
  return row ?? null;
}

export function usableRunner(db: Database, runnerId: string): UsableRunner | null {
  return settled(sqliteDb(db).run((q) => usableRunnerSteps(q, runnerId)));
}

export type RunnerIdentity = {
  workspaceId: string;
  ownerId: string;
  status: string;
  fence: number;
  revokedAt: number | null;
  lastSeenAt: number | null;
};

/** The runner's workspace, owner, standing and fence. */
export function runnerIdentity(db: Database, runnerId: string): RunnerIdentity | null {
  return settled(sqliteDb(db).run((q) => runnerIdentitySteps(q, runnerId)));
}

export function* runnerIdentitySteps(q: Q, runnerId: string): Steps<RunnerIdentity | null> {
  const { runner } = q.t;
  const row = yield* q.one(
    q.orm
      .select({
        workspaceId: runner.workspaceId,
        ownerId: runner.ownerUserId,
        status: runner.status,
        fence: runner.fence,
        revokedAt: runner.revokedAt,
        lastSeenAt: runner.lastSeenAt,
      })
      .from(runner)
      .where(eq(runner.id, runnerId)),
  );
  return row ?? null;
}

function runSteps<T>(db: Database, body: (q: Q) => Steps<T>): T {
  return settled(sqliteDb(db).run(body));
}

/** The newest usage row first when `ended_at` or `started_at` ties. */
const usageNewest = (q: Q) =>
  q.dialect === "sqlite"
    ? sql`runner_execution_usage.rowid DESC`
    : desc(q.t.runnerExecutionUsage.commandId);

/** What placement admitted a runner against: its identity, policy, capacity and owner's standing. */
export function* runnerPlacementPolicySteps(q: Q, runnerId: string, agent?: string) {
  const {
    runner,
    runnerAgentPolicy,
    runnerCapacity,
    runnerPolicy,
    workspaceMember,
    workspaceUserTeam,
  } = q.t;
  const identity = yield* q.one(
    q.orm
      .select({
        id: runner.id,
        workspaceId: runner.workspaceId,
        ownerUserId: runner.ownerUserId,
        status: runner.status,
        fence: runner.fence,
        revokedAt: runner.revokedAt,
      })
      .from(runner)
      .where(eq(runner.id, runnerId)),
  );
  const host = yield* q.one(
    q.orm
      .select({ runnerId: runnerPolicy.runnerId, sharing: runnerPolicy.sharing })
      .from(runnerPolicy)
      .where(eq(runnerPolicy.runnerId, runnerId)),
  );
  const capacity = yield* q.one(
    q.orm
      .select({
        capacity: runnerCapacity.capacity,
        ceiling: runnerCapacity.ceiling,
        desired: runnerCapacity.desired,
      })
      .from(runnerCapacity)
      .where(eq(runnerCapacity.runnerId, runnerId)),
  );
  const agentPolicy = agent
    ? yield* q.one(
        q.orm
          .select()
          .from(runnerAgentPolicy)
          .where(and(eq(runnerAgentPolicy.runnerId, runnerId), eq(runnerAgentPolicy.agent, agent))),
      )
    : null;
  const membership = yield* q.one(
    q.orm
      .select(getTableColumns(workspaceMember))
      .from(workspaceMember)
      .innerJoin(
        runner,
        and(
          eq(runner.workspaceId, workspaceMember.workspaceId),
          eq(runner.ownerUserId, workspaceMember.userId),
        ),
      )
      .where(eq(runner.id, runnerId)),
  );
  const teams = yield* q.all(
    q.orm
      .select(getTableColumns(workspaceUserTeam))
      .from(workspaceUserTeam)
      .innerJoin(
        runner,
        and(
          eq(runner.workspaceId, workspaceUserTeam.workspaceId),
          eq(runner.ownerUserId, workspaceUserTeam.userId),
        ),
      )
      .where(eq(runner.id, runnerId))
      .orderBy(asc(workspaceUserTeam.teamId)),
  );
  return {
    runner: identity ?? null,
    host: host ?? null,
    capacity: capacity ?? null,
    agent: agentPolicy ?? null,
    membership: membership ?? null,
    teams,
  };
}

export function runnerPlacementPolicy(db: Database, runnerId: string, agent?: string) {
  return runSteps(db, (q) => runnerPlacementPolicySteps(q, runnerId, agent));
}

/** Start and end of each execution on a runner that ended in `(from, to]`. */
export function* runnerExecutionHistorySteps(q: Q, runnerId: string, from: number, to: number) {
  const { runnerExecutionUsage: u } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({ startedAt: u.startedAt, endedAt: u.endedAt })
      .from(u)
      .where(and(eq(u.runnerId, runnerId), gt(u.endedAt, from), lte(u.endedAt, to))),
  );
  return rows.map((row) => ({ startedAt: row.startedAt, endedAt: row.endedAt as number }));
}

export function runnerExecutionHistory(
  db: Database,
  runnerId: string,
  from: number,
  to: number,
): { startedAt: number; endedAt: number }[] {
  return runSteps(db, (q) => runnerExecutionHistorySteps(q, runnerId, from, to));
}

/** The runner and resolved model of an item's latest successful implementer turn. */
export function* lastSuccessfulImplementationSteps(q: Q, itemId: string) {
  const { runnerExecutionUsage: u } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ runnerId: u.runnerId, model: u.resolvedModel })
      .from(u)
      .where(
        and(
          eq(u.itemId, itemId),
          eq(u.role, "implementer"),
          eq(u.purpose, "work"),
          eq(u.outcome, "success"),
        ),
      )
      .orderBy(desc(u.endedAt), usageNewest(q))
      .limit(1),
  );
  return row ?? null;
}

export function lastSuccessfulImplementation(
  db: Database,
  itemId: string,
): { runnerId: string; model: string | null } | null {
  return runSteps(db, (q) => lastSuccessfulImplementationSteps(q, itemId));
}

export function* runnerAgentQuotaSteps(q: Q, runnerId: string, agent: string) {
  const { runnerAgentPolicy: p } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ cooldownUntil: p.cooldownUntil, quotaState: p.quotaState })
      .from(p)
      .where(and(eq(p.runnerId, runnerId), eq(p.agent, agent))),
  );
  return row ?? null;
}

export function runnerAgentQuota(
  db: Database,
  runnerId: string,
  agent: string,
): { cooldownUntil: number; quotaState: string } | null {
  return runSteps(db, (q) => runnerAgentQuotaSteps(q, runnerId, agent));
}

/** Charge one placement to a runner's agent, creating its policy row on first use. */
export function* chargeRunnerAgentSteps(
  q: Q,
  input: { runnerId: string; agent: string; at: number },
) {
  const { runnerAgentPolicy: p } = q.t;
  yield* q.exec(
    q.orm.insert(p).values({ runnerId: input.runnerId, agent: input.agent }).onConflictDoNothing(),
  );
  yield* q.exec(
    q.orm
      .update(p)
      .set({
        virtualFinish: sql`${p.virtualFinish}+CASE WHEN ${p.quotaState}='low' THEN 5 ELSE 1 END`,
        lastUsedAt: input.at,
      })
      .where(and(eq(p.runnerId, input.runnerId), eq(p.agent, input.agent))),
  );
}

export function chargeRunnerAgent(
  db: Database,
  input: { runnerId: string; agent: string; at: number },
): void {
  runSteps(db, (q) => chargeRunnerAgentSteps(q, input));
}

export type RunnerExecutionStart = {
  commandId: string;
  runnerId: string;
  ownerUserId: string;
  itemId: string | null;
  runId: string | null;
  agent: string | null;
  model: string | null;
  role: string;
  purpose: string;
  startedAt: number;
  placementReason: string | null;
};

export function* insertRunnerExecutionUsageSteps(q: Q, input: RunnerExecutionStart) {
  yield* q.exec(q.orm.insert(q.t.runnerExecutionUsage).values(input));
}

export function insertRunnerExecutionUsage(db: Database, input: RunnerExecutionStart): void {
  runSteps(db, (q) => insertRunnerExecutionUsageSteps(q, input));
}

/** The usage receipt a finished command settles, or null when it is not this runner's. */
export function* runnerExecutionReceiptSteps(q: Q, commandId: string, runnerId: string) {
  const { runnerExecutionUsage: u } = q.t;
  const row = yield* q.one(
    q.orm
      .select({
        ownerId: u.ownerUserId,
        purpose: u.purpose,
        agent: u.agent,
        itemId: u.itemId,
        role: u.role,
        startedAt: u.startedAt,
        endedAt: u.endedAt,
        outcome: u.outcome,
        resetsAt: u.resetsAt,
      })
      .from(u)
      .where(and(eq(u.commandId, commandId), eq(u.runnerId, runnerId))),
  );
  return row ?? null;
}

export function runnerExecutionReceipt(db: Database, commandId: string, runnerId: string) {
  return runSteps(db, (q) => runnerExecutionReceiptSteps(q, commandId, runnerId));
}

export type RunnerExecutionFinish = {
  commandId: string;
  endedAt: number;
  outcome: string;
  resolvedModel: string | null;
  outputBytes: number;
  resetsAt: number | null;
};

export function* finishRunnerExecutionUsageSteps(q: Q, input: RunnerExecutionFinish) {
  const { runnerExecutionUsage: u } = q.t;
  const { commandId, ...finished } = input;
  yield* q.exec(q.orm.update(u).set(finished).where(eq(u.commandId, commandId)));
}

export function finishRunnerExecutionUsage(db: Database, input: RunnerExecutionFinish): void {
  runSteps(db, (q) => finishRunnerExecutionUsageSteps(q, input));
}

export type RunnerAgentSettlement = {
  runnerId: string;
  agent: string;
  authRequired: boolean;
  success: boolean;
  quota: { state: string; resetsAt: number | null; cooldownUntil: number } | null;
  /** A successful non-preparation turn clears a recorded quota limit. */
  clearQuota: boolean;
  model: string | null;
};

/** Apply what a finished turn showed about the runner's agent; anything it did not show stays. */
export function* settleRunnerAgentSteps(q: Q, input: RunnerAgentSettlement) {
  const { runnerAgentPolicy: p } = q.t;
  const { authRequired, success, quota, clearQuota, model } = input;
  yield* q.exec(
    q.orm
      .update(p)
      .set({
        ready: authRequired ? 0 : success ? 1 : p.ready,
        authExpired: authRequired ? 1 : success ? 0 : p.authExpired,
        quotaState: quota ? quota.state : clearQuota ? "ok" : p.quotaState,
        resetsAt: quota ? quota.resetsAt : clearQuota ? null : p.resetsAt,
        cooldownUntil: quota ? quota.cooldownUntil : clearQuota ? 0 : p.cooldownUntil,
        resolvedModel: model ?? p.resolvedModel,
      })
      .where(and(eq(p.runnerId, input.runnerId), eq(p.agent, input.agent))),
  );
}

export function settleRunnerAgent(db: Database, input: RunnerAgentSettlement): void {
  runSteps(db, (q) => settleRunnerAgentSteps(q, input));
}

export function* setRunnerAgentCooldownSteps(
  q: Q,
  runnerId: string,
  agent: string,
  cooldownUntil: number,
) {
  const { runnerAgentPolicy: p } = q.t;
  yield* q.exec(
    q.orm
      .update(p)
      .set({ cooldownUntil })
      .where(and(eq(p.runnerId, runnerId), eq(p.agent, agent))),
  );
}

export function setRunnerAgentCooldown(
  db: Database,
  runnerId: string,
  agent: string,
  cooldownUntil: number,
): void {
  runSteps(db, (q) => setRunnerAgentCooldownSteps(q, runnerId, agent, cooldownUntil));
}
