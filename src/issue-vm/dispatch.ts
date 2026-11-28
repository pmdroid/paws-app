import {
  errorText,
  latestItemIssueVmSteps,
  liveHostIssueVmsSteps,
  liveIssueVmItemsSteps,
  workspaceVmHostsSteps,
  type Db,
  type IssueVmProvider,
  type Q,
  type Steps,
  type VmHostMachine,
  type VmHostRow,
} from "../db";
import { journal } from "../journal";
import { vmHostSlots } from "../vm-hosts";
import type { IssueVmAdmission } from "./admission";
import {
  createIssueVmLifecycle,
  requestIssueVmAsleepSteps,
  requestIssueVmAwakeSteps,
  type IssueVmDriver,
} from "./lifecycle";
import { createHostIssueVmDriver } from "./host";
import { createIssueVmDeleter } from "./delete";
import { createIssueVmReplacer } from "./replace";

export const ISSUE_VM_SWEEP_JOB = "issue-vm.sweep";
export const ISSUE_VM_SWEEP_EVERY_MS = 15_000;

const AWAKE_ITEM_STATES = ["running", "verifying", "recovering"];
const KEEP_ITEM_STATES = [...AWAKE_ITEM_STATES, "queued"];
const LIVE = ["creating", "awake", "asleep", "unknown"];

type IssueVmPlacement = { runnerId: string } | { wait: string };

type IssueVmDispatchInput = {
  workspaceId: string;
  itemId: string;
  memberUserId: string;
  providers: readonly IssueVmProvider[];
  now: number;
};

function* freeVmHostSteps(q: Q, machines: (VmHostMachine & { host: VmHostRow })[]) {
  for (const machine of machines) {
    const inUse = (yield* liveHostIssueVmsSteps(q, machine.runnerId)).length;
    if (inUse < vmHostSlots(machine, machine.host).slots) return machine.runnerId;
  }
  return null;
}

function refusalLine(refusal: Exclude<IssueVmAdmission, { ok: true }>): string {
  if ("message" in refusal) return `Waiting for an issue VM: ${refusal.message}`;
  const whose = refusal.reason === "member_limit" ? "its owner" : "the workspace";
  return `Waiting for an issue VM: ${whose} already has ${refusal.inUse} of ${refusal.limit}`;
}

export function* issueVmPlacementSteps(
  q: Q,
  input: IssueVmDispatchInput,
): Steps<IssueVmPlacement | null> {
  if (!input.providers.includes("host")) return null;
  const latest = yield* latestItemIssueVmSteps(q, input.itemId);
  const kept = latest !== null && latest.provider === "host" && LIVE.includes(latest.state);
  const replacing = latest !== null && latest.provider === "host" && latest.state === "failed";
  let hostRunnerId: string | null = null;
  if (!kept && !replacing) {
    if ((yield* workspaceVmHostsSteps(q, input.workspaceId)).length === 0) return null;
    const hosts = yield* workspaceVmHostsSteps(q, input.workspaceId, input.now);
    if (hosts.length === 0) return { wait: "Waiting for a VM host to come online" };
    hostRunnerId = yield* freeVmHostSteps(q, hosts);
    if (hostRunnerId === null) return { wait: "Waiting for a free slot on a VM host" };
  }
  const { workspaceId, itemId, memberUserId, now } = input;
  const request = { workspaceId, itemId, memberUserId, provider: "host" as const, now };
  const readiness = yield* requestIssueVmAwakeSteps(q, { ...request, hostRunnerId });
  if (!readiness.ok)
    return {
      wait:
        readiness.reason === "failed"
          ? "Waiting for its issue VM to be replaced"
          : refusalLine(readiness.refusal),
    };
  const { vm } = readiness;
  if (!readiness.ready || vm.runnerId === null)
    return {
      wait:
        vm.state === "creating"
          ? "Waiting for its issue VM to be created"
          : vm.state === "deleting"
            ? "Waiting for its old issue VM to be deleted"
            : "Waiting for its issue VM to wake",
    };
  return { runnerId: vm.runnerId };
}

export function* followIssueVmItemsSteps(q: Q, now: number) {
  for (const { vm, itemState } of yield* liveIssueVmItemsSteps(q)) {
    if (!KEEP_ITEM_STATES.includes(itemState)) {
      if (yield* requestIssueVmAsleepSteps(q, { itemId: vm.itemId }))
        journal(`issue_vm_sleep_requested vm=${vm.id} item=${vm.itemId} state=${itemState}`);
    } else if (AWAKE_ITEM_STATES.includes(itemState) && vm.want === "asleep")
      yield* requestIssueVmAwakeSteps(q, { ...vm, now });
  }
}

export type IssueVmDrivers = Partial<Record<IssueVmProvider, IssueVmDriver>>;

export function createIssueVmDrivers(store: Db, override?: IssueVmDrivers): IssueVmDrivers {
  return override ?? { host: createHostIssueVmDriver({ store }) };
}

export function createIssueVmSweep(
  store: Db,
  options: { drivers: IssueVmDrivers; now?: () => number },
) {
  const now = options.now ?? Date.now;
  const lifecycle = createIssueVmLifecycle(store, options);
  const replacer = createIssueVmReplacer(store, options);
  const deleter = createIssueVmDeleter(store, options);
  return async () => {
    await deleter.claim();
    await store.transaction((q) => followIssueVmItemsSteps(q, now()));
    await Promise.all([lifecycle.sweep(), deleter.sweep()]);
    await replacer.sweep().catch((error: unknown) => {
      journal(`issue_vm_replace_sweep_failed error=${JSON.stringify(errorText(error))}`);
    });
  };
}
