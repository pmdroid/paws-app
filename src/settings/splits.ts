import {
  parseSplitSettings,
  readSettingSections,
  splitSettings,
  writeSplitSettings,
  type SplitSettings,
} from "../config";
import { journalCaught } from "../journal";
import { isWorkspaceAdmin } from "../workspace";
import { json, localRequest, readJson, sameToken } from "./handler";

export const SPLIT_SETTINGS_PATH = "/api/settings/splits";

export type SplitSettingsOptions = {
  configPath: string;
  csrfToken: string;
  trustedOrigin?: string;
  role?: string;
  audit: (action: string, subject: string) => Promise<void>;
};

export async function handleSplitSettingsRequest(
  request: Request,
  options: SplitSettingsOptions,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== SPLIT_SETTINGS_PATH) return null;
  if (!localRequest(request, options.trustedOrigin))
    return json({ error: "Split settings are only available on the local Paws origin" }, 403);
  if (options.role !== undefined && !isWorkspaceAdmin(options.role))
    return json({ error: "Only workspace admins can see and change issue splits." }, 403);
  const listing = () => json(splitSettings(readSettingSections(options.configPath)["splits"]));
  if (request.method === "GET") return listing();
  if (request.method !== "PUT") return json({ error: "Method not allowed" }, 405);
  if (!sameToken(request.headers.get("x-paws-csrf"), options.csrfToken))
    return json({ error: "CSRF token missing" }, 403);
  let settings: SplitSettings;
  try {
    settings = parseSplitSettings(await readJson(request));
  } catch (error) {
    journalCaught(error, "splits.handleSplitSettingsRequest.parse", null);
    return json({ error: error instanceof Error ? error.message : "Invalid split settings" }, 400);
  }
  await writeSplitSettings(options.configPath, settings);
  await options.audit(
    "settings.splits",
    `Set issue splits ${settings.enabled ? "on" : "off"}: at most ${settings.maxSubIssues} sub-issues, ${settings.approvalsBeforeAuto} approvals before automatic splits`,
  );
  return listing();
}
