import { and, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { Q, Steps } from "./db";

export type SetupFacts = { github: boolean; runner: boolean; agent: boolean; delegated: boolean };

export function* setupFactsSteps(q: Q): Steps<SetupFacts> {
  const { workspaceGithubConnection: c, runner: r, runnerAgentPolicy: p, workItem: w } = q.t;
  const connections = yield* q.all(
    q.orm
      .select({ repositories: c.repositories })
      .from(c)
      .where(and(isNotNull(c.secretId), isNotNull(c.installationId))),
  );
  const live = and(ne(r.status, "revoked"), isNull(r.revokedAt));
  const runner = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(r)
      .where(live)
      .limit(1),
  );
  const agent = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(r)
      .innerJoin(p, eq(p.runnerId, r.id))
      .where(and(live, eq(p.ready, 1), eq(p.authExpired, 0)))
      .limit(1),
  );
  const delegated = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(w)
      .limit(1),
  );
  return {
    github: connections.some((row) => listsRepository(row.repositories)),
    runner: runner !== undefined,
    agent: agent !== undefined,
    delegated: delegated !== undefined,
  };
}

function listsRepository(repositories: string): boolean {
  try {
    const names: unknown = JSON.parse(repositories);
    return Array.isArray(names) && names.some((name) => typeof name === "string");
  } catch {
    return false;
  }
}
