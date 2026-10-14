import { exclusionPatterns } from "../worktree-checkout";

export type CheckoutProjects = Record<string, { exclude: string[] }>;

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
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/.test(repo)) {
      throw new Error("checkout.projects keys must be owner/repo");
    }
    const exclude = (value as { exclude?: unknown })?.exclude;
    if (!Array.isArray(exclude) || exclude.some((item) => typeof item !== "string")) {
      throw new Error(`checkout.projects.${repo}.exclude must be an array of folder paths`);
    }
    exclusionPatterns(exclude);
    result[repo.toLowerCase()] = { exclude };
  }
  return result;
}

export function renderCheckoutProjects(projects: CheckoutProjects): string {
  return Object.entries(projects)
    .map(
      ([repo, project]) =>
        `\n[checkout.projects.${JSON.stringify(repo)}]\nexclude = ${JSON.stringify(project.exclude)}\n`,
    )
    .join("");
}
