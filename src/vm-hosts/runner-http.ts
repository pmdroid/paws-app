import { z } from "zod";
import {
  createRunnerEnrollmentSteps,
  getRunnerSteps,
  hostIssueVmsAwaitingEnrollmentSteps,
  liveHostIssueVmsSteps,
  markIssueVmTokenMintedSteps,
  reportHostIssueVmUnitsSteps,
  vmHostMachineSteps,
  type Db,
  type Q,
} from "../db";
import { journalCaught } from "../journal";
import { readWebhookBody } from "../webhook-body";
import { workspaceId, workspaceSecret, workspaceTokenHash } from "../workspace";
import { vmHostSlots } from "./slots";

type HostVm = {
  id: string;
  state: string;
  want?: "awake" | "asleep";
  token?: string;
  hold?: true;
};

const ENROLLMENT_MS = 10 * 60_000;

export type VmHostRunnerView =
  | { vmHost: false }
  | {
      vmHost: true;
      slots: number;
      size: { vcpus: number; memoryGb: number; diskGb?: number };
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

/**
 * The host's view. GET (older runners) gets ids and states; a unit report adds each row's want.
 * Only a report that asks with `disks=1` also gets the disk size, bootstrap tokens and holds:
 * runners from before it parse the answer strictly and would refuse those fields.
 *
 * A host stops a VM it is told wants asleep. Only a host that runs the guest's sign-in check
 * before that stop says `sleepCheck: true`; any other host never hears that a VM wants asleep,
 * so it keeps the VM running and the sleep fails at its deadline instead of losing sign-ins.
 */
function* viewSteps(q: Q, runnerId: string, report: UnitReport | null, now: number, disks = false) {
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
  const vms = (yield* liveHostIssueVmsSteps(q, runnerId)).map(({ id, state, want }) =>
    want === "asleep" && report?.sleepCheck !== true ? { id, state } : { id, state, want },
  );
  const size = { vcpus: machine.host.vmVcpus, memoryGb: machine.host.vmMemoryGb };
  if (running === null)
    return {
      vmHost: true,
      slots: vmHostSlots(machine, machine.host).slots,
      size,
      vms: vms.map(({ id, state }) => ({ id, state })),
    } as VmHostRunnerView;
  if (!disks)
    return {
      vmHost: true,
      slots: vmHostSlots(machine, machine.host).slots,
      size,
      vms,
    } as VmHostRunnerView;
  const tokens = yield* enrollmentTokensSteps(q, runnerId, running, now);
  return {
    vmHost: true,
    slots: vmHostSlots(machine, machine.host).slots,
    size: { ...size, diskGb: machine.host.vmDiskGb },
    vms: vms.map((vm) => {
      const token = tokens.get(vm.id);
      if (token === null) return { ...vm, hold: true };
      return token === undefined ? vm : { ...vm, token };
    }),
  } as VmHostRunnerView;
}

/**
 * A single-use bootstrap token for each creating VM on the host that has no runner yet and whose
 * unit isn't running, so the host can stage it before it starts the unit. Each replaces the VM's
 * earlier unused tokens; a running unit already took its token, and an enrolled VM needs none.
 * A VM that can't get one (its member may no longer own a runner, or the workspace is at its
 * pending enrollment limit) maps to null: the host holds it rather than boot it unenrolled.
 */
function* enrollmentTokensSteps(q: Q, hostRunnerId: string, running: string[], now: number) {
  const tokens = new Map<string, string | null>();
  for (const vm of yield* hostIssueVmsAwaitingEnrollmentSteps(q, hostRunnerId)) {
    if (running.includes(vm.id)) continue;
    if (!vm.memberUsable) {
      tokens.set(vm.id, null);
      continue;
    }
    const token = workspaceSecret();
    try {
      yield* createRunnerEnrollmentSteps(q, {
        id: workspaceId(now),
        tokenHash: workspaceTokenHash(token),
        workspaceId: vm.workspaceId,
        userId: vm.memberUserId,
        name: `paws-vm-${vm.id.toLowerCase()}`,
        expiresAt: now + ENROLLMENT_MS,
        now,
        issueVmId: vm.id,
      });
    } catch (error) {
      journalCaught(error, "vm-hosts.enrollmentTokensSteps", null);
      tokens.set(vm.id, null);
      continue;
    }
    yield* markIssueVmTokenMintedSteps(q, { id: vm.id, now });
    tokens.set(vm.id, token);
  }
  return tokens;
}

export async function handleVmHostRunnerRequest(
  request: Request,
  runnerId: string,
  db: Db,
  now: () => number = Date.now,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/v1/issue-vms") return null;
  const disks = url.searchParams.get("disks") === "1";
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
    await db.transaction((q) => viewSteps(q, runnerId, report.data, now(), disks)),
  );
}
