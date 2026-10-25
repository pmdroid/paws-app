import type { Database } from "bun:sqlite";
import { findMemberVm } from "./member-vm";
import { eligibleRunners, type EligibleRunner } from "./runner-placement";
import type { OnboardingAgent, OnboardingReadinessReader } from "./workspace";

const AGENTS = ["claude", "codex"] as const;

/**
 * The member's own runner and their Claude and Codex sign-ins on it, for the onboarding page.
 * Uses the same eligibility check as placement, limited to runners the member owns. Reads SQLite
 * only, so reloading the page costs no Linear or GitHub request.
 */
export function createOnboardingReadiness(db: Database): OnboardingReadinessReader {
  const runnerName = (id: string) =>
    db.query<{ name: string }, [string]>("SELECT name FROM runner WHERE id=?").get(id)?.name ?? id;
  return ({ workspaceId, userId, teamId, now }) => {
    const own = (agent: string, purpose: "prepare" | "work"): EligibleRunner[] =>
      eligibleRunners(db, {
        workspaceId,
        teamId,
        ownerUserId: userId,
        leadUserIds: [],
        agent,
        purpose,
        now,
      }).filter((runner) => runner.ownerId === userId);
    const signIns = AGENTS.map((agent) => new Map(own(agent, "work").map((r) => [r.id, r])));
    const agentState = (runnerId: string, index: number): OnboardingAgent => {
      const runner = signIns[index]!.get(runnerId);
      if (runner?.eligible) return "connected";
      return runner?.reason === "auth-expired" ? "expired" : "waiting";
    };
    const owned = own("claude", "prepare");
    const usable = owned.filter((runner) => runner.eligible);
    // With several usable runners, show the one with the most agents signed in.
    const best = usable
      .map((runner) => ({
        runner,
        connected: AGENTS.filter((_, index) => agentState(runner.id, index) === "connected").length,
      }))
      .sort((a, b) => b.connected - a.connected)[0]?.runner;
    if (best)
      return {
        runner: { state: "ready", name: runnerName(best.id) },
        agents: { claude: agentState(best.id, 0), codex: agentState(best.id, 1) },
      };
    const waiting = { claude: "waiting", codex: "waiting" } as const;
    const vm = findMemberVm(db, { workspaceId, userId });
    if (vm && vm.failure !== null)
      return { runner: { state: "failed", name: vm.vmName, failure: vm.failure }, agents: waiting };
    if (vm && vm.step !== "ready")
      return { runner: { state: "setting-up", name: vm.vmName }, agents: waiting };
    const stalled = owned.find(
      (runner) => runner.reason === "offline" || runner.reason === "paused",
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
