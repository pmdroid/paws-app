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

const VmId = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);

const UnitReportSchema = z.strictObject({
  running: z.array(VmId).max(254),
  refused: z
    .array(z.strictObject({ id: VmId, reason: z.string().min(1).max(300) }))
    .max(254)
    .optional(),
  sleepCheck: z.literal(true).optional(),
});

type UnitReport = z.infer<typeof UnitReportSchema>;

// A host stops a VM it is told wants asleep. Only a host that runs the guest's sign-in check
// before that stop says `sleepCheck: true`; any other host never hears that a VM wants asleep,
// so it keeps the VM running and the sleep fails at its deadline instead of losing sign-ins.
function* viewSteps(q: Q, runnerId: string, report: UnitReport | null, now: number) {
  const running = report?.running ?? null;
  const runner = yield* getRunnerSteps(q, runnerId);
  const machine = runner ? yield* vmHostMachineSteps(q, runner.workspaceId, runnerId) : null;
  if (!machine?.host) return { vmHost: false } as VmHostRunnerView;
  if (running !== null)
    yield* reportHostIssueVmUnitsSteps(q, {
      hostRunnerId: runnerId,
      running,
      refused: report?.refused,
      now,
    });
  const vms = yield* liveHostIssueVmsSteps(q, runnerId);
  return {
    vmHost: true,
    slots: vmHostSlots(machine, machine.host).slots,
    size: { vcpus: machine.host.vmVcpus, memoryGb: machine.host.vmMemoryGb },
    vms: vms.map(({ id, state, want }) =>
      running === null || (want === "asleep" && report?.sleepCheck !== true)
        ? { id, state }
        : { id, state, want },
    ),
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
  return Response.json(await db.transaction((q) => viewSteps(q, runnerId, report.data, now())));
}
