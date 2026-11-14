import {
  loadConfigFile,
  parseLinearCommentSettings,
  readLinearCommentSettings,
  writeLinearCommentAgents,
} from "../config";
import { journalCaught } from "../journal";
import { isWorkspaceAdmin } from "../workspace";
import { json, localRequest, readJson, sameToken } from "./handler";

export const LINEAR_COMMENT_SETTINGS_PATH = "/api/settings/linear-comments";

export type LinearCommentSettingsOptions = {
  configPath: string;
  csrfToken: string;
  trustedOrigin?: string;
  role?: string;
  audit: (action: string, subject: string) => Promise<void>;
};

export async function handleLinearCommentSettingsRequest(
  request: Request,
  options: LinearCommentSettingsOptions,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== LINEAR_COMMENT_SETTINGS_PATH) return null;
  if (!localRequest(request, options.trustedOrigin))
    return json(
      { error: "Linear comment settings are only available on the local Paws origin" },
      403,
    );
  const listing = () => {
    try {
      return json(readLinearCommentSettings(loadConfigFile(options.configPath)));
    } catch (error) {
      journalCaught(error, "linear-comments.handleLinearCommentSettingsRequest.read", null);
      return json({ error: "Linear comment settings could not be read" }, 503);
    }
  };
  if (request.method === "GET") return listing();
  if (request.method !== "PUT") return json({ error: "Method not allowed" }, 405);
  if (options.role !== undefined && !isWorkspaceAdmin(options.role))
    return json({ error: "Only workspace admins can change Linear comment agents." }, 403);
  if (!sameToken(request.headers.get("x-paws-csrf"), options.csrfToken))
    return json({ error: "CSRF token missing" }, 403);
  let agents: string[];
  try {
    agents = parseLinearCommentSettings(await readJson(request));
  } catch (error) {
    journalCaught(error, "linear-comments.handleLinearCommentSettingsRequest.parse", null);
    return json(
      { error: error instanceof Error ? error.message : "Invalid Linear comment agents" },
      400,
    );
  }
  await writeLinearCommentAgents(options.configPath, agents);
  await options.audit(
    "settings.linear_comments",
    agents.length === 0
      ? "Cleared Linear comment agents"
      : `Set Linear comment agents: ${agents.join(", ")}`,
  );
  return listing();
}
