import {
  issueVmSettings,
  loadSettings,
  parseIssueVmSettings,
  writeIssueVmSettings,
  type StoredIssueVmSettings,
} from "../config";
import { journalCaught } from "../journal";
import { isWorkspaceAdmin } from "../workspace";
import { json, localRequest, readJson, sameToken } from "./handler";

export const ISSUE_VM_SETTINGS_PATH = "/api/settings/issue-vm";

export type IssueVmSettingsOptions = {
  home: string;
  csrfToken: string;
  trustedOrigin?: string;
  role?: string;
  audit: (action: string, subject: string) => Promise<void>;
};

export async function handleIssueVmSettingsRequest(
  request: Request,
  options: IssueVmSettingsOptions,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== ISSUE_VM_SETTINGS_PATH) return null;
  if (!localRequest(request, options.trustedOrigin))
    return json({ error: "Issue VM settings are only available on the local Paws origin" }, 403);
  if (options.role !== undefined && !isWorkspaceAdmin(options.role))
    return json({ error: "Only workspace admins can see and change issue VM limits." }, 403);
  const listing = () => {
    try {
      return json(issueVmSettings(loadSettings(options.home).issueVm));
    } catch (error) {
      journalCaught(error, "issue-vm.handleIssueVmSettingsRequest.read", null);
      return json({ error: "Issue VM settings could not be read" }, 503);
    }
  };
  if (request.method === "GET") return listing();
  if (request.method !== "PUT") return json({ error: "Method not allowed" }, 405);
  if (!sameToken(request.headers.get("x-paws-csrf"), options.csrfToken))
    return json({ error: "CSRF token missing" }, 403);
  let settings: StoredIssueVmSettings;
  try {
    settings = parseIssueVmSettings(await readJson(request));
  } catch (error) {
    journalCaught(error, "issue-vm.handleIssueVmSettingsRequest.parse", null);
    return json(
      { error: error instanceof Error ? error.message : "Invalid issue VM settings" },
      400,
    );
  }
  await writeIssueVmSettings(options.home, settings);
  const resolved = issueVmSettings(settings);
  await options.audit(
    "settings.issue_vm",
    `Set issue VM limits: ${resolved.perMember} per member, ${resolved.workspaceMax} in the workspace, deleted after ${resolved.deleteAfterDays} days asleep`,
  );
  return listing();
}
