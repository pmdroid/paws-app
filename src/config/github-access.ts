import { z } from "zod";
import {
  agentReadAllowed,
  githubMirrorsOn,
  saveSettingsSection,
  type PawsConfigFile,
} from "./file";

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
  return {
    configured: config.githubAccess !== undefined,
    agentRead: agentReadAllowed(config),
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

export function writeGitHubAccess(path: string, settings: GitHubAccessSettings): Promise<void> {
  return saveSettingsSection(path, "github_access", {
    agent_read: settings.agentRead,
    mirrors: settings.mirrors,
  });
}
