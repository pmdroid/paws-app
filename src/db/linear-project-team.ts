import { and, asc, eq } from "drizzle-orm";
import type { Q, Steps } from "./db";

export type LinearProjectTeams = {
  workspaceId: string;
  projectId: string;
  teamIds: readonly string[];
  now: number;
};

export function* replaceLinearProjectTeamsSteps(q: Q, input: LinearProjectTeams): Steps<void> {
  const table = q.t.linearProjectTeam;
  yield* q.exec(
    q.orm
      .delete(table)
      .where(and(eq(table.workspaceId, input.workspaceId), eq(table.projectId, input.projectId))),
  );
  for (const teamId of new Set(input.teamIds))
    yield* q.exec(
      q.orm.insert(table).values({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        teamId,
        seenAt: input.now,
      }),
    );
}

export function* linearProjectTeamsSteps(
  q: Q,
  workspaceId: string,
  projectId: string,
): Steps<string[]> {
  const table = q.t.linearProjectTeam;
  const rows = yield* q.all(
    q.orm
      .select({ teamId: table.teamId })
      .from(table)
      .where(and(eq(table.workspaceId, workspaceId), eq(table.projectId, projectId)))
      .orderBy(asc(table.teamId)),
  );
  return rows.map((row) => row.teamId);
}
