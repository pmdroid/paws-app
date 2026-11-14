import {
  loadConfigFile,
  parseMemberVmSettings,
  writeMemberVmSize,
  type MemberVmSize,
} from "../config";
import { journalCaught } from "../journal";
import { isWorkspaceAdmin } from "../workspace";
import { json, localRequest, readJson, sameToken } from "./handler";

export const MEMBER_VM_SETTINGS_PATH = "/api/settings/member-vm";

export type MemberVmSettingsOptions = {
  configPath: string;
  csrfToken: string;
  trustedOrigin?: string;
  role?: string;
  audit: (action: string, subject: string) => Promise<void>;
};

export async function handleMemberVmSettingsRequest(
  request: Request,
  options: MemberVmSettingsOptions,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== MEMBER_VM_SETTINGS_PATH) return null;
  if (!localRequest(request, options.trustedOrigin))
    return json({ error: "Member VM settings are only available on the local Paws origin" }, 403);
  const listing = () => {
    try {
      return json(loadConfigFile(options.configPath).memberVm ?? {});
    } catch (error) {
      journalCaught(error, "member-vm.handleMemberVmSettingsRequest.read", null);
      return json({ error: "Member VM settings could not be read" }, 503);
    }
  };
  if (request.method === "GET") return listing();
  if (request.method !== "PUT") return json({ error: "Method not allowed" }, 405);
  if (options.role !== undefined && !isWorkspaceAdmin(options.role))
    return json({ error: "Only workspace admins can change the member VM size." }, 403);
  if (!sameToken(request.headers.get("x-paws-csrf"), options.csrfToken))
    return json({ error: "CSRF token missing" }, 403);
  let size: MemberVmSize;
  try {
    size = parseMemberVmSettings(await readJson(request));
  } catch (error) {
    journalCaught(error, "member-vm.handleMemberVmSettingsRequest.parse", null);
    return json({ error: error instanceof Error ? error.message : "Invalid member VM size" }, 400);
  }
  await writeMemberVmSize(options.configPath, size);
  const described = Object.entries(size)
    .map(([key, value]) => `${key} ${value}`)
    .join(", ");
  await options.audit(
    "settings.member_vm",
    `Set member VM size: ${described || "exe.dev default"}`,
  );
  return listing();
}
