import { existsSync, readFileSync } from "node:fs";
import { readConfigText } from "./settings-store";

const RETIRED_PROJECT_TABLES = [
  ["time_limits", "time_limits.projects is no longer supported; using the global time limits"],
  ["brief", "brief.projects is no longer supported; using the global brief template"],
] as const;

function tablesWithProjects(text: string): Set<string> {
  const found = new Set<string>();
  if (!/^\s*\[\s*[a-z_]+\.projects\b/m.test(text)) return found;
  const root = Bun.TOML.parse(text) as Record<string, unknown>;
  for (const [table] of RETIRED_PROJECT_TABLES) {
    const value = root[table];
    if (value !== null && typeof value === "object" && "projects" in value) found.add(table);
  }
  return found;
}

export function journalRetiredProjectSettings(
  configPath: string,
  journal: (line: string) => void,
): void {
  const file = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const found = new Set([
    ...tablesWithProjects(file),
    ...tablesWithProjects(readConfigText(configPath)),
  ]);
  for (const [table, line] of RETIRED_PROJECT_TABLES) if (found.has(table)) journal(line);
}
