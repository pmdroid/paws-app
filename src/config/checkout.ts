import { existsSync, readFileSync } from "node:fs";
import { validateExclusion } from "../worktree-checkout";
import { replaceConfigText } from "./agents";

/**
 * `[checkout.projects."owner/repo"]`. `exclude` hides paths from the agent only; Closeout checks
 * and the independent review still get them. `exclude_from_checks` hides paths from both.
 */
export type CheckoutProject = { exclude: string[]; excludeFromChecks?: string[] };
export type CheckoutProjects = Record<string, CheckoutProject>;

/** The paths one run leaves out: `agent` for the agent's checkout, `checks` for Closeout's. */
export type CheckoutExclusions = { agent: string[]; checks: string[] };

/** The Linear label that runs an issue with nothing left out. */
export const FULL_CHECKOUT_LABEL = "paws:full-checkout";

const REPO = /^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/;

export function parseCheckoutProjects(text: string): CheckoutProjects {
  if (!/^\s*\[checkout\.projects(?:[.\]])/m.test(text)) return {};
  const root = Bun.TOML.parse(text) as { checkout?: { projects?: unknown } };
  const projects = root.checkout?.projects;
  if (projects === undefined) return {};
  if (projects === null || typeof projects !== "object" || Array.isArray(projects)) {
    throw new Error("checkout.projects must be a table");
  }
  const result: CheckoutProjects = {};
  for (const [repo, value] of Object.entries(projects)) {
    if (!REPO.test(repo)) throw new Error("checkout.projects keys must be owner/repo");
    const table = (value ?? {}) as { exclude?: unknown; exclude_from_checks?: unknown };
    const exclude = pathList(repo, "exclude", table.exclude ?? []);
    const fromChecks = pathList(repo, "exclude_from_checks", table.exclude_from_checks ?? []);
    if (table.exclude === undefined && table.exclude_from_checks === undefined)
      throw new Error(`checkout.projects.${repo}.exclude must be an array of paths`);
    result[repo.toLowerCase()] = {
      exclude: exclude.filter((path) => !fromChecks.includes(path)),
      ...(fromChecks.length ? { excludeFromChecks: fromChecks } : {}),
    };
  }
  return result;
}

function pathList(repo: string, key: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new Error(`checkout.projects.${repo}.${key} must be an array of paths`);
  for (const path of value as string[]) validateExclusion(path);
  return [...new Set(value as string[])];
}

export function renderCheckoutProjects(projects: CheckoutProjects): string {
  return Object.entries(projects)
    .filter(([, project]) => project.exclude.length || project.excludeFromChecks?.length)
    .map(
      ([repo, project]) =>
        `\n[checkout.projects.${JSON.stringify(repo)}]\nexclude = ${JSON.stringify(project.exclude)}\n${
          project.excludeFromChecks?.length
            ? `exclude_from_checks = ${JSON.stringify(project.excludeFromChecks)}\n`
            : ""
        }`,
    )
    .join("");
}

/**
 * What a new run of `owner/repo` leaves out. The agent loses both lists; checks lose only
 * `exclude_from_checks`. An issue labelled {@link FULL_CHECKOUT_LABEL} leaves nothing out.
 */
export function checkoutExclusionsFor(
  projects: CheckoutProjects | undefined,
  repository: string,
  labels: readonly string[] = [],
): CheckoutExclusions {
  const project = projects?.[repository.toLowerCase()];
  if (!project || labels.some((label) => label.trim().toLowerCase() === FULL_CHECKOUT_LABEL))
    return { agent: [], checks: [] };
  const checks = project.excludeFromChecks ?? [];
  return { agent: [...new Set([...project.exclude, ...checks])], checks: [...checks] };
}

/** Replace every `[checkout.projects.*]` table and keep the rest of the file as it is. */
export function setCheckoutProjectsText(current: string, projects: CheckoutProjects): string {
  let section = "";
  const retained = current
    .split(/\r?\n/)
    .filter((line) => {
      const heading = /^\s*\[\[?\s*([^[\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
      if (heading?.[1]) section = heading[1].replace(/\s+/g, "").toLowerCase();
      return section !== "checkout.projects" && !section.startsWith("checkout.projects.");
    })
    .join("\n")
    .trimEnd();
  const tables = renderCheckoutProjects(projects);
  if (retained === "") return tables.trimStart();
  return `${retained}\n${tables}`;
}

export function writeCheckoutProjects(path: string, projects: CheckoutProjects): void {
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const next = setCheckoutProjectsText(current, projects);
  parseCheckoutProjects(next);
  replaceConfigText(path, next.endsWith("\n") || next === "" ? next : `${next}\n`);
}
