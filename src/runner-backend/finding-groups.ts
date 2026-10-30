import type { Database } from "bun:sqlite";
import type { RunnerHelpers } from "../runner-helpers";
import type { AgentProfile } from "../config";
import { createRunnerPlacement, type RunnerPlacement } from "../runner-placement";
import type { GroupingHelper } from "../finding-groups";
import { createRemoteSessionAgentRunner } from "./helpers";

/** One issued turn per day; shared helper lifecycle records usage and auth/quota outcomes. */
export function createFindingGroupHelper(options: {
  db: Database;
  helpers: () => Promise<RunnerHelpers>;
  profile: () => AgentProfile;
  placement?: RunnerPlacement;
}): GroupingHelper {
  const placement = options.placement ?? createRunnerPlacement({ db: options.db });
  return async (input) => {
    const scope = options.db
      .query(
        "SELECT 1 FROM linear_session s JOIN workspace w ON w.linear_organization_id=s.organization_id WHERE s.session_id=? AND w.id=?",
      )
      .get(input.sessionId, input.workspaceId);
    if (!scope) throw new Error("Finding grouping session is outside the workspace.");
    let text = "";
    const helper = createRemoteSessionAgentRunner({
      db: options.db,
      helpers: await options.helpers(),
      placement,
    });
    const result = await helper.forSession(
      input.sessionId,
      "finding_groups",
    )({
      role: "implementer",
      itemId: "",
      runId: "",
      worktreePath: "",
      pawsRoot: "",
      readOnly: true,
      onEvent: (event) => {
        if (
          event.type === "session_update" &&
          event.update.sessionUpdate === "agent_message_chunk" &&
          event.update.content.type === "text"
        )
          text += event.update.content.text;
      },
      profile: options.profile(),
      prompt: input.prompt,
      signal: input.signal,
      timeoutMs: 600_000,
    });
    return { text, ...(result.tokens === undefined ? {} : { tokens: result.tokens }) };
  };
}
