import {
  memberVmForMemberSteps,
  runnerNameAndOwnerSteps,
  workspaceLinearMemberSteps,
  type Db,
} from "./db";
import { memberVmView } from "./member-vm";
import { eligibleRunnersSteps, type EligibleRunner } from "./runner-placement";
import type { OnboardingAgent, OnboardingReadinessReader } from "./workspace";

const AGENTS = ["claude", "codex"] as const;

/**
 * The runner Paws would use for the member and their Claude and Codex sign-ins on it, for the
 * onboarding page. Uses the same eligibility check as placement: a runner the member owns, or one
 * a lead of the issue's Linear project shares. Another member's runner never counts. When none is
 * eligible, it says why: the member's VM is being set up or failed, the member's runner or the
 * lead's shared runner is offline or paused, or the lead's runner isn't shared. Reads SQLite
 * only, so reloading the page costs no Linear or GitHub request, and a runner that enrolls or a
 * VM that finishes shows as ready on the next read.
 */
export function createOnboardingReadiness(store: Db): OnboardingReadinessReader {
  const runnerRow = (id: string) => store.run((q) => runnerNameAndOwnerSteps(q, id));
  const ownerName = async (id: string) => (await runnerRow(id))?.ownerName ?? "Your project lead";
  return async ({ workspaceId, userId, teamId, projectLeadIds, now }) => {
    const leads = new Set<string>();
    for (const linearUserId of projectLeadIds) {
      const lead = await store.run((q) => workspaceLinearMemberSteps(q, workspaceId, linearUserId));
      if (lead && lead.userId !== userId) leads.add(lead.userId);
    }
    const leadUserIds = [...leads].sort();
    const check = (agent: string, purpose: "prepare" | "work"): Promise<EligibleRunner[]> =>
      store.run((q) =>
        eligibleRunnersSteps(q, {
          workspaceId,
          teamId,
          ownerUserId: userId,
          leadUserIds,
          agent,
          purpose,
          now,
        }),
      );
    const signIns: Map<string, EligibleRunner>[] = [];
    for (const agent of AGENTS)
      signIns.push(new Map((await check(agent, "work")).map((runner) => [runner.id, runner])));
    const agentState = (runnerId: string, index: number): OnboardingAgent => {
      const runner = signIns[index]!.get(runnerId);
      if (runner?.eligible) return "connected";
      return runner?.reason === "auth-expired" ? "expired" : "waiting";
    };
    const vm = await store.run((q) => memberVmForMemberSteps(q, workspaceId, userId));
    const memberVm = vm !== null;
    const runners = await check("claude", "prepare");
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
      const name = (await runnerRow(best.id))?.name ?? best.id;
      return {
        runner:
          best.reason === "lead-shared"
            ? { state: "ready", id: best.id, name, sharedBy: await ownerName(best.id) }
            : { state: "ready", id: best.id, name },
        agents: { claude: agentState(best.id, 0), codex: agentState(best.id, 1) },
        memberVm,
      };
    }
    const waiting = { claude: "waiting", codex: "waiting" } as const;
    if (vm && (vm.failure !== null || vm.step !== "ready")) {
      const steps = memberVmView(vm, now).steps.map(({ step, state }) => ({ step, state }));
      return {
        runner:
          vm.failure !== null
            ? { state: "failed", name: vm.vmName, failure: vm.failure, steps }
            : { state: "setting-up", name: vm.vmName, steps },
        agents: waiting,
        memberVm,
      };
    }
    const stalled = (runner: EligibleRunner) =>
      runner.reason === "offline" || runner.reason === "paused";
    // The member's own runner first, then a runner the project lead shares.
    const own = runners.find((runner) => runner.ownerId === userId && stalled(runner));
    const shared = runners.find(
      (runner) => runner.sharing === 1 && leadUserIds.includes(runner.ownerId) && stalled(runner),
    );
    const down = own ?? shared;
    if (down) {
      const state = down.reason === "paused" ? "paused" : "offline";
      const name = (await runnerRow(down.id))?.name ?? down.id;
      return {
        runner:
          down === own
            ? { state, id: down.id, name }
            : { state, name, sharedBy: await ownerName(down.id) },
        agents: waiting,
        memberVm,
      };
    }
    const unshared = runners.find((runner) => runner.reason === "not-shared");
    return {
      runner: unshared
        ? { state: "needed", reason: `${await ownerName(unshared.id)}'s runner isn't shared.` }
        : { state: "needed" },
      agents: waiting,
      memberVm,
    };
  };
}
