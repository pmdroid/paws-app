import {
  readSettingSteps,
  settingsWithPrefixSteps,
  takeSettingSteps,
  updateSettingSteps,
  type Q,
  type Steps,
} from "../db";
import type { SlackAudience } from "./api";

export const SLACK_DISCLOSURES = ["none", "workspace"] as const;
export type SlackDisclosure = (typeof SLACK_DISCLOSURES)[number];

const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const prefix = (workspaceId: string) => `slack.disclosure:${workspaceId}:`;

export function slackRepositoryKey(repository: string): string | null {
  return REPOSITORY.test(repository) ? repository.toLowerCase() : null;
}

export function* slackDisclosuresSteps(
  q: Q,
  workspaceId: string,
): Steps<Record<string, SlackDisclosure>> {
  const rows = yield* settingsWithPrefixSteps(q, prefix(workspaceId));
  return Object.fromEntries(
    rows
      .filter((row) => row.value === "workspace")
      .map((row) => [row.key.slice(prefix(workspaceId).length), "workspace" as const]),
  );
}

export function* setSlackDisclosureSteps(
  q: Q,
  workspaceId: string,
  repository: string,
  level: SlackDisclosure,
  now: number,
): Steps<void> {
  const key = `${prefix(workspaceId)}${repository}`;
  if (level === "none") yield* takeSettingSteps(q, key);
  else yield* updateSettingSteps(q, key, () => level, now);
}

export function* slackSourceDisclosableSteps(
  q: Q,
  workspaceId: string,
  repository: string,
  audience: SlackAudience,
): Steps<boolean> {
  const name = slackRepositoryKey(repository);
  if (!name || audience.kind === "unavailable" || audience.guests !== "none") return false;
  const level = yield* readSettingSteps(q, `${prefix(workspaceId)}${name}`);
  return (audience.kind === "public" || audience.kind === "private") && level === "workspace";
}
