import { existsSync, readFileSync } from "node:fs";
import { briefTemplateProblem } from "../core";
import { replaceConfigText } from "./agents";
import type { PawsConfigFile } from "./file";

/** A workspace template and optional per-repository overrides. Null means the built-in brief. */
export type BriefTemplates = {
  template: string | null;
  projects: Record<string, string>;
};

const REPO = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\/[a-zA-Z0-9_.-]+$/;

export function emptyBriefTemplates(): BriefTemplates {
  return { template: null, projects: {} };
}

export function parseBriefTemplates(text: string): BriefTemplates {
  if (!/^\s*\[brief(?:\.|\s*\])/m.test(text)) return emptyBriefTemplates();
  const root = Bun.TOML.parse(text) as {
    brief?: { template?: unknown; projects?: unknown };
  };
  const brief = root.brief;
  if (brief === undefined) return emptyBriefTemplates();
  if (brief === null || typeof brief !== "object" || Array.isArray(brief))
    throw new Error("brief must be a table");
  const template = brief.template === undefined ? null : templateText(brief.template, "brief");
  const projects = brief.projects;
  const stored: Record<string, string> = {};
  if (projects !== undefined) {
    if (projects === null || typeof projects !== "object" || Array.isArray(projects))
      throw new Error("brief.projects must be a table");
    for (const [repo, value] of Object.entries(projects)) {
      if (!REPO.test(repo)) throw new Error("brief.projects keys must be owner/repo");
      const table = (value ?? {}) as { template?: unknown };
      if (table.template === undefined) continue;
      const projectTemplate = templateText(table.template, `brief.projects.${repo}`);
      if (projectTemplate !== null) stored[repo.toLowerCase()] = projectTemplate;
    }
  }
  return { template, projects: stored };
}

function templateText(value: unknown, where: string): string | null {
  if (typeof value !== "string") throw new Error(`${where}.template must be a string`);
  const problem = briefTemplateProblem(value);
  if (problem) throw new Error(problem);
  return value;
}

/**
 * The template a repository uses. A repository override wins. Null means the built-in brief.
 */
export function resolveBriefTemplate(config: PawsConfigFile, repo?: string | null): string | null {
  const project = repo ? config.briefProjects?.[repo.toLowerCase()] : undefined;
  if (project !== undefined) return project;
  const workspace = config.briefTemplate;
  return workspace ?? null;
}

export function renderBriefTemplates(templates: BriefTemplates): string {
  const parts: string[] = [];
  if (templates.template !== null)
    parts.push(`[brief]\ntemplate = ${tomlBasic(templates.template)}`);
  for (const repo of Object.keys(templates.projects).sort()) {
    const template = templates.projects[repo];
    if (template === undefined) continue;
    parts.push(`[brief.projects.${JSON.stringify(repo)}]\ntemplate = ${tomlBasic(template)}`);
  }
  return parts.length ? `\n${parts.join("\n\n")}\n` : "";
}

/** Replace every `[brief]` table and keep the rest of the file. */
export function setBriefTemplatesText(current: string, templates: BriefTemplates): string {
  let section = "";
  let skipping = false;
  const retained = current
    .split(/\r?\n/)
    .filter((line) => {
      const heading = /^\s*\[\[?\s*([^[\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
      if (heading?.[1]) {
        section = heading[1].trim().toLowerCase();
        skipping = section === "brief" || section.startsWith("brief.");
      }
      return !skipping;
    })
    .join("\n")
    .replace(/\s*$/, "");
  const tables = renderBriefTemplates(templates);
  if (retained === "") return tables.trimStart();
  return `${retained}\n${tables}`;
}

export function writeBriefTemplates(path: string, templates: BriefTemplates): void {
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const next = setBriefTemplatesText(current, normalizeTemplates(templates));
  parseBriefTemplates(next);
  replaceConfigText(path, next.endsWith("\n") || next === "" ? next : `${next}\n`);
}

function normalizeTemplates(templates: BriefTemplates): BriefTemplates {
  const projects: Record<string, string> = {};
  for (const [repo, template] of Object.entries(templates.projects)) {
    if (!REPO.test(repo)) throw new Error("brief.projects keys must be owner/repo");
    const problem = briefTemplateProblem(template);
    if (problem) throw new Error(problem);
    projects[repo.toLowerCase()] = template;
  }
  if (templates.template !== null) {
    const problem = briefTemplateProblem(templates.template);
    if (problem) throw new Error(problem);
  }
  return {
    template: templates.template,
    projects,
  };
}

function tomlBasic(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (char === "\\") out += "\\\\";
    else if (char === '"') out += '\\"';
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (char === "\t") out += "\\t";
    else if (code < 32 || code === 127) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += char;
  }
  return `"${out}"`;
}
