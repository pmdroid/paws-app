import { z } from "zod";
import {
  getRunnerSteps,
  liveHostIssueVmsSteps,
  reportHostIssueVmUnitsSteps,
  vmHostMachineSteps,
  type Db,
  type Q,
} from "../db";
import { readWebhookBody } from "../webhook-body";
import { vmHostSlots } from "./slots";

type HostVm = { id: string; state: string; want?: "awake" | "asleep" };

export type VmHostRunnerView =
  | { vmHost: false }
  | {
      vmHost: true;
      slots: number;
      size: { vcpus: number; memoryGb: number };
      vms: HostVm[];
    };

const UnitReportSchema = z.strictObject({
  running: z.array(z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/)).max(254),
});

function* viewSteps(q: Q, runnerId: string, running: string[] | null, now: number) {
  const runner = yield* getRunnerSteps(q, runnerId);
  const machine = runner ? yield* vmHostMachineSteps(q, runner.workspaceId, runnerId) : null;
  if (!machine?.host) return { vmHost: false } as VmHostRunnerView;
  if (running !== null)
    yield* reportHostIssueVmUnitsSteps(q, { hostRunnerId: runnerId, running, now });
  const vms = yield* liveHostIssueVmsSteps(q, runnerId);
  return {
    vmHost: true,
    slots: vmHostSlots(machine, machine.host).slots,
    size: { vcpus: machine.host.vmVcpus, memoryGb: machine.host.vmMemoryGb },
    vms: running === null ? vms.map(({ id, state }) => ({ id, state })) : vms,
  } as VmHostRunnerView;
}

export async function handleVmHostRunnerRequest(
  request: Request,
  runnerId: string,
  db: Db,
  now: () => number = Date.now,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== "/v1/issue-vms") return null;
  if (request.method === "GET")
    return Response.json(await db.run((q) => viewSteps(q, runnerId, null, now())));
  if (request.method !== "POST")
    return Response.json({ error: "Use GET or POST." }, { status: 405 });
  const body = await readWebhookBody(request, 65_536);
  if (body instanceof Response) return body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return Response.json({ error: "The unit report is not JSON." }, { status: 400 });
  }
  const report = UnitReportSchema.safeParse(parsed);
  if (!report.success)
    return Response.json({ error: "The unit report is not valid." }, { status: 400 });
  return Response.json(
    await db.transaction((q) => viewSteps(q, runnerId, report.data.running, now())),
  );
}
