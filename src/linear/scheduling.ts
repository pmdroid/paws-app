import type { LinearSchedulingMetadata } from "./types";
import { isRecord, readString } from "./read";

export function schedulingMetadata(issue: Record<string, unknown>): LinearSchedulingMetadata {
  const result: LinearSchedulingMetadata = {};
  for (const [field, target] of [
    ["team", "teamId"],
    ["project", "projectId"],
    ["assignee", "assigneeId"],
  ] as const) {
    if (!(field in issue)) continue;
    const value = issue[field];
    if (value === null && field !== "team") {
      result[target] = null;
      if (field === "project") result.projectName = null;
      continue;
    }
    const id = isRecord(value) ? readString(value, "id") : null;
    if (!id?.trim()) throw new Error(`Linear returned invalid scheduling ${field}`);
    result[target] = id;
    const name = field === "project" && isRecord(value) ? readString(value, "name") : null;
    if (name?.trim()) result.projectName = name.trim();
  }
  const project = issue["project"];
  if (isRecord(project) && "lead" in project) {
    const lead = project["lead"];
    const id = isRecord(lead) ? readString(lead, "id") : null;
    if (lead !== null && !id?.trim()) throw new Error("Linear returned an invalid project lead");
    result.projectLeadId = id;
  } else if (project === null) result.projectLeadId = null;
  if ("priority" in issue) {
    const priority = issue["priority"];
    if (typeof priority !== "number" || !Number.isInteger(priority) || priority < 0 || priority > 4)
      throw new Error("Linear returned an invalid scheduling priority");
    result.priority = priority;
  }
  return result;
}
