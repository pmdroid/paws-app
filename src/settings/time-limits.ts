import { DEFAULT_MAX_AWAKE_MS } from "../core";
import {
  loadConfigFile,
  parseTimeLimitSettings,
  readTimeLimitSettings,
  writeTimeLimits,
  type StoredTimeLimits,
} from "../config";
import { journalCaught } from "../journal";
import { isWorkspaceAdmin } from "../workspace";
import { json, localRequest, readJson, sameToken } from "./handler";

export const TIME_LIMIT_SETTINGS_PATH = "/api/settings/time-limits";

export type TimeLimitSettingsOptions = {
  configPath: string;
  csrfToken: string;
  trustedOrigin?: string;
  role?: string;
  audit: (action: string, subject: string) => Promise<void>;
};

export async function handleTimeLimitSettingsRequest(
  request: Request,
  options: TimeLimitSettingsOptions,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== TIME_LIMIT_SETTINGS_PATH) return null;
  if (!localRequest(request, options.trustedOrigin))
    return json({ error: "Time limit settings are only available on the local Paws origin" }, 403);
  const listing = () => {
    try {
      const config = loadConfigFile(options.configPath);
      return json(readTimeLimitSettings(config, config.maxAwakeMs ?? DEFAULT_MAX_AWAKE_MS));
    } catch (error) {
      journalCaught(error, "time-limits.handleTimeLimitSettingsRequest.read", null);
      return json({ error: "Time limit settings could not be read" }, 503);
    }
  };
  if (request.method === "GET") return listing();
  if (request.method !== "PUT") return json({ error: "Method not allowed" }, 405);
  if (options.role !== undefined && !isWorkspaceAdmin(options.role))
    return json({ error: "Only workspace admins can change time limits." }, 403);
  if (!sameToken(request.headers.get("x-paws-csrf"), options.csrfToken))
    return json({ error: "CSRF token missing" }, 403);
  let settings: StoredTimeLimits;
  try {
    settings = parseTimeLimitSettings(await readJson(request));
  } catch (error) {
    journalCaught(error, "time-limits.handleTimeLimitSettingsRequest.parse", null);
    return json({ error: error instanceof Error ? error.message : "Invalid time limits" }, 400);
  }
  await writeTimeLimits(options.configPath, settings);
  await options.audit(
    "settings.time_limits",
    `Set time limits: implementation ${settings.implementationMinutes} min, fixes ${settings.fixesMinutes} min, Closeout ${settings.closeoutMinutes} min, ${Object.keys(settings.projects).length} project overrides`,
  );
  return listing();
}
