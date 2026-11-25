import { getRunnerSteps, liveHostIssueVmsSteps, vmHostMachineSteps, type Db } from "../db";
import { journal, journalCaught } from "../journal";
import { readWebhookBody } from "../webhook-body";
import { vmHostSlots } from "./slots";

const ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const REASONS = new Set(["unknown", "deleting", "duplicate"]);

export type VmHostRunnerView =
  | { vmHost: false }
  | {
      vmHost: true;
      slots: number;
      size: { vcpus: number; memoryGb: number };
      vms: { id: string; state: string }[];
    };

function ids(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 512 || !value.every((id) => ID.test(String(id))))
    throw new Error("Not a list of issue VM ids.");
  return value as string[];
}

function report(body: unknown) {
  const input = (body ?? {}) as Record<string, unknown>;
  const stopped = input.stopped;
  if (!Array.isArray(stopped) || stopped.length > 512) throw new Error("Not a stopped list.");
  return {
    adopted: ids(input.adopted),
    missing: ids(input.missing),
    stopped: stopped.map((entry: { id?: unknown; slot?: unknown; reason?: unknown }) => {
      if (
        !ID.test(String(entry?.id)) ||
        !Number.isInteger(entry?.slot) ||
        !REASONS.has(String(entry?.reason))
      )
        throw new Error("Not a stopped issue VM.");
      return { id: String(entry.id), slot: Number(entry.slot), reason: String(entry.reason) };
    }),
  };
}

export async function handleVmHostRunnerRequest(
  request: Request,
  runnerId: string,
  db: Db,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path === "/v1/issue-vms") {
    if (request.method !== "GET") return Response.json({ error: "Use GET." }, { status: 405 });
    const view = await db.run(function* (q) {
      const runner = yield* getRunnerSteps(q, runnerId);
      const machine = runner ? yield* vmHostMachineSteps(q, runner.workspaceId, runnerId) : null;
      if (!machine?.host) return { vmHost: false } as VmHostRunnerView;
      const vms = yield* liveHostIssueVmsSteps(q, runnerId);
      return {
        vmHost: true,
        slots: vmHostSlots(machine, machine.host).slots,
        size: { vcpus: machine.host.vmVcpus, memoryGb: machine.host.vmMemoryGb },
        vms,
      } as VmHostRunnerView;
    });
    return Response.json(view);
  }
  if (path !== "/v1/issue-vms/reconciled") return null;
  if (request.method !== "POST") return Response.json({ error: "Use POST." }, { status: 405 });
  const body = await readWebhookBody(request, 131_072);
  if (body instanceof Response) return body;
  try {
    const result = report(JSON.parse(body.toString("utf8")));
    for (const vm of result.stopped)
      journal(
        `issue_vm_stopped runner=${runnerId} vm=${vm.id} slot=${vm.slot} reason=${vm.reason}`,
      );
    for (const id of result.missing) journal(`issue_vm_missing runner=${runnerId} vm=${id}`);
    journal(
      `issue_vms_reconciled runner=${runnerId} adopted=${result.adopted.length} stopped=${result.stopped.length} missing=${result.missing.length}`,
    );
    return Response.json({ ok: true });
  } catch (error) {
    journalCaught(error, "vm-hosts.handleVmHostRunnerRequest", null);
    return Response.json({ error: "Issue VM report was rejected." }, { status: 400 });
  }
}
