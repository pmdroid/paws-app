import { issueVmSettings, parseConfigToml } from "../config";
import {
  activeIssueVmGrantLimitSteps,
  CONFIG_SETTINGS_KEY,
  issueVmsInUseSteps,
  readSettingSteps,
  type IssueVmProvider,
  type Q,
} from "../db";
import { issueVmSpendCheckSteps, type IssueVmSpendCheck } from "./spend";

export type IssueVmAdmission =
  | { ok: true }
  | { ok: false; reason: "member_limit" | "workspace_limit"; limit: number; inUse: number }
  | Exclude<IssueVmSpendCheck, { ok: true }>;

export function* issueVmAdmissionSteps(
  q: Q,
  input: { workspaceId: string; memberUserId: string; provider: IssueVmProvider; at: number },
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
    } satisfies IssueVmAdmission as IssueVmAdmission;
  const workspaceInUse = yield* issueVmsInUseSteps(q, { workspaceId: input.workspaceId });
  if (workspaceInUse >= settings.workspaceMax)
    return {
      ok: false,
      reason: "workspace_limit",
      limit: settings.workspaceMax,
      inUse: workspaceInUse,
    } satisfies IssueVmAdmission as IssueVmAdmission;
  return (yield* issueVmSpendCheckSteps(q, input)) as IssueVmAdmission;
}

export function* issueVmWakeAdmissionSteps(
  q: Q,
  input: { workspaceId: string; provider: IssueVmProvider; at: number },
) {
  return (yield* issueVmSpendCheckSteps(q, input)) as IssueVmAdmission;
}
