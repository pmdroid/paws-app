import { projectNotebooksWithoutTeamsSteps, replaceLinearProjectTeamsSteps, type Db } from "../db";
import { journal, journalCaught } from "../journal";
import type { TrackerAdapter } from "../linear";

export async function recordMissingProjectTeams(input: {
  store: Db;
  tracker: Pick<TrackerAdapter, "projectTeams">;
  workspaceId: string;
  now: () => number;
  signal?: AbortSignal;
}): Promise<void> {
  const read = input.tracker.projectTeams?.bind(input.tracker);
  if (!read) return;
  const projectIds = await input.store.run((q) =>
    projectNotebooksWithoutTeamsSteps(q, input.workspaceId),
  );
  for (const projectId of projectIds) {
    input.signal?.throwIfAborted();
    let project;
    try {
      project = await read(projectId, input.signal ? { signal: input.signal } : undefined);
    } catch (error) {
      journalCaught(error, "loop.recordMissingProjectTeams", null);
      continue;
    }
    if (!project) {
      journal(`project ${projectId} notebook teams unavailable from Linear; it stays hidden`);
      continue;
    }
    await input.store.run((q) =>
      replaceLinearProjectTeamsSteps(q, {
        workspaceId: input.workspaceId,
        projectId,
        teamIds: project.teamIds,
        now: input.now(),
      }),
    );
  }
}
