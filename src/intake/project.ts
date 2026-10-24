import type { WorkItemLinearProject } from "../db";
import type { LinearSchedulingMetadata } from "../linear";

/**
 * The Linear project from an issue snapshot. Undefined when the read did not ask for it,
 * so a stored project is left alone; null when the issue has no project.
 */
export function snapshotProject(
  issue: LinearSchedulingMetadata,
): WorkItemLinearProject | null | undefined {
  if (issue.projectId === undefined) return undefined;
  if (issue.projectId === null) return null;
  return { id: issue.projectId, name: issue.projectName ?? null };
}
