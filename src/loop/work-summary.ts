import { join } from "node:path";
import { loadConfigFile, readProjectMemorySettings } from "../config";
import { journalCaught } from "../journal";
import type { ProjectSessionContext } from "../project-context";

type WorkSummaryScope =
  | { organizationId: string; projectId: string; requesterId: string }
  | "none"
  | "withheld";

export async function recordPullRequestSummary(input: {
  service: ProjectSessionContext | null | undefined;
  pawsRoot: string;
  workItemId: string;
  scope: () => Promise<WorkSummaryScope>;
  pullUrl: () => Promise<string | null>;
  title: string;
  description: string;
  now: number;
  journal?: (line: string) => void;
}): Promise<void> {
  const record = input.service?.recordWorkSummary;
  if (!record) return;
  try {
    const config = loadConfigFile(join(input.pawsRoot, "config.toml"));
    if (!readProjectMemorySettings(config).workSummary) return;
    const scope = await input.scope();
    if (scope === "none") return;
    if (scope === "withheld") throw new Error("the item's delegating Linear session is unknown");
    await record({
      ...scope,
      workItemId: input.workItemId,
      url: await input.pullUrl(),
      title: input.title,
      description: input.description,
      now: input.now,
    });
  } catch (error) {
    journalCaught(error, "recordPullRequestSummary", input.workItemId, undefined, input.journal);
  }
}
