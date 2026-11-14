import {
  activeGitHubMirrors,
  loadConfigFile,
  parseGitHubAccessSettings,
  readGitHubAccessSettings,
  writeGitHubAccess,
} from "../config";
import { journal, journalCaught } from "../journal";
import { isWorkspaceAdmin } from "../workspace";
import { json, localRequest, readJson, sameToken } from "./handler";

export const GITHUB_ACCESS_SETTINGS_PATH = "/api/settings/github-access";

export type GitHubAccessSettingsOptions = {
  configPath: string;
  csrfToken: string;
  trustedOrigin?: string;
  role?: string;
  audit: (action: string, subject: string) => Promise<void>;
};

export async function handleGitHubAccessSettingsRequest(
  request: Request,
  options: GitHubAccessSettingsOptions,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== GITHUB_ACCESS_SETTINGS_PATH) return null;
  if (!localRequest(request, options.trustedOrigin))
    return json(
      { error: "GitHub access settings are only available on the local Paws origin" },
      403,
    );
  const current = () => readGitHubAccessSettings(loadConfigFile(options.configPath));
  let before: ReturnType<typeof current>;
  try {
    before = current();
  } catch (error) {
    journalCaught(error, "github-access.handleGitHubAccessSettingsRequest.read", null);
    return json({ error: "GitHub access settings could not be read" }, 503);
  }
  if (request.method === "GET") return json(before);
  if (request.method !== "PUT") return json({ error: "Method not allowed" }, 405);
  if (options.role !== undefined && !isWorkspaceAdmin(options.role))
    return json({ error: "Only workspace admins can change GitHub access." }, 403);
  if (!sameToken(request.headers.get("x-paws-csrf"), options.csrfToken))
    return json({ error: "CSRF token missing" }, 403);
  let settings: ReturnType<typeof parseGitHubAccessSettings>;
  try {
    settings = parseGitHubAccessSettings(await readJson(request));
  } catch (error) {
    journalCaught(error, "github-access.handleGitHubAccessSettingsRequest.parse", null);
    return json({ error: error instanceof Error ? error.message : "Invalid GitHub access" }, 400);
  }
  await writeGitHubAccess(options.configPath, settings);
  const restartRequired = settings.mirrors !== (activeGitHubMirrors() ?? before.mirrors);
  if (settings.mirrors !== before.mirrors)
    journal(
      `GitHub access: mirrors set to ${settings.mirrors}${restartRequired ? "; Closeout's policy reads switch after Paws restarts" : ""}`,
    );
  await options.audit(
    "settings.github_access",
    `Set GitHub access: agent read ${settings.agentRead ? "on" : "off"}, mirrors ${settings.mirrors ? "on" : "off"}`,
  );
  return json({ ...current(), restartRequired });
}
