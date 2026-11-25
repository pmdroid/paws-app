import { getRunnerSteps, liveHostIssueVmsSteps, vmHostMachineSteps, type Db } from "../db";
import { vmHostSlots } from "./slots";

export type VmHostRunnerView =
  | { vmHost: false }
  | {
      vmHost: true;
      slots: number;
      size: { vcpus: number; memoryGb: number };
      vms: { id: string; state: string }[];
    };

export async function handleVmHostRunnerRequest(
  request: Request,
  runnerId: string,
  db: Db,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== "/v1/issue-vms") return null;
  if (request.method !== "GET") return Response.json({ error: "Use GET." }, { status: 405 });
  const view = await db.run(function* (q) {
    const runner = yield* getRunnerSteps(q, runnerId);
    const machine = runner ? yield* vmHostMachineSteps(q, runner.workspaceId, runnerId) : null;
    if (!machine?.host) return { vmHost: false } as VmHostRunnerView;
    return {
      vmHost: true,
      slots: vmHostSlots(machine, machine.host).slots,
      size: { vcpus: machine.host.vmVcpus, memoryGb: machine.host.vmMemoryGb },
      vms: yield* liveHostIssueVmsSteps(q, runnerId),
    } as VmHostRunnerView;
  });
  return Response.json(view);
}
