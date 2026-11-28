import {
  activeIssueVmGrantsSteps,
  issueVmStateCountsSteps,
  listWorkspaceMembersSteps,
  liveHostIssueVmsSteps,
  workspaceMemberSteps,
  workspaceMemberUsable,
  workspaceVmHostsSteps,
  type Db,
  type Q,
} from "../db";
import type { WorkspacePrincipal } from "../workspace";
import { vmHostSlots } from "./slots";

export const VM_HOSTS_PATH = "/api/vm-hosts";

export type WorkspaceVmHostView = {
  id: string;
  name: string;
  status: string;
  online: boolean;
  slots: { used: number; total: number };
  vm: { vcpus: number; memoryGb: number; diskGb: number };
  addedBy: string | null;
};

export type WorkspaceVmHostsView = {
  hosts: WorkspaceVmHostView[];
  grant: { limit: number; endsAt: number; running: number } | null;
};

function* listSteps(q: Q, principal: WorkspacePrincipal, now: number) {
  const { workspaceId, userId } = principal;
  if (!workspaceMemberUsable(yield* workspaceMemberSteps(q, workspaceId, userId))) return null;
  const machines = yield* workspaceVmHostsSteps(q, workspaceId);
  const online = new Set(
    (yield* workspaceVmHostsSteps(q, workspaceId, now)).map((machine) => machine.runnerId),
  );
  const names = new Map(
    (yield* listWorkspaceMembersSteps(q, workspaceId)).map((member) => [member.id, member.name]),
  );
  const hosts: WorkspaceVmHostView[] = [];
  for (const machine of machines)
    hosts.push({
      id: machine.runnerId,
      name: machine.name,
      status: machine.status,
      online: online.has(machine.runnerId),
      slots: {
        used: (yield* liveHostIssueVmsSteps(q, machine.runnerId)).length,
        total: vmHostSlots(machine, machine.host).slots,
      },
      vm: {
        vcpus: machine.host.vmVcpus,
        memoryGb: machine.host.vmMemoryGb,
        diskGb: machine.host.vmDiskGb,
      },
      addedBy: names.get(machine.ownerUserId) ?? null,
    });
  const grant = (yield* activeIssueVmGrantsSteps(q, { workspaceId, at: now })).find(
    (candidate) => candidate.memberUserId === userId,
  );
  if (grant === undefined) return { hosts, grant: null } satisfies WorkspaceVmHostsView;
  const running = (yield* issueVmStateCountsSteps(q, workspaceId))
    .filter((row) => row.memberUserId === userId)
    .reduce((total, row) => total + row.vms, 0);
  return {
    hosts,
    grant: { limit: grant.limit, endsAt: grant.endsAt, running },
  } satisfies WorkspaceVmHostsView;
}

export async function handleVmHostsListRequest(
  request: Request,
  options: { db: Db; principal: WorkspacePrincipal; now?: () => number },
): Promise<Response | null> {
  if (new URL(request.url).pathname !== VM_HOSTS_PATH) return null;
  if (request.method !== "GET")
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  const now = (options.now ?? Date.now)();
  const listing = await options.db.run((q) => listSteps(q, options.principal, now));
  if (listing === null)
    return Response.json({ error: "Only workspace members can see VM hosts." }, { status: 403 });
  return Response.json(listing);
}
