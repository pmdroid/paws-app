import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  immediate,
  listOnboardingRunners,
  memberGitHubRecord,
  readOnboardingVm,
  workspaceLinearMember,
} from "../db";
import type { WorkspaceAssignments } from "./assignments";
import { onboardingAgentsState, type OnboardingAgents } from "./onboarding-agents";
import type { createOnboardingPreparation, OnboardingPreparation } from "./onboarding-preparation";
import type {
  createMemberRepositoryAccess,
  TaskRepositoryAccessResult,
} from "./member-repository-access";

export type OnboardingReadinessContext = {
  sessionId: string;
  generation: number;
  workspaceId: string;
  linearUserId: string;
};
export type OnboardingReadiness = {
  revision: number;
  state: "waiting" | "unavailable" | "ready";
  reason: "metadata" | "vm" | "agents" | "github" | "authority_changed" | null;
  prepared: OnboardingPreparation | null;
  memberGitHub: TaskRepositoryAccessResult | null;
  expiresAt: number;
};
type Stored = {
  revision: number;
  owner: string;
  fingerprint: string;
  projection: string;
  expires_at: number;
};

export function createOnboardingReadiness(options: {
  db: Database;
  assignments: Pick<WorkspaceAssignments, "onboardingContext">;
  preparation: Pick<ReturnType<typeof createOnboardingPreparation>, "read">;
  access: Pick<ReturnType<typeof createMemberRepositoryAccess>, "checkScoped">;
  agents: OnboardingAgents;
  now?: () => number;
}) {
  const { db } = options;
  const now = options.now ?? Date.now;
  const owner = randomUUID();
  function stored(context: OnboardingReadinessContext) {
    return db
      .query<Stored, [string, number]>(
        "SELECT revision,owner,fingerprint,projection,expires_at FROM onboarding_readiness WHERE session_id=? AND generation=?",
      )
      .get(context.sessionId, context.generation);
  }
  function facts(context: OnboardingReadinessContext) {
    const member = workspaceLinearMember(db, context.workspaceId, context.linearUserId);
    if (!member?.active || member.role === "observer")
      throw new Error("Assignment membership unavailable.");
    const principal = {
      workspaceId: member.workspaceId,
      userId: member.userId,
      role: member.role,
      teamIds: member.teamIds,
      authenticatedAt: now(),
    };
    const scope = options.assignments.onboardingContext(
      context.sessionId,
      context.generation,
      principal,
    );
    if (!scope) throw new Error("Assignment unavailable.");
    const prepared = options.preparation.read(context);
    const runners = listOnboardingRunners(db, scope, now());
    const saved = readOnboardingVm(db, scope);
    const runner = saved
      ? runners.find((entry) => entry.id === saved.runnerId && entry.fence === saved.fence)
      : runners.length === 1
        ? runners[0]
        : undefined;
    const agents = onboardingAgentsState(
      db,
      options.assignments,
      options.agents,
      principal,
      { session: context.sessionId, generation: context.generation },
      now(),
    );
    const link = memberGitHubRecord(db, context.workspaceId, member.userId);
    const certificate = runner
      ? db
          .query<{ accepted_until: number; not_before: number; serial: string }, [string]>(
            "SELECT accepted_until,not_before,serial FROM runner_certificate WHERE runner_id=? ORDER BY rowid DESC LIMIT 1",
          )
          .get(runner.id)
      : null;
    const hold = db
      .query<{ fingerprint: string }, [string, number]>(
        "SELECT fingerprint FROM workspace_assignment WHERE session_id=? AND generation=?",
      )
      .get(context.sessionId, context.generation);
    const deadline = Math.min(
      certificate?.accepted_until ?? now(),
      prepared?.repositoryContext
        ? (link?.expiresAt ?? Number.MAX_SAFE_INTEGER)
        : Number.MAX_SAFE_INTEGER,
    );
    const fingerprint = JSON.stringify({
      context,
      scope,
      hold,
      prepared,
      runner,
      certificate,
      agents,
      link,
      member: { role: member.role, active: member.active, teams: member.teamIds },
    });
    return { fingerprint, deadline, scope, prepared, runner, agents, link, member };
  }
  function read(context: OnboardingReadinessContext): OnboardingReadiness | null {
    try {
      const row = stored(context);
      if (
        !row ||
        row.owner !== owner ||
        row.expires_at <= now() ||
        row.fingerprint !== facts(context).fingerprint
      )
        return null;
      return JSON.parse(row.projection) as OnboardingReadiness;
    } catch {
      return null;
    }
  }
  return {
    read,
    readyToContinue(context: OnboardingReadinessContext) {
      return read(context)?.state === "ready";
    },
    async refresh(
      context: OnboardingReadinessContext,
      signal: AbortSignal,
    ): Promise<OnboardingReadiness> {
      signal.throwIfAborted();
      const initial = facts(context);
      const base: OnboardingReadiness = {
        revision: 0,
        state: "waiting",
        reason: "metadata",
        prepared: initial.prepared,
        memberGitHub: null,
        expiresAt: initial.deadline,
      };
      const revision = immediate(db, () => {
        db.run(
          "INSERT INTO onboarding_readiness(session_id,generation,revision,owner,fingerprint,projection,expires_at) VALUES(?,?,1,?,?,?,?) ON CONFLICT(session_id,generation) DO UPDATE SET revision=revision+1,owner=excluded.owner,fingerprint=excluded.fingerprint,projection=excluded.projection,expires_at=excluded.expires_at",
          [
            context.sessionId,
            context.generation,
            owner,
            initial.fingerprint,
            JSON.stringify(base),
            initial.deadline,
          ],
        );
        return stored(context)!.revision;
      });
      const current = () =>
        stored(context)?.revision === revision &&
        stored(context)?.owner === owner &&
        facts(context).fingerprint === initial.fingerprint;
      const result = { ...base, revision };
      try {
        if (initial.prepared?.state !== "prepared") result.reason = "metadata";
        else if (!initial.runner) result.reason = "vm";
        else if (!initial.agents?.ready) result.reason = "agents";
        else {
          result.memberGitHub = await options.access.checkScoped(
            {
              workspaceId: context.workspaceId,
              organizationId: JSON.parse(
                db
                  .query<{ fingerprint: string }, [string, number]>(
                    "SELECT fingerprint FROM workspace_assignment WHERE session_id=? AND generation=?",
                  )
                  .get(context.sessionId, context.generation)!.fingerprint,
              ).installation.organizationId,
              userId: initial.member.userId,
              linearUserId: context.linearUserId,
              repository: initial.prepared.repository
                ? `${initial.prepared.repository.owner}/${initial.prepared.repository.repo}`
                : null,
              permission: initial.prepared.permission,
              account:
                initial.link?.githubId && initial.link.login
                  ? { id: initial.link.githubId, login: initial.link.login }
                  : null,
              current,
            },
            signal,
          );
          signal.throwIfAborted();
          result.state =
            result.memberGitHub.state === "ready"
              ? "ready"
              : result.memberGitHub.state === "unavailable"
                ? "unavailable"
                : "waiting";
          result.reason = result.state === "ready" ? null : "github";
        }
        immediate(db, () => {
          if (!current()) throw new Error("Readiness changed.");
          db.run(
            "UPDATE onboarding_readiness SET projection=? WHERE session_id=? AND generation=? AND revision=? AND owner=?",
            [JSON.stringify(result), context.sessionId, context.generation, revision, owner],
          );
        });
        return result;
      } catch {
        signal.throwIfAborted();
        return { ...result, state: "unavailable", reason: "authority_changed" };
      }
    },
  };
}
