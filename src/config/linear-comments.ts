import { z } from "zod";
import { saveSettingsSection, type PawsConfigFile } from "./file";

export type LinearCommentSettings = { agents: string[]; configured: boolean };

const settingsSchema = z.strictObject({
  agents: z
    .array(z.string().regex(/^[A-Za-z0-9_-]{1,100}$/, "must be a Linear app user id"))
    .max(100, "must list at most 100 agents"),
});

export function resolveLinearCommentAgents(
  config: Pick<PawsConfigFile, "savedLinearCommentAgents">,
): string[] {
  return config.savedLinearCommentAgents ?? [];
}

export function readLinearCommentSettings(
  config: Pick<PawsConfigFile, "savedLinearCommentAgents">,
): LinearCommentSettings {
  return {
    agents: resolveLinearCommentAgents(config),
    configured: config.savedLinearCommentAgents !== undefined,
  };
}

export function parseLinearCommentSettings(value: unknown): string[] {
  const result = settingsSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(
      `${issue?.path.length ? issue.path.join(".") : "linearComments"} ${issue?.message ?? "is invalid"}`,
    );
  }
  return [...new Set(result.data.agents)];
}

export function writeLinearCommentAgents(path: string, agents: readonly string[]): Promise<void> {
  return saveSettingsSection(path, "linear_comments", { agents: [...agents] });
}
