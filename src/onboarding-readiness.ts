import {
  memberVmForMemberSteps,
  onboardingAccountStatesSteps,
  runnerNameAndOwnerSteps,
  workspaceLinearMemberSteps,
  type Db,
} from "./db";
import { memberVmView } from "./member-vm";
import { eligibleRunnersSteps, type EligibleRunner } from "./runner-placement";
import type { OnboardingAgent, OnboardingReadinessReader } from "./workspace";

const AGENTS = ["claude", "codex"] as const;

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
    const accounts = await store.run((q) => onboardingAccountStatesSteps(q, workspaceId));
    const agentState = (runnerId: string, index: number): OnboardingAgent =>
      accounts.get(runnerId)?.[AGENTS[index]!] ?? "waiting";
    const vm = await store.run((q) => memberVmForMemberSteps(q, workspaceId, userId));
    const memberVm = vm !== null;
    const runners = await check("claude", "prepare");
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
