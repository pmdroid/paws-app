import {
  loadConfigFile,
  parseCloseoutSettings,
  readCloseoutSettings,
  writeCloseoutSettings,
  type CloseoutSettings,
} from "../config";
import { journalCaught } from "../journal";
import { isWorkspaceAdmin } from "../workspace";
import { json, localRequest, readJson, sameToken } from "./handler";

export const CLOSEOUT_SETTINGS_PATH = "/api/settings/closeout";

export type CloseoutSettingsOptions = {
  configPath: string;
  csrfToken: string;
  trustedOrigin?: string;
  role?: string;
  audit: (action: string, subject: string) => Promise<void>;
};

export async function handleCloseoutSettingsRequest(
  request: Request,
  options: CloseoutSettingsOptions,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== CLOSEOUT_SETTINGS_PATH) return null;
  if (!localRequest(request, options.trustedOrigin))
    return json({ error: "Closeout settings are only available on the local Paws origin" }, 403);
  const listing = () => {
    try {
      return json(readCloseoutSettings(loadConfigFile(options.configPath)));
    } catch (error) {
      journalCaught(error, "closeout.handleCloseoutSettingsRequest.read", null);
      return json({ error: "Closeout settings could not be read" }, 503);
    }
  };
  if (request.method === "GET") return listing();
  if (request.method !== "PUT") return json({ error: "Method not allowed" }, 405);
  if (options.role !== undefined && !isWorkspaceAdmin(options.role))
    return json({ error: "Only workspace admins can change Closeout settings." }, 403);
  if (!sameToken(request.headers.get("x-paws-csrf"), options.csrfToken))
    return json({ error: "CSRF token missing" }, 403);
  let settings: CloseoutSettings;
  try {
    settings = parseCloseoutSettings(await readJson(request));
  } catch (error) {
    journalCaught(error, "closeout.handleCloseoutSettingsRequest.parse", null);
    return json(
      { error: error instanceof Error ? error.message : "Invalid Closeout settings" },
      400,
    );
  }
  await writeCloseoutSettings(options.configPath, settings);
  const repos = Object.keys(settings.projects);
  await options.audit(
    "settings.closeout",
    repos.length === 0
      ? "Cleared local Closeout policy roots"
      : `Set local Closeout policy roots for ${repos.join(", ")}`,
  );
  return listing();
}
