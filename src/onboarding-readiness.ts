import {
  memberVmForMemberSteps,
  onboardingAccountStatesSteps,
  runnerNameAndOwnerSteps,
  type Db,
} from "./db";
import { memberVmView } from "./member-vm";
import { eligibleRunnersSteps } from "./runner-placement";
import type { OnboardingAgent, OnboardingReadinessReader } from "./workspace";

const AGENTS = ["claude", "codex"] as const;

export function createOnboardingReadiness(store: Db): OnboardingReadinessReader {
  const runnerName = async (id: string) =>
    (await store.run((q) => runnerNameAndOwnerSteps(q, id)))?.name ?? id;
  return async ({ workspaceId, userId, teamId, now }) => {
    const runners = (
      await store.run((q) =>
        eligibleRunnersSteps(q, {
          workspaceId,
          teamId,
          ownerUserId: userId,
          leadUserIds: [],
          agent: "claude",
          purpose: "prepare",
          now,
        }),
      )
    ).filter((runner) => runner.ownerId === userId);
    const accounts = await store.run((q) => onboardingAccountStatesSteps(q, workspaceId, userId));
    const agentState = (runnerId: string, index: number): OnboardingAgent =>
      accounts.get(runnerId)?.[AGENTS[index]!] ?? "waiting";
    const vm = await store.run((q) => memberVmForMemberSteps(q, workspaceId, userId));
    const memberVm = vm !== null;
    const best = runners
      .filter((runner) => runner.eligible && runner.reason === "own")
      .map((runner) => ({
        runner,
        connected: AGENTS.filter((_, index) => agentState(runner.id, index) === "connected").length,
      }))
      .sort((a, b) => b.connected - a.connected)[0]?.runner;
    if (best) {
      return {
        runner: { state: "ready", id: best.id, name: await runnerName(best.id) },
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
    const down = runners.find(
      (runner) => runner.reason === "offline" || runner.reason === "paused",
    );
    if (down) {
      return {
        runner: {
          state: down.reason === "paused" ? "paused" : "offline",
          id: down.id,
          name: await runnerName(down.id),
        },
        agents: waiting,
        memberVm,
      };
    }
    return { runner: { state: "needed" }, agents: waiting, memberVm };
  };
}
