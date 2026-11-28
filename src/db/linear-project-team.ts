import { and, asc, eq, isNull, notInArray } from "drizzle-orm";
import type { Q, Steps } from "./db";

export type LinearProjectTeams = {
  workspaceId: string;
  projectId: string;
  teamIds: readonly string[];
  now: number;
};

export function* replaceLinearProjectTeamsSteps(q: Q, input: LinearProjectTeams): Steps<void> {
  const table = q.t.linearProjectTeam;
  const { workspaceId, projectId, now } = input;
  const teamIds = [...new Set(input.teamIds)];
  yield* q.exec(
    q.orm
      .delete(table)
      .where(
        and(
          eq(table.workspaceId, workspaceId),
          eq(table.projectId, projectId),
          notInArray(table.teamId, teamIds),
        ),
      ),
  );
  if (teamIds.length === 0) return;
  yield* q.exec(
    q.orm
      .insert(table)
      .values(teamIds.map((teamId) => ({ workspaceId, projectId, teamId, seenAt: now })))
      .onConflictDoUpdate({
        target: [table.workspaceId, table.projectId, table.teamId],
        set: { seenAt: now },
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

export function* projectNotebooksWithoutTeamsSteps(q: Q, workspaceId: string): Steps<string[]> {
  const notebook = q.t.notebook;
  const teams = q.t.linearProjectTeam;
  const rows = yield* q.all(
    q.orm
      .select({ projectId: notebook.scopeId })
      .from(notebook)
      .leftJoin(
        teams,
        and(eq(teams.workspaceId, notebook.workspaceId), eq(teams.projectId, notebook.scopeId)),
      )
      .where(
        and(
          eq(notebook.workspaceId, workspaceId),
          eq(notebook.scopeKind, "project"),
          isNull(teams.projectId),
        ),
      )
      .orderBy(asc(notebook.scopeId)),
  );
  return rows.map((row) => row.projectId);
}
