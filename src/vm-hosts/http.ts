import {
  auditWorkspaceAccessSteps,
  deleteVmHostSteps,
  saveVmHostSteps,
  vmHostMachineSteps,
  type Db,
  type VmHostMachine,
  type VmHostSettings,
} from "../db";
import { journalCaught } from "../journal";
import { isWorkspaceAdmin, type WorkspacePrincipal } from "../workspace";
import { vmHostSlots, type VmHostSlots } from "./slots";

const VM_HOST_ROUTE = /^\/api\/runners\/([0-9A-HJKMNP-TV-Z]{26})\/vm-host$/;

export const VM_HOST_DEFAULTS: VmHostSettings = {
  vmVcpus: 2,
  vmMemoryGb: 4,
  vmDiskGb: 30,
  reserveVcpus: 4,
  reserveMemoryGb: 8,
  slotCap: null,
};

const RANGES: Record<keyof VmHostSettings, [number, number]> = {
  vmVcpus: [1, 32],
  vmMemoryGb: [1, 128],
  vmDiskGb: [10, 500],
  reserveVcpus: [0, 64],
  reserveMemoryGb: [0, 256],
  slotCap: [1, 64],
};

export type VmHostView = {
  runnerId: string;
  vmHost: boolean;
  settings: VmHostSettings;
  cpuCount: number | null;
  memoryTotalBytes: number | null;
  poolBytes: number | null;
  slots: VmHostSlots;
};

export function isVmHostPath(path: string): boolean {
  return VM_HOST_ROUTE.test(path);
}

export function parseVmHostSettings(body: unknown): VmHostSettings {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw new Error("Send the VM host settings as a JSON object.");
  const input = body as Record<string, unknown>;
  const unknownKey = Object.keys(input).find((key) => !(key in RANGES));
  if (unknownKey !== undefined) throw new Error(`Unknown VM host setting: ${unknownKey}`);
  const settings = { ...VM_HOST_DEFAULTS };
  for (const key of Object.keys(RANGES) as (keyof VmHostSettings)[]) {
    const value = input[key];
    if (value === undefined || (key === "slotCap" && value === null)) continue;
    const [min, max] = RANGES[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
      throw new Error(`${key} must be a whole number from ${min} to ${max}.`);
    settings[key] = value;
  }
  return settings;
}

function view(machine: VmHostMachine): VmHostView {
  const settings: VmHostSettings = machine.host
    ? {
        vmVcpus: machine.host.vmVcpus,
        vmMemoryGb: machine.host.vmMemoryGb,
        vmDiskGb: machine.host.vmDiskGb,
        reserveVcpus: machine.host.reserveVcpus,
        reserveMemoryGb: machine.host.reserveMemoryGb,
        slotCap: machine.host.slotCap,
      }
    : VM_HOST_DEFAULTS;
  return {
    runnerId: machine.runnerId,
    vmHost: machine.host !== null,
    settings,
    cpuCount: machine.cpuCount,
    memoryTotalBytes: machine.memoryTotalBytes,
    poolBytes: machine.host?.poolBytes ?? null,
    slots: vmHostSlots({ ...machine, poolBytes: machine.host?.poolBytes ?? null }, settings),
  };
}

export type VmHostHttpOptions = { db: Db; principal: WorkspacePrincipal; now?: () => number };

export async function handleVmHostRequest(
  request: Request,
  options: VmHostHttpOptions,
): Promise<Response | null> {
  const match = VM_HOST_ROUTE.exec(new URL(request.url).pathname);
  if (match === null) return null;
  const runnerId = match[1]!;
  const { db, principal } = options;
  if (!isWorkspaceAdmin(principal.role))
    return Response.json({ error: "Only workspace admins can set up VM hosts." }, { status: 403 });
  if (!["GET", "PUT", "DELETE"].includes(request.method))
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  const read = () => db.run((q) => vmHostMachineSteps(q, principal.workspaceId, runnerId));
  const machine = await read();
  if (machine === null) return Response.json({ error: "Runner not found." }, { status: 404 });
  if (request.method === "GET") return Response.json(view(machine));
  const now = (options.now ?? Date.now)();
  const audit = { workspaceId: principal.workspaceId, userId: principal.userId, now };
  if (request.method === "DELETE") {
    await db.transaction(function* (q) {
      if (!(yield* deleteVmHostSteps(q, runnerId))) return;
      yield* auditWorkspaceAccessSteps(q, {
        ...audit,
        action: "settings.vm_host",
        subject: `Removed VM host ${runnerId}`,
      });
    });
    return Response.json(view((await read())!));
  }
  let settings: VmHostSettings;
  try {
    settings = parseVmHostSettings(await request.json());
  } catch (error) {
    journalCaught(error, "vm-hosts.handleVmHostRequest.parse", null);
    return Response.json(
      { error: error instanceof Error ? error.message : "Invalid VM host settings" },
      { status: 400 },
    );
  }
  await db.transaction(function* (q) {
    yield* saveVmHostSteps(q, {
      ...settings,
      runnerId,
      updatedAt: now,
      updatedBy: principal.userId,
    });
    yield* auditWorkspaceAccessSteps(q, {
      ...audit,
      action: "settings.vm_host",
      subject: `Set VM host ${runnerId}: ${settings.vmVcpus} vCPU, ${settings.vmMemoryGb} GB memory, ${settings.vmDiskGb} GB disk, reserve ${settings.reserveVcpus} vCPU and ${settings.reserveMemoryGb} GB, cap ${settings.slotCap ?? "none"}`,
    });
  });
  return Response.json(view((await read())!));
}
