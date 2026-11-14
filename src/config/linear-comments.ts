import { z } from "zod";
import { updateConfigText } from "./settings-store";
import type { PawsConfigFile } from "./file";

export type LinearCommentSettings = { agents: string[]; configured: boolean };

const settingsSchema = z.strictObject({
  agents: z
    .array(z.string().regex(/^[A-Za-z0-9_-]{1,100}$/, "must be a Linear app user id"))
    .max(100, "must list at most 100 agents"),
});

export function resolveLinearCommentAgents(
  config: Pick<PawsConfigFile, "linearCommentAgents" | "savedLinearCommentAgents">,
): string[] {
  return config.savedLinearCommentAgents ?? config.linearCommentAgents ?? [];
}

export function readLinearCommentSettings(
  config: Pick<PawsConfigFile, "linearCommentAgents" | "savedLinearCommentAgents">,
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

export function setLinearCommentAgentsText(current: string, agents: readonly string[]): string {
  let section = "";
  const retained = current
    .split(/\r?\n/)
    .filter((line) => {
      const heading = /^\s*\[\[?\s*([^[\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
      if (heading?.[1]) section = heading[1].toLowerCase();
      return section !== "linear_comments";
    })
    .join("\n")
    .trimEnd();
  const table = `[linear_comments]\nagents = [${agents.map((id) => `"${id}"`).join(", ")}]\n`;
  return retained === "" ? table : `${retained}\n\n${table}`;
}

export function writeLinearCommentAgents(path: string, agents: readonly string[]): Promise<void> {
  return updateConfigText(path, (text) => setLinearCommentAgentsText(text, agents));
}
