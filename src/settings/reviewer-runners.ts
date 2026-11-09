import type { Database } from "bun:sqlite";
import type { AgentSettings, ImplementerName } from "../config";
import { runnerAgentReadiness } from "../db";

export type RunnerReadiness = { name: string; ready: boolean };

export function activeRunnerReadiness(db: Database, agent: ImplementerName): RunnerReadiness[] {
  return runnerAgentReadiness(db, agent);
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
