import type { FindingGroup, FindingGroupRun } from "../../db";
import type { FindingView } from "./findings";

export const FINDING_GROUPS_API_PATH = "/api/finding-groups";
export type FindingGroupView = FindingGroup & { findings: FindingView[] };
export type FindingGroupsResponse = {
  groups: FindingGroupView[];
  lastRun: FindingGroupRun | null;
  canRun: boolean;
  enabled: boolean;
};
export type FindingGroupAction =
  | { action: "run" }
  | { action: "file" | "add"; id: string }
  | { action: "dismiss"; id: string; reason: string };
