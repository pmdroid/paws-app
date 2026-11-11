import type { AgentSettings, ImplementerName } from "../config";
import { runnerAgentReadinessSteps, type Db } from "../db";

export type RunnerReadiness = { name: string; ready: boolean };

export function activeRunnerReadiness(
  store: Db,
  agent: ImplementerName,
): Promise<RunnerReadiness[]> {
  return store.run((q) => runnerAgentReadinessSteps(q, agent));
}

export async function reviewerRunnerWarnings(
  settings: AgentSettings,
  readiness: (agent: ImplementerName) => RunnerReadiness[] | Promise<RunnerReadiness[]>,
): Promise<string[]> {
  const agents = new Set([
    settings.defaults.reviewer.agent,
    ...settings.projects.flatMap((project) => (project.reviewer ? [project.reviewer.agent] : [])),
  ]);
  const warnings: string[] = [];
  for (const agent of agents) {
    const runners = await readiness(agent);
    if (runners.some((runner) => runner.ready)) continue;
    warnings.push(
      runners.length === 0
        ? `No active runner can review with ${agent} yet: there is no active runner.`
        : `No active runner has ${agent} signed in and ready to review: ${runners.map((runner) => runner.name).join(", ")}.`,
    );
  }
  return warnings;
}
