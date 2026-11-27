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
import { createIssueVmReplacer } from "./replace";
import { issueVmSpendLimitSteps } from "./spend";

export const ISSUE_VM_SWEEP_JOB = "issue-vm.sweep";
export const ISSUE_VM_SWEEP_EVERY_MS = 15_000;

const PROVIDER_ORDER: IssueVmProvider[] = ["host", "boat", "instabox"];
const AWAKE_ITEM_STATES = ["running", "verifying", "recovering"];
const KEEP_ITEM_STATES = [...AWAKE_ITEM_STATES, "queued"];
const LIVE = ["creating", "awake", "asleep", "unknown"];

export const ISSUE_VM_DRIVER_MISSING = "driver not available yet";

export type IssueVmPlacement = { runnerId: string } | { wait: string };

export type IssueVmDispatchInput = {
  workspaceId: string;
  itemId: string;
  memberUserId: string;
  providers: readonly IssueVmProvider[];
  now: number;
};

function* freeVmHostSteps(q: Q, workspaceId: string): Steps<string | null | undefined> {
  const hosts = yield* workspaceVmHostsSteps(q, workspaceId);
  if (hosts.length === 0) return undefined;
  for (const machine of hosts) {
    const inUse = (yield* liveHostIssueVmsSteps(q, machine.runnerId)).length;
    if (inUse < vmHostSlots(machine, machine.host).slots) return machine.runnerId;
  }
  return null;
}

export function* issueVmProviderSteps(
  q: Q,
  input: { workspaceId: string; providers: readonly IssueVmProvider[] },
): Steps<IssueVmProvider | null> {
  for (const provider of PROVIDER_ORDER) {
    if (provider === "host") {
      if (!input.providers.includes(provider)) continue;
      if ((yield* workspaceVmHostsSteps(q, input.workspaceId)).length > 0) return provider;
      continue;
    }
    const limit = yield* issueVmSpendLimitSteps(q, input.workspaceId);
    if (limit.prices[provider as "boat" | "instabox"] !== null) return provider;
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
  const latest = yield* latestItemIssueVmSteps(q, input.itemId);
  const kept = latest !== null && (LIVE.includes(latest.state) || latest.state === "failed");
  const provider =
    kept && input.providers.includes(latest.provider)
      ? latest.provider
      : yield* issueVmProviderSteps(q, input);
  if (provider === null) return null;
  if (!input.providers.includes(provider))
    return { wait: `Waiting for an issue VM: ${provider} ${ISSUE_VM_DRIVER_MISSING}` };
  let hostRunnerId: string | null = null;
  if (provider === "host" && !(latest !== null && LIVE.includes(latest.state))) {
    const free = yield* freeVmHostSteps(q, input.workspaceId);
    if (!free) return { wait: "Waiting for a free slot on a VM host" };
    hostRunnerId = free;
  }
  const { workspaceId, itemId, memberUserId, now } = input;
  const request = { workspaceId, itemId, memberUserId, provider, hostRunnerId, now };
  const readiness = yield* requestIssueVmAwakeSteps(q, request);
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
      yield* requestIssueVmAwakeSteps(q, {
        workspaceId: vm.workspaceId,
        itemId: vm.itemId,
        memberUserId: vm.memberUserId,
        provider: vm.provider,
        now,
      });
  }
}

export function createIssueVmSweep(
  store: Db,
  options: { drivers: Partial<Record<IssueVmProvider, IssueVmDriver>>; now?: () => number },
) {
  const now = options.now ?? Date.now;
  const lifecycle = createIssueVmLifecycle(store, options);
  const replacer = createIssueVmReplacer(store, options);
  return async () => {
    await store.transaction((q) => followIssueVmItemsSteps(q, now()));
    await lifecycle.sweep();
    await replacer.sweep().catch((error: unknown) => {
      journal(`issue_vm_replace_sweep_failed error=${JSON.stringify(errorText(error))}`);
    });
  };
}
