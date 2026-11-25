import {
  getRunnerSteps,
  issueVmByIdSteps,
  liveHostIssueVmsSteps,
  vmHostMachineSteps,
  type Db,
} from "../db";
import { vmHostSlots } from "./slots";

export type VmHostRunnerView =
  | { vmHost: false }
  | {
      vmHost: true;
      slots: number;
      size: { vcpus: number; memoryGb: number };
      vms: { id: string; state: string }[];
    };

export type IssueVmEnrollmentMint = (issueVmId: string) => Promise<{ token: string } | null>;

export async function handleVmHostRunnerRequest(
  request: Request,
  runnerId: string,
  db: Db,
  mint?: IssueVmEnrollmentMint,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path === "/v1/issue-vms/enrollment") return enrollment(request, runnerId, db, mint);
  if (path !== "/v1/issue-vms") return null;
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

async function enrollment(
  request: Request,
  runnerId: string,
  db: Db,
  mint: IssueVmEnrollmentMint | undefined,
): Promise<Response> {
  if (request.method !== "POST") return Response.json({ error: "Use POST." }, { status: 405 });
  const body = (await request.json().catch(() => null)) as { id?: unknown } | null;
  const id = body?.id;
  if (typeof id !== "string" || !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(id))
    return Response.json({ error: "Name an issue VM." }, { status: 400 });
  const vm = await db.run((q) => issueVmByIdSteps(q, id));
  if (!vm || vm.hostRunnerId !== runnerId)
    return Response.json({ error: "This host runs no such issue VM." }, { status: 404 });
  if (vm.runnerId !== null || !["creating", "awake"].includes(vm.state))
    return Response.json({ token: null });
  if (!mint) return Response.json({ error: "Runner control is starting." }, { status: 503 });
  try {
    return Response.json({ token: (await mint(id))?.token ?? null });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 409 });
  }
}
