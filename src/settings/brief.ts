import type { IssueBrief } from "../core";
import { journalCaught } from "../journal";
import {
  loadConfigFile,
  parseBriefTemplates,
  writeBriefTemplates,
  type BriefTemplates,
} from "../config";
import { existsSync, readFileSync } from "node:fs";
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

const REPO = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\/[a-z0-9_.-]+$/;

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
  const repo = body.repo === undefined || body.repo === null ? null : body.repo;
  if (repo !== null && (typeof repo !== "string" || !REPO.test(repo)))
    return json({ error: "Repository must look like owner/repo." }, 400);
  if (body.template !== null && typeof body.template !== "string")
    return json({ error: "The brief template must be text, or null to reset it." }, 400);
  const template = body.template as string | null;
  if (typeof template === "string") {
    const problem = briefTemplateProblem(template);
    if (problem) return json({ error: problem }, 400);
  }
  const scope = repo === null ? null : repo.toLowerCase();
  let previous: BriefTemplates;
  try {
    previous = stored(options.configPath);
  } catch (error) {
    journalCaught(error, "brief.handleBriefSettingsRequest.stored", null);
    return json({ error: "Brief settings could not be read" }, 503);
  }
  const before = scope === null ? previous.template : (previous.projects[scope] ?? null);
  if (before === template) return json(listing(options));
  const next = structuredClone(previous);
  if (scope === null) next.template = template;
  else if (template === null) delete next.projects[scope];
  else next.projects[scope] = template;
  try {
    writeBriefTemplates(options.configPath, next);
  } catch (error) {
    journalCaught(error, "brief.handleBriefSettingsRequest.write", null);
    const problem = error instanceof Error ? error.message : "";
    if (problem.startsWith("Unknown placeholder") || problem.startsWith("The brief template"))
      return json({ error: problem }, 400);
    return json({ error: "Brief settings could not be saved" }, 503);
  }
  const where = scope === null ? "workspace" : scope;
  options.audit?.(
    "settings.brief",
    template === null ? `Reset the ${where} brief template` : `Saved the ${where} brief template`,
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
  if (typeof body.repository !== "string" || !REPO.test(body.repository))
    return json({ error: "Pick a repository." }, 400);
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
    repository: body.repository.toLowerCase(),
    identifier: body.identifier,
    text,
    total: text.length,
    sections: briefSectionSizes(body.template, values),
    samples: BRIEF_RUN_SAMPLES,
  });
}

function stored(path: string): BriefTemplates {
  return parseBriefTemplates(existsSync(path) ? readFileSync(path, "utf8") : "");
}

function listing(options: BriefSettingsOptions) {
  const config = loadConfigFile(options.configPath);
  const saved = stored(options.configPath);
  const projects = new Map<string, { repo: string; template: string | null }>();
  for (const repo of [config.repo, ...config.githubRepos, ...(options.repos ?? [])]) {
    if (repo === null) continue;
    const key = repo.toLowerCase();
    if (!REPO.test(key)) continue;
    projects.set(key, { repo: key, template: saved.projects[key] ?? null });
  }
  for (const [repo, template] of Object.entries(saved.projects)) {
    if (!projects.has(repo)) projects.set(repo, { repo, template });
  }
  return {
    template: saved.template,
    defaultTemplate: defaultBriefTemplate(),
    placeholders: BRIEF_PLACEHOLDERS,
    projects: [...projects.values()],
  };
}

export function previewSectionText(values: BriefValues): string {
  return renderBriefTemplate(defaultBriefTemplate(), values);
}
