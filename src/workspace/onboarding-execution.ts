import type { Database } from "bun:sqlite";
import {
  getLinearSession,
  getRun,
  getTaskMode,
  getTaskModeGeneration,
  getWorkItem,
  getWorkItemRepository,
  listOnboardingRunners,
  memberGitHubRecord,
  readOnboardingItemBinding,
  taskRequiresRepository,
  workspaceMember,
} from "../db";
import type { RepositoryBinding } from "../core";
import type { WorkspaceAssignments } from "./assignments";
import type { createMemberRepositoryAccess } from "./member-repository-access";
import { onboardingAgentsState, type OnboardingAgents } from "./onboarding-agents";

type Target = { runnerId?: string; workspaceId?: string; memberId?: string };
export type OnboardingExecution = ReturnType<typeof createOnboardingExecution>;

export function captureOnboardingExecution(
  db: Database,
  itemId: string | undefined,
  execution: Pick<OnboardingExecution, "capture"> | undefined,
  target?: Target,
) {
  if (!itemId || !readOnboardingItemBinding(db, itemId)) return null;
  if (!execution) throw new Error("Onboarding execution authority is unavailable.");
  const guard = execution.capture(itemId, target);
  if (!guard) throw new Error("Onboarding execution authority changed.");
  return guard;
}

export function createOnboardingExecution(options: {
  db: Database;
  assignments?: Pick<WorkspaceAssignments, "onboardingContext">;
  agents?: OnboardingAgents;
  access?: Pick<ReturnType<typeof createMemberRepositoryAccess>, "check">;
  now?: () => number;
}) {
  const { db } = options;
  const now = options.now ?? Date.now;
  function facts(itemId: string, target?: Target, publication = false) {
    const binding = readOnboardingItemBinding(db, itemId);
    if (!binding) throw new Error("Onboarding binding is unavailable.");
    const item = getWorkItem(db, itemId);
    const run = item?.currentRunId ? getRun(db, item.currentRunId) : null;
    const session = getLinearSession(db, binding.sessionId);
    const member = workspaceMember(db, binding.workspaceId, binding.userId);
    const owner = db
      .query<{ owner: string | null; actor: string | null }, [string]>(
        "SELECT owner_user_id AS owner,delegated_by AS actor FROM work_item WHERE id=?",
      )
      .get(itemId);
    if (
      !options.assignments ||
      !options.agents ||
      !item ||
      !item.currentRunId ||
      !run ||
      run.itemId !== itemId ||
      !(publication
        ? ["active", "provisioning", "ended"].includes(run.status) &&
          ["verifying", "merge_queue"].includes(item.state)
        : ["active", "provisioning"].includes(run.status)) ||
      item.cancelRequested ||
      ["cancelled", "completed", "merged"].includes(item.state) ||
      item.sessionKey !== binding.sessionId ||
      item.linearIssueId !== binding.issueId ||
      session?.generation !== binding.generation ||
      session.stoppedAt !== null ||
      owner?.owner !== binding.userId ||
      owner.actor !== binding.linearUserId ||
      !member?.active ||
      member.role === "observer" ||
      member.linearUserId !== binding.linearUserId ||
      getTaskMode(db, itemId) !== binding.mode ||
      getTaskModeGeneration(db, itemId) !== binding.generation ||
      taskRequiresRepository(db, itemId) !== binding.repositoryContext ||
      JSON.stringify(getWorkItemRepository(db, itemId)) !== JSON.stringify(binding.repository) ||
      binding.permission !==
        (binding.mode === "code" ? "push" : binding.repositoryContext ? "read" : null)
    )
      throw new Error("Onboarding execution context changed.");
    const principal = {
      workspaceId: member.workspaceId,
      userId: member.userId,
      role: member.role,
      teamIds: member.teamIds,
      authenticatedAt: now(),
    };
    const scope = options.assignments.onboardingContext(
      binding.sessionId,
      binding.generation,
      principal,
    );
    const agents = onboardingAgentsState(
      db,
      options.assignments,
      options.agents,
      principal,
      { session: binding.sessionId, generation: binding.generation },
      now(),
    );
    const runner = scope
      ? listOnboardingRunners(db, scope, now()).find(
          (entry) => entry.id === binding.runnerId && entry.fence === binding.runnerFence,
        )
      : undefined;
    if (
      !scope ||
      JSON.stringify(scope.issue) !== binding.issueFingerprint ||
      !runner ||
      !agents?.ready ||
      agents.runner?.id !== binding.runnerId ||
      (target?.runnerId !== undefined && target.runnerId !== binding.runnerId) ||
      (target?.workspaceId !== undefined && target.workspaceId !== binding.workspaceId) ||
      (target?.memberId !== undefined && target.memberId !== binding.userId)
    )
      throw new Error("Onboarding VM or agent readiness changed.");
    return {
      binding,
      fingerprint: JSON.stringify({
        binding,
        item: { version: item.version, run: item.currentRunId, state: item.state },
        run: { id: run.id, status: run.status },
        scope: {
          sessionId: scope.sessionId,
          generation: scope.generation,
          workspaceId: scope.workspaceId,
          userId: scope.userId,
          issue: scope.issue,
        },
        runner,
        agents,
        member: { role: member.role, active: member.active, teams: member.teamIds },
        github: memberGitHubRecord(db, binding.workspaceId, binding.userId),
      }),
    };
  }
  function capture(itemId: string, target?: Target) {
    if (!readOnboardingItemBinding(db, itemId)) return null;
    const before = facts(itemId, target);
    return {
      binding: before.binding,
      assertCurrent() {
        if (facts(itemId, target).fingerprint !== before.fingerprint)
          throw new Error("Onboarding execution authority changed.");
      },
    };
  }
  async function authorizeRepository<T>(
    itemId: string,
    repository: RepositoryBinding,
    access: "read" | "write",
    signal: AbortSignal,
    mint: (signal: AbortSignal) => Promise<T>,
    operation?: { signal: AbortSignal; assertCurrent(): void },
  ): Promise<T> {
    signal = operation ? AbortSignal.any([signal, operation.signal]) : signal;
    signal.throwIfAborted();
    operation?.assertCurrent();
    const before =
      operation && readOnboardingItemBinding(db, itemId) ? facts(itemId, undefined, true) : null;
    const guard = before
      ? {
          binding: before.binding,
          assertCurrent() {
            operation!.assertCurrent();
            if (facts(itemId, undefined, true).fingerprint !== before.fingerprint)
              throw new Error("Onboarding publication authority changed.");
          },
        }
      : capture(itemId);
    if (!guard) return mint(signal);
    const bound = guard.binding.repository;
    if (
      !bound ||
      bound.owner !== repository.owner ||
      bound.repo !== repository.repo ||
      bound.remoteUrl !== repository.remoteUrl ||
      (access === "write" ? guard.binding.permission !== "push" : !guard.binding.permission)
    )
      throw new Error("Onboarding repository authority changed.");
    const checkMember = async () => {
      if (!options.access) throw new Error("Member repository access is unavailable.");
      const result = await options.access.check(itemId, signal);
      signal.throwIfAborted();
      if (result.state !== "ready")
        throw new Error("Member GitHub repository access is not ready.");
      guard.assertCurrent();
    };
    await checkMember();
    guard.assertCurrent();
    const value = await mint(signal);
    signal.throwIfAborted();
    guard.assertCurrent();
    await checkMember();
    guard.assertCurrent();
    return value;
  }
  return {
    capture,
    authorizeRepository: <T>(
      itemId: string,
      repository: RepositoryBinding,
      access: "read" | "write",
      signal: AbortSignal,
      mint: (signal: AbortSignal) => Promise<T>,
    ) => authorizeRepository(itemId, repository, access, signal, mint),
    authorizePublicationRepository: <T>(
      itemId: string,
      repository: RepositoryBinding,
      access: "read" | "write",
      signal: AbortSignal,
      mint: (signal: AbortSignal) => Promise<T>,
      operation: { signal: AbortSignal; assertCurrent(): void },
    ) => authorizeRepository(itemId, repository, access, signal, mint, operation),
  };
}
