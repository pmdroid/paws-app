import { createHash } from "node:crypto";
import { orderByBlocks } from "../intake";
import type { DependencyEdge, LinearProjectSnapshot, TrackerAdapter } from "../linear";

export type ProjectSelection = {
  projectId: string;
  issueIds: readonly string[];
  repository: string;
  targetBranch: string;
  leadUserId: string;
  steeringRoles: readonly ("owner" | "admin" | "member")[];
};

export type ProjectPreview = {
  selection: ProjectSelection;
  project: LinearProjectSnapshot;
  generation: string;
  includedIssueIds: string[];
  excludedIssueIds: string[];
  order: string[];
  edges: DependencyEdge[];
  externalBlockerIds: string[];
  problems: string[];
};

export async function previewProject(
  tracker: Pick<TrackerAdapter, "loadProject" | "listDeps">,
  selection: ProjectSelection,
  options: { organizationId: string; signal?: AbortSignal },
): Promise<ProjectPreview> {
  if (!tracker.loadProject) throw new Error("Linear project reads are unavailable.");
  if (
    !selection.projectId.trim() ||
    !selection.repository.trim() ||
    !selection.targetBranch.trim() ||
    !selection.leadUserId.trim() ||
    selection.issueIds.length === 0 ||
    selection.issueIds.length > 200 ||
    new Set(selection.issueIds).size !== selection.issueIds.length ||
    selection.steeringRoles.length === 0 ||
    selection.steeringRoles.some((role) => !["owner", "admin", "member"].includes(role))
  )
    throw new Error(
      "Choose a project, repository, lead, steering roles and 1–200 distinct issues.",
    );
  const project = await tracker.loadProject(selection.projectId, options);
  if (project.id !== selection.projectId || project.organizationId !== options.organizationId)
    throw new Error("This project does not belong to the installed workspace.");
  const selected = new Set(selection.issueIds);
  const included = project.issues.filter((issue) => selected.has(issue.linearIssueId));
  if (included.length !== selected.size)
    throw new Error("Selected issues left the project. Refresh its scope.");
  const edges = new Map<string, DependencyEdge>();
  for (const issue of included) {
    options.signal?.throwIfAborted();
    for (const edge of await tracker.listDeps(issue.linearIssueId)) {
      if (!edge.blockerLinearIssueId || !edge.blockedLinearIssueId)
        throw new Error("Linear returned an incomplete dependency.");
      if (selected.has(edge.blockedLinearIssueId))
        edges.set(JSON.stringify([edge.blockerLinearIssueId, edge.blockedLinearIssueId]), edge);
    }
  }
  options.signal?.throwIfAborted();
  const dependencies = [...edges.values()].sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );
  const ordered = orderByBlocks(included, dependencies);
  const problems = included.flatMap((issue) => [
    ...(!issue.description?.trim() ? [`${issue.identifier} needs requirements.`] : []),
    ...(["completed", "canceled", "duplicate"].includes(issue.stateType)
      ? [`${issue.identifier} is already ${issue.stateType}.`]
      : []),
  ]);
  if (!ordered.ok)
    problems.push(
      `Dependency cycle: ${ordered.remaining.map((issue) => issue.identifier).join(", ")}.`,
    );
  const normalized: ProjectSelection = {
    ...selection,
    issueIds: [...selection.issueIds].sort(),
    steeringRoles: [...new Set(selection.steeringRoles)].sort(),
  };
  const generation = createHash("sha256")
    .update(JSON.stringify({ selection: normalized, project, edges: dependencies }))
    .digest("hex");
  return {
    selection: normalized,
    project,
    generation,
    includedIssueIds: included.map((issue) => issue.linearIssueId),
    excludedIssueIds: project.issues
      .filter((issue) => !selected.has(issue.linearIssueId))
      .map((issue) => issue.linearIssueId),
    order: ordered.ok ? ordered.ordered.map((issue) => issue.linearIssueId) : [],
    edges: dependencies,
    externalBlockerIds: [
      ...new Set(
        dependencies
          .filter((edge) => !selected.has(edge.blockerLinearIssueId))
          .map((edge) => edge.blockerLinearIssueId),
      ),
    ].sort(),
    problems,
  };
}
