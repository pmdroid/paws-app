import type { AgentProfile, AgentProfiles } from "../config";
import {
  activeAgentRunnersSteps,
  lastSuccessfulImplementationSteps,
  verifyingItemsSteps,
  type Db,
} from "../db";
import { runnerModelCatalogSteps } from "../runner-placement";

export type FleetRunner = {
  name: string;
  agent: string;
  models: string[] | null;
  catalogAt: number | null;
};
export type WaitingReview = { identifier: string; model: string | null };
export type AgentFleet = { runners: FleetRunner[]; waitingReviews: WaitingReview[] };
export type AgentDefaultsCheck = { refusals: string[]; warnings: string[] };

const STALE_CATALOG_MS = 24 * 60 * 60 * 1000;

export async function activeAgentFleet(store: Db): Promise<AgentFleet> {
  return store.run(function* (q) {
    const runners: FleetRunner[] = [];
    for (const runner of yield* activeAgentRunnersSteps(q)) {
      const catalog = yield* runnerModelCatalogSteps(q, runner.runnerId, runner.agent);
      runners.push({
        name: runner.name,
        agent: runner.agent,
        models: catalog?.models ?? null,
        catalogAt: catalog?.updatedAt ?? null,
      });
    }
    const waitingReviews: WaitingReview[] = [];
    for (const item of yield* verifyingItemsSteps(q)) {
      const implementation = yield* lastSuccessfulImplementationSteps(q, item.id);
      waitingReviews.push({ identifier: item.identifier, model: implementation?.model ?? null });
    }
    return { runners, waitingReviews };
  });
}

function label(profile: AgentProfile): string {
  return profile.model ? `${profile.agent} ${profile.model}` : profile.agent;
}

export function checkAgentDefaults(
  defaults: AgentProfiles,
  fleet: AgentFleet,
  now: number,
): AgentDefaultsCheck {
  const refusals: string[] = [];
  const warnings: string[] = [];
  const roles: [string, AgentProfile][] = [
    ["implementer", defaults.implementer],
    ["reviewer", defaults.reviewer],
    ...(defaults.reviewerFallback
      ? [["reviewer fallback", defaults.reviewerFallback] as [string, AgentProfile]]
      : []),
  ];
  const stale = new Set<string>();
  if (fleet.runners.length)
    for (const [role, profile] of roles) {
      const runners = fleet.runners.filter((runner) => runner.agent === profile.agent);
      const offering = runners.filter(
        (runner) => !profile.model || (runner.models?.includes(profile.model) ?? false),
      );
      for (const runner of offering)
        if (runner.catalogAt !== null && now - runner.catalogAt > STALE_CATALOG_MS)
          stale.add(runner.name);
      if (!offering.length) refusals.push(`No runner offers ${label(profile)} for the ${role}.`);
      else if (offering.length < runners.length)
        warnings.push(
          `Only some runners offer ${label(profile)} for the ${role}: ${offering.map((runner) => runner.name).join(", ")}.`,
        );
    }
  if (stale.size)
    warnings.push(
      `These runners' model catalogs are more than 24 hours old: ${[...stale].join(", ")}.`,
    );
  const reviewerModel = defaults.reviewer.model;
  const blocked = reviewerModel
    ? fleet.waitingReviews.filter((item) => item.model === reviewerModel)
    : [];
  if (blocked.length)
    warnings.push(
      `These items wait for review and were implemented with ${reviewerModel}, the new reviewer model: ${blocked.map((item) => item.identifier).join(", ")}.`,
    );
  return { refusals, warnings };
}
