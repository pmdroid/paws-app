import { z } from "zod";
import { githubMirrorsOn, type PawsConfigFile } from "./file";
import { updateConfigText } from "./settings-store";

export type GitHubAccessSettings = { agentRead: boolean; mirrors: boolean };

let activeMirrors: boolean | undefined;

export function useActiveGitHubMirrors(mirrors: boolean | undefined): void {
  activeMirrors = mirrors;
}

export function activeGitHubMirrors(): boolean | undefined {
  return activeMirrors;
}

const schema = z.strictObject({ agentRead: z.boolean(), mirrors: z.boolean() });

export function readGitHubAccessSettings(config: PawsConfigFile) {
  const saved = config.githubAccess?.agentRead !== undefined;
  return {
    configured: config.githubAccess !== undefined,
    agentRead: saved ? config.githubAccess!.agentRead! : true,
    agentReadOff: saved ? [] : (config.agentReadOff ?? []),
    mirrors: githubMirrorsOn(config),
  };
}

export function parseGitHubAccessSettings(value: unknown): GitHubAccessSettings {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw new Error(
    `githubAccess${issue?.path.length ? `.${issue.path.join(".")}` : ""} ${issue?.message ?? "is invalid"}`,
  );
}

export function setGitHubAccessText(current: string, settings: GitHubAccessSettings): string {
  let section = "";
  const retained = current
    .split(/\r?\n/)
    .filter((line) => {
      const heading = /^\s*\[\[?\s*([^[\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
      if (heading?.[1]) section = heading[1].toLowerCase();
      return section !== "github_access";
    })
    .join("\n")
    .trimEnd();
  const table = `[github_access]\nagent_read = ${settings.agentRead}\nmirrors = ${settings.mirrors}\n`;
  return retained === "" ? table : `${retained}\n\n${table}`;
}

export function writeGitHubAccess(path: string, settings: GitHubAccessSettings): Promise<void> {
  return updateConfigText(path, (text) => setGitHubAccessText(text, settings));
}
