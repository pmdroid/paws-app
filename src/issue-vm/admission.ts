import { issueVmSettings, parseConfigToml } from "../config";
import {
  activeIssueVmGrantLimitSteps,
  CONFIG_SETTINGS_KEY,
  issueVmsInUseSteps,
  readSettingSteps,
  type Q,
} from "../db";

export type IssueVmAdmission =
  | { ok: true }
  | { ok: false; reason: "member_limit" | "workspace_limit"; limit: number; inUse: number };

export function* issueVmAdmissionSteps(
  q: Q,
  input: { workspaceId: string; memberUserId: string; at: number },
) {
  const text = yield* readSettingSteps(q, CONFIG_SETTINGS_KEY);
  const settings = issueVmSettings(text === null ? undefined : parseConfigToml(text).issueVm);
  const granted = yield* activeIssueVmGrantLimitSteps(q, input);
  const memberLimit = granted ?? settings.perMember;
  const memberInUse = yield* issueVmsInUseSteps(q, input);
  if (memberInUse >= memberLimit)
    return {
      ok: false,
      reason: "member_limit",
      limit: memberLimit,
      inUse: memberInUse,
    } satisfies IssueVmAdmission;
  const workspaceInUse = yield* issueVmsInUseSteps(q, { workspaceId: input.workspaceId });
  if (workspaceInUse >= settings.workspaceMax)
    return {
      ok: false,
      reason: "workspace_limit",
      limit: settings.workspaceMax,
      inUse: workspaceInUse,
    } satisfies IssueVmAdmission;
  return { ok: true } satisfies IssueVmAdmission;
}
