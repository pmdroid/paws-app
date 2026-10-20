import { createCommand, execCommand } from "./commands";
import { ProvisioningError } from "./types";
import type { CreateVm, ExeDev, ExecResult, ExecVm, ProviderOperation, Vm } from "./types";

export type FakeExeDev = ExeDev & {
  calls: (
    | { operation: "list" }
    | { operation: "create"; input: CreateVm }
    | { operation: "exec"; input: ExecVm }
  )[];
  vms: Map<string, Vm>;
  failures: Partial<Record<ProviderOperation, ProvisioningError[]>>;
  execResults: (ExecResult | ProvisioningError)[];
  loseNextCreateResponse: boolean;
};

export function createFakeExeDev(): FakeExeDev {
  function rejectQueued(operation: ProviderOperation) {
    const failure = fake.failures[operation]?.shift();
    if (failure) throw failure;
  }
  const fake: FakeExeDev = {
    calls: [],
    vms: new Map(),
    failures: {},
    execResults: [],
    loseNextCreateResponse: false,
    async listVms() {
      fake.calls.push({ operation: "list" });
      rejectQueued("list");
      return [...fake.vms.values()].map((vm) => ({ ...vm }));
    },
    async createVm(input) {
      createCommand(input);
      fake.calls.push({ operation: "create", input: { ...input } });
      rejectQueued("create");
      if (fake.vms.has(input.name)) throw new ProvisioningError("create", "http", "unknown", 422);
      const vm: Vm = {
        name: input.name,
        status: "starting",
        sshDestination: `vm+${input.name}@fake.invalid`,
        sshHost: "fake.invalid",
        sshUser: `vm+${input.name}`,
      };
      fake.vms.set(input.name, vm);
      if (fake.loseNextCreateResponse) {
        fake.loseNextCreateResponse = false;
        throw new ProvisioningError("create", "transport", "unknown");
      }
      return { ...vm };
    },
    async execVm(input) {
      execCommand(input);
      fake.calls.push({ operation: "exec", input: { ...input } });
      rejectQueued("exec");
      if (fake.vms.get(input.vmName)?.status !== "running")
        throw new ProvisioningError("exec", "http", "unknown", 422);
      const result = fake.execResults.shift();
      if (result instanceof ProvisioningError) throw result;
      if (!result) throw new ProvisioningError("exec", "incomplete_exec", "unknown");
      return { ...result };
    },
  };
  return fake;
}
