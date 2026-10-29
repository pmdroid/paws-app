import type { Database } from "bun:sqlite";
import { findingGroupingEnabled, setFindingGrouping } from "../db";
import { journalCaught } from "../journal";
import { isWorkspaceAdmin } from "../workspace";
import { isRecord, json, localRequest, readJson, sameToken } from "./handler";

export const FINDING_SETTINGS_PATH = "/api/settings/findings";

export type FindingSettingsOptions = {
  db: Database;
  csrfToken: string;
  workspaceId: string;
  groupingTime: string;
  trustedOrigin?: string;
  role?: string;
  audit: (action: string, subject: string) => void;
};

export async function handleFindingSettingsRequest(
  request: Request,
  options: FindingSettingsOptions,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== FINDING_SETTINGS_PATH) return null;
  if (!localRequest(request, options.trustedOrigin))
    return json({ error: "Finding settings are only available on the local Paws origin" }, 403);
  if (options.role !== undefined && !isWorkspaceAdmin(options.role))
    return json({ error: "Only workspace admins can change finding settings." }, 403);
  const listing = () =>
    json({
      grouping: findingGroupingEnabled(options.db, options.workspaceId),
      groupingTime: options.groupingTime,
    });
  if (request.method === "GET") return listing();
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!sameToken(request.headers.get("x-paws-csrf"), options.csrfToken))
    return json({ error: "CSRF token missing" }, 403);
  let body: unknown;
  try {
    body = await readJson(request);
  } catch (error) {
    journalCaught(error, "findings.handleFindingSettingsRequest.readJson", null);
    return json({ error: "Expected a JSON body of at most 128 KiB" }, 400);
  }
  if (!isRecord(body) || typeof body.grouping !== "boolean")
    return json({ error: "Send grouping as true or false." }, 400);
  setFindingGrouping(options.db, options.workspaceId, body.grouping);
  options.audit(
    "settings.findings.grouping",
    `Turned daily finding grouping ${body.grouping ? "on" : "off"}`,
  );
  return listing();
}
