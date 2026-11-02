import type { Database } from "bun:sqlite";
import type { AgentSettings, ImplementerName } from "../config";

export type RunnerReadiness = { name: string; ready: boolean };

export function activeRunnerReadiness(db: Database, agent: ImplementerName): RunnerReadiness[] {
  return db
    .query<{ name: string; ready: number }, [string]>(
      `SELECT r.name,COALESCE(p.ready=1 AND p.auth_expired=0,0) AS ready FROM runner r
       LEFT JOIN runner_agent_policy p ON p.runner_id=r.id AND p.agent=?
       WHERE r.status='active' AND r.revoked_at IS NULL ORDER BY r.name`,
    )
    .all(agent)
    .map((row) => ({ name: row.name, ready: row.ready === 1 }));
}

export function reviewerRunnerWarnings(
  settings: AgentSettings,
  readiness: (agent: ImplementerName) => RunnerReadiness[],
): string[] {
  const agents = new Set([
    settings.defaults.reviewer.agent,
    ...settings.projects.flatMap((project) => (project.reviewer ? [project.reviewer.agent] : [])),
  ]);
  return [...agents].flatMap((agent) => {
    const runners = readiness(agent);
    if (runners.some((runner) => runner.ready)) return [];
    return [
      runners.length === 0
        ? `No active runner can review with ${agent} yet: there is no active runner.`
        : `No active runner has ${agent} signed in and ready to review: ${runners.map((runner) => runner.name).join(", ")}.`,
    ];
  });
}
