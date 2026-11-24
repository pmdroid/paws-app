import {
  hostIssueVmDiskRowsSteps,
  recordVmHostPoolSteps,
  updateLiveIssueVmStateSteps,
  type Db,
  type Q,
} from "../db";
import { journalCaught } from "../journal";
import {
  RunnerIssueVmDiskReportSchema,
  type RunnerIssueVmDiskPlan,
  type RunnerIssueVmDiskReport,
} from "../runner-protocol";
import { readWebhookBody } from "../webhook-body";

export const ISSUE_VM_DISKS_PATH = "/v1/issue-vm-disks";

export function* reconcileIssueVmDisksSteps(
  q: Q,
  runnerId: string,
  report: RunnerIssueVmDiskReport,
  now: number,
) {
  const size = yield* recordVmHostPoolSteps(q, runnerId, report.poolBytes);
  if (size === null) return null;
  const present = new Set(report.volumes.map((volume) => volume.id));
  const refused = new Set(report.refused);
  const plan: RunnerIssueVmDiskPlan = { create: [], delete: [] };
  for (const row of yield* hostIssueVmDiskRowsSteps(q, runnerId)) {
    if (row.state === "deleting") {
      if (present.has(row.id)) plan.delete.push(row.id);
      else yield* updateLiveIssueVmStateSteps(q, { id: row.id, state: "deleted", now });
    } else if (refused.has(row.id) && !present.has(row.id)) {
      yield* updateLiveIssueVmStateSteps(q, { id: row.id, state: "failed", now });
    } else if (!present.has(row.id) && plan.create.length < 64) {
      plan.create.push({ id: row.id, ...size });
    }
  }
  return plan;
}

export async function handleIssueVmDiskReport(
  request: Request,
  runnerId: string,
  options: { db: Db; now?: () => number },
): Promise<Response | null> {
  if (new URL(request.url).pathname !== ISSUE_VM_DISKS_PATH) return null;
  if (request.method !== "POST") return Response.json({ error: "Use POST." }, { status: 405 });
  const body = await readWebhookBody(request, 65_536);
  if (body instanceof Response) return body;
  let report: RunnerIssueVmDiskReport;
  try {
    report = RunnerIssueVmDiskReportSchema.parse(JSON.parse(body.toString("utf8")));
  } catch (error) {
    journalCaught(error, "vm-hosts.handleIssueVmDiskReport.parse", null);
    return Response.json({ error: "Issue VM disk report was rejected." }, { status: 400 });
  }
  const now = (options.now ?? Date.now)();
  const plan = await options.db.transaction((q) =>
    reconcileIssueVmDisksSteps(q, runnerId, report, now),
  );
  if (plan === null) return Response.json({ error: "Not a VM host." }, { status: 404 });
  return Response.json(plan);
}
