import { vmSizeFor, type VmSizes } from "../config";
import { setIssueVmRunnerSteps, type Db } from "../db";
import { isProvisioningError, type EnrolledRunner, type ProviderVm } from "../provisioning";
import type { IssueVmDriver, IssueVmFound } from "./lifecycle";

export type ProviderIssueVmCreate = {
  name: string;
  key: string;
  snapshot: string;
  size: { cpu?: number; memoryGb?: number };
  mintToken: () => Promise<string>;
};

export type ProviderIssueVms = {
  create(input: ProviderIssueVmCreate): Promise<EnrolledRunner>;
  sleep(name: string): Promise<void>;
  wake(name: string): Promise<void>;
  remove(name: string): Promise<"deleted" | "missing">;
};

export type IssueVmDriverOptions = {
  store: Db;
  getVm(name: string): Promise<ProviderVm>;
  snapshot: string;
  vmSizes: () => VmSizes | undefined;
  mintToken: (id: string) => Promise<string>;
};

export const issueVmName = (id: string) => `paws-${id.toLowerCase()}`;

export function createProviderIssueVmDriver(
  provider: "boat" | "instabox",
  vms: ProviderIssueVms,
  options: IssueVmDriverOptions,
): IssueVmDriver {
  return {
    async create(id, call) {
      const runner = await vms.create({
        name: issueVmName(id),
        key: `paws-issue-vm-${id}`,
        snapshot: options.snapshot,
        size: vmSizeFor(options.vmSizes(), provider),
        mintToken: () => options.mintToken(id),
      });
      call.signal.throwIfAborted();
      await options.store.run((q) => setIssueVmRunnerSteps(q, { id, runnerId: runner.runnerId }));
    },
    wake: (id) => vms.wake(issueVmName(id)),
    sleep: (id) => vms.sleep(issueVmName(id)),
    async delete(id) {
      await vms.remove(issueVmName(id));
    },
    async reconcile(id): Promise<IssueVmFound> {
      const name = issueVmName(id);
      const vm = await options.getVm(name).catch((error: unknown) => {
        if (isProvisioningError(error) && error.code === "missing") return null;
        throw error;
      });
      if (vm === null || vm.state === "error") return "missing";
      if (vm.state === "running") return "awake";
      if (vm.state === "stopped") return "asleep";
      throw new Error(`${provider} reports ${name} as ${vm.status}, which has not settled`);
    },
  };
}
