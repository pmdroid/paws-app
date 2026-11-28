import type { VmSizes } from "../config";
import {
  createRunnerEnrollmentSteps,
  issueVmByIdSteps,
  issueVmProviderIdSteps,
  markIssueVmTokenMintedSteps,
  setIssueVmProviderIdSteps,
  workspaceMemberSteps,
  workspaceMemberUsable,
  type Db,
} from "../db";
import type {
  BoatProvider,
  BootstrapClock,
  ExeDevBootstrap,
  InstaBox,
  ProviderVm,
} from "../provisioning";
import { workspaceId, workspaceSecret, workspaceTokenHash } from "../workspace";
import { createBoatIssueVmDriver, createBoatIssueVms } from "./boat";
import { createInstaBoxIssueVmDriver, createInstaBoxIssueVms } from "./instabox";
import type { IssueVmDriver } from "./lifecycle";
import { issueVmSpendLimitSteps, type PricedIssueVmProvider } from "./spend";
import { createStartQueue } from "./start-queue";

const ENROLLMENT_MS = 10 * 60_000;
const STARTS_PER_MINUTE = 10;
const NAME = /^paws-([0-9a-z]{26})$/;

export type CloudIssueVmDriverOptions = {
  store: Db;
  boat: BoatProvider;
  instaBox: InstaBox;
  readToken: (provider: PricedIssueVmProvider) => string | null | Promise<string | null>;
  bootstrap: (provider: PricedIssueVmProvider) => Promise<ExeDevBootstrap>;
  vmSizes: () => VmSizes | undefined;
  now?: () => number;
  clock?: BootstrapClock;
};

export async function issueVmProviderVmId(store: Db, name: string): Promise<string | null> {
  const id = NAME.exec(name)?.[1];
  if (id === undefined) return null;
  return store.run((q) => issueVmProviderIdSteps(q, id.toUpperCase()));
}

function lazyBootstrap(load: () => Promise<ExeDevBootstrap>): ExeDevBootstrap {
  return {
    startInstall: async (vm, token) => (await load()).startInstall(vm, token),
    installStatus: async (vm) => (await load()).installStatus(vm),
    stageToken: async (vm, token) => (await load()).stageToken(vm, token),
    joinTailnet: async (vm) => (await load()).joinTailnet(vm),
    enroll: async (vm) => (await load()).enroll(vm),
    startRunner: async (vm) => (await load()).startRunner(vm),
    resetIdentity: async (vm) => (await load()).resetIdentity(vm),
  };
}

export function createCloudIssueVmDrivers(
  options: CloudIssueVmDriverOptions,
): Record<PricedIssueVmProvider, IssueVmDriver> {
  const { store } = options;
  const now = options.now ?? Date.now;
  const queue = createStartQueue({
    startsPerMinute: STARTS_PER_MINUTE,
    ...(options.clock ? { clock: options.clock } : {}),
  });

  async function remember(name: string, providerVmId: string) {
    const id = NAME.exec(name)?.[1];
    if (id === undefined) throw new Error(`${name} is not an issue VM name`);
    await store.run((q) => setIssueVmProviderIdSteps(q, { id: id.toUpperCase(), providerVmId }));
  }

  async function snapshot(provider: PricedIssueVmProvider, id: string) {
    const name = await store.run(function* (q) {
      const vm = yield* issueVmByIdSteps(q, id);
      if (vm === null) return null;
      return (yield* issueVmSpendLimitSteps(q, vm.workspaceId)).snapshots[provider];
    });
    if (name === null)
      throw new Error(`No ${provider} snapshot is set for issue VMs on Settings › Issue VMs`);
    return name;
  }

  async function mintToken(id: string) {
    const at = now();
    const token = workspaceSecret();
    await store.transaction(function* (q) {
      const vm = yield* issueVmByIdSteps(q, id);
      if (vm === null) throw new Error(`There is no issue VM ${id}`);
      const member = yield* workspaceMemberSteps(q, vm.workspaceId, vm.memberUserId);
      if (!workspaceMemberUsable(member))
        throw new Error(`The owner of issue VM ${id} is no longer a workspace member`);
      yield* createRunnerEnrollmentSteps(q, {
        id: workspaceId(at),
        tokenHash: workspaceTokenHash(token),
        workspaceId: vm.workspaceId,
        userId: vm.memberUserId,
        name: `paws-vm-${id.toLowerCase()}`,
        expiresAt: at + ENROLLMENT_MS,
        now: at,
        issueVmId: id,
      });
      yield* markIssueVmTokenMintedSteps(q, { id, now: at });
    });
    return token;
  }

  const shared = (
    provider: PricedIssueVmProvider,
    getVm: (name: string) => Promise<ProviderVm>,
  ) => ({
    store,
    getVm,
    snapshot: (id: string) => snapshot(provider, id),
    vmSizes: options.vmSizes,
    mintToken,
  });

  const vms = (provider: PricedIssueVmProvider) => ({
    bootstrap: lazyBootstrap(() => options.bootstrap(provider)),
    queue,
    readToken: () => options.readToken(provider),
    remember,
    ...(options.clock ? { clock: options.clock } : {}),
  });

  const checked = (provider: PricedIssueVmProvider, driver: IssueVmDriver): IssueVmDriver => ({
    ...driver,
    async create(id, call) {
      await options.bootstrap(provider);
      await snapshot(provider, id);
      return driver.create(id, call);
    },
  });

  return {
    boat: checked(
      "boat",
      createBoatIssueVmDriver(
        createBoatIssueVms({ boat: options.boat, ...vms("boat") }),
        shared("boat", (name) => options.boat.getVm(name)),
      ),
    ),
    instabox: checked(
      "instabox",
      createInstaBoxIssueVmDriver(
        createInstaBoxIssueVms({ instaBox: options.instaBox, ...vms("instabox") }),
        shared("instabox", (name) => options.instaBox.getVm(name)),
      ),
    ),
  };
}
