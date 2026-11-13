import type { IssueBrief } from "../core";
import { journalCaught } from "../journal";
import {
  parseBriefTemplates,
  readConfigText,
  writeBriefTemplates,
  type BriefTemplates,
} from "../config";
import {
  BRIEF_PLACEHOLDERS,
  BRIEF_RUN_SAMPLES,
  briefSectionSizes,
  briefTemplateProblem,
  defaultBriefTemplate,
  previewBriefValues,
  renderBriefTemplate,
  type BriefValues,
} from "../core";
import type { AgentSettingsOptions } from "./handler";
import { isRecord, json, localRequest, readJson, sameToken } from "./handler";

export const BRIEF_SETTINGS_PATH = "/api/settings/brief";
export const BRIEF_PREVIEW_PATH = "/api/settings/brief/preview";

export type BriefIssuePreview = {
  issue: IssueBrief;
  parent: IssueBrief | null;
  projectOverview: string;
};

export type BriefSettingsOptions = AgentSettingsOptions & {
  /** One Linear read of an issue and its parent. Absent when Linear is not connected. */
  readIssue?: (identifier: string, signal: AbortSignal) => Promise<BriefIssuePreview | null>;
};

export async function handleBriefSettingsRequest(
  request: Request,
  options: BriefSettingsOptions,
): Promise<Response | null> {
  const url = new URL(request.url);
  const preview = url.pathname === BRIEF_PREVIEW_PATH;
  if (url.pathname !== BRIEF_SETTINGS_PATH && !preview) return null;
  if (!localRequest(request, options.trustedOrigin))
    return json({ error: "Brief settings are only available on the local Paws origin" }, 403);
  if (request.method === "GET" && !preview) return getBrief(options);
  if (request.method === "PUT" && !preview) return putBrief(request, options);
  if (request.method === "POST" && preview) return previewBrief(request, options);
  return json({ error: "Method not allowed" }, 405);
}

function getBrief(options: BriefSettingsOptions): Response {
  try {
    return json(listing(options));
  } catch (error) {
    journalCaught(error, "brief.handleBriefSettingsRequest.load", null);
    return json({ error: "Brief settings could not be read" }, 503);
  }
}

async function putBrief(request: Request, options: BriefSettingsOptions): Promise<Response> {
  if (!sameToken(request.headers.get("x-paws-csrf"), options.csrfToken))
    return json({ error: "CSRF token missing" }, 403);
  let body: unknown;
  try {
    body = await readJson(request);
  } catch (error) {
    journalCaught(error, "brief.handleBriefSettingsRequest.readJson", null);
    return json({ error: "Expected a JSON body of at most 128 KiB" }, 400);
  }
  if (!isRecord(body)) return json({ error: "Expected a JSON object" }, 400);
  if (body.template !== null && typeof body.template !== "string")
    return json({ error: "The brief template must be text, or null to reset it." }, 400);
  const template = body.template as string | null;
  if (typeof template === "string") {
    const problem = briefTemplateProblem(template);
    if (problem) return json({ error: problem }, 400);
  }
  let previous: BriefTemplates;
  try {
    previous = stored(options.configPath);
  } catch (error) {
    journalCaught(error, "brief.handleBriefSettingsRequest.stored", null);
    return json({ error: "Brief settings could not be read" }, 503);
  }
  if (previous.template === template) return json(listing(options));
  try {
    await writeBriefTemplates(options.configPath, { template });
  } catch (error) {
    journalCaught(error, "brief.handleBriefSettingsRequest.write", null);
    const problem = error instanceof Error ? error.message : "";
    if (problem.startsWith("Unknown placeholder") || problem.startsWith("The brief template"))
      return json({ error: problem }, 400);
    return json({ error: "Brief settings could not be saved" }, 503);
  }
  await options.audit?.(
    "settings.brief",
    template === null ? "Reset the workspace brief template" : "Saved the workspace brief template",
  );
  return json(listing(options));
}

async function previewBrief(request: Request, options: BriefSettingsOptions): Promise<Response> {
  if (!sameToken(request.headers.get("x-paws-csrf"), options.csrfToken))
    return json({ error: "CSRF token missing" }, 403);
  let body: unknown;
  try {
    body = await readJson(request);
  } catch (error) {
    journalCaught(error, "brief.preview.readJson", null);
    return json({ error: "Expected a JSON body of at most 128 KiB" }, 400);
  }
  if (!isRecord(body)) return json({ error: "Expected a JSON object" }, 400);
  if (typeof body.template !== "string")
    return json({ error: "The brief template must be text." }, 400);
  const problem = briefTemplateProblem(body.template);
  if (problem) return json({ error: problem }, 400);
  if (typeof body.identifier !== "string" || !/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(body.identifier))
    return json({ error: "Enter a Linear issue identifier such as PAS-864." }, 400);
  if (!options.readIssue) return json({ error: "Linear is not connected." }, 503);
  let read: BriefIssuePreview | null;
  try {
    read = await options.readIssue(body.identifier, request.signal);
  } catch (error) {
    if (request.signal.aborted) return json({ error: "The preview was cancelled." }, 400);
    journalCaught(error, "brief.preview.readIssue", null);
    return json({ error: "The Linear issue could not be read." }, 502);
  }
  if (read === null) return json({ error: `No Linear issue is named ${body.identifier}.` }, 404);
  const values = previewBriefValues(read);
  let text: string;
  try {
    text = renderBriefTemplate(body.template, values);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The brief template is invalid.";
    return json({ error: message }, 400);
  }
  return json({
    identifier: body.identifier,
    text,
    total: text.length,
    sections: briefSectionSizes(body.template, values),
    samples: BRIEF_RUN_SAMPLES,
  });
}

function stored(path: string): BriefTemplates {
  return parseBriefTemplates(readConfigText(path));
}

function listing(options: BriefSettingsOptions) {
  return {
    template: stored(options.configPath).template,
    defaultTemplate: defaultBriefTemplate(),
    placeholders: BRIEF_PLACEHOLDERS,
  };
}

export function previewSectionText(values: BriefValues): string {
  return renderBriefTemplate(defaultBriefTemplate(), values);
}
