import { briefTemplateProblem } from "../core";
import { saveSettingsSection, type PawsConfigFile } from "./file";

/** The workspace template. Null means the built-in brief. */
export type BriefTemplates = { template: string | null };

function emptyBriefTemplates(): BriefTemplates {
  return { template: null };
}

export function parseBriefTemplates(section: unknown): BriefTemplates {
  const brief = section as { template?: unknown } | null | undefined;
  if (brief === undefined) return emptyBriefTemplates();
  if (brief === null || typeof brief !== "object" || Array.isArray(brief))
    throw new Error("brief must be a table");
  return { template: brief.template === undefined ? null : templateText(brief.template, "brief") };
}

function templateText(value: unknown, where: string): string | null {
  if (typeof value !== "string") throw new Error(`${where}.template must be a string`);
  const problem = briefTemplateProblem(value);
  if (problem) throw new Error(problem);
  return value;
}

/** The workspace template. Null means the built-in brief. */
export function resolveBriefTemplate(config: PawsConfigFile): string | null {
  return config.briefTemplate ?? null;
}

export function writeBriefTemplates(path: string, templates: BriefTemplates): Promise<void> {
  const { template } = normalizeTemplates(templates);
  return saveSettingsSection(path, "brief", template === null ? undefined : { template });
}

function normalizeTemplates(templates: BriefTemplates): BriefTemplates {
  if (templates.template !== null) {
    const problem = briefTemplateProblem(templates.template);
    if (problem) throw new Error(problem);
  }
  return { template: templates.template };
}
