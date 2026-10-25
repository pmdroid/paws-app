import type { Database } from "bun:sqlite";
import { workspaceLinearMember } from "./db";
import { findMemberVm } from "./member-vm";
import { eligibleRunners, type EligibleRunner } from "./runner-placement";
import type { OnboardingAgent, OnboardingReadinessReader } from "./workspace";

const AGENTS = ["claude", "codex"] as const;

/**
 * The runner Paws would use for the member and their Claude and Codex sign-ins on it, for the
 * onboarding page. Uses the same eligibility check as placement: a runner the member owns, or one
 * a lead of the issue's Linear project shares. Another member's runner never counts. Reads SQLite
 * only, so reloading the page costs no Linear or GitHub request, and a runner that enrolls or a VM
 * that finishes shows as ready on the next reload.
 */
export function createOnboardingReadiness(db: Database): OnboardingReadinessReader {
  const runnerRow = (id: string) =>
    db
      .query<{ name: string; ownerName: string | null }, [string]>(
        "SELECT r.name,u.name AS ownerName FROM runner r LEFT JOIN workspace_user u ON u.id=r.owner_user_id WHERE r.id=?",
      )
      .get(id);
  const runnerName = (id: string) => runnerRow(id)?.name ?? id;
  return ({ workspaceId, userId, teamId, projectLeadIds, now }) => {
    const leadUserIds = [
      ...new Set(
        projectLeadIds.flatMap((linearUserId) => {
          const lead = workspaceLinearMember(db, workspaceId, linearUserId);
          return lead && lead.userId !== userId ? [lead.userId] : [];
        }),
      ),
    ].sort();
    const check = (agent: string, purpose: "prepare" | "work"): EligibleRunner[] =>
      eligibleRunners(db, {
        workspaceId,
        teamId,
        ownerUserId: userId,
        leadUserIds,
        agent,
        purpose,
        now,
      });
    const signIns = AGENTS.map(
      (agent) => new Map(check(agent, "work").map((runner) => [runner.id, runner])),
    );
    const agentState = (runnerId: string, index: number): OnboardingAgent => {
      const runner = signIns[index]!.get(runnerId);
      if (runner?.eligible) return "connected";
      return runner?.reason === "auth-expired" ? "expired" : "waiting";
    };
    const runners = check("claude", "prepare");
    // With several usable runners, show the one with the most agents signed in, the member's own
    // before a shared one.
    const best = runners
      .filter((runner) => runner.eligible)
      .map((runner) => ({
        runner,
        own: runner.reason === "own" ? 1 : 0,
        connected: AGENTS.filter((_, index) => agentState(runner.id, index) === "connected").length,
      }))
      .sort((a, b) => b.connected - a.connected || b.own - a.own)[0]?.runner;
    if (best) {
      const row = runnerRow(best.id);
      const name = row?.name ?? best.id;
      return {
        runner:
          best.reason === "lead-shared"
            ? { state: "ready", name, sharedBy: row?.ownerName ?? "your project lead" }
            : { state: "ready", name },
        agents: { claude: agentState(best.id, 0), codex: agentState(best.id, 1) },
      };
    }
    const waiting = { claude: "waiting", codex: "waiting" } as const;
    const vm = findMemberVm(db, { workspaceId, userId });
    if (vm && vm.failure !== null)
      return { runner: { state: "failed", name: vm.vmName, failure: vm.failure }, agents: waiting };
    if (vm && vm.step !== "ready")
      return { runner: { state: "setting-up", name: vm.vmName }, agents: waiting };
    // Only the member's own runner is theirs to start or resume.
    const stalled = runners.find(
      (runner) =>
        runner.ownerId === userId && (runner.reason === "offline" || runner.reason === "paused"),
    );
    if (stalled)
      return {
        runner: {
          state: stalled.reason === "paused" ? "paused" : "offline",
          name: runnerName(stalled.id),
        },
        agents: waiting,
      };
    return { runner: { state: "needed" }, agents: waiting };
  };
}
