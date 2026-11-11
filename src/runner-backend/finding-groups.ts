import { linearSessionInWorkspace, type Db } from "../db";
import type { RunnerHelpers } from "../runner-helpers";
import type { AgentProfile } from "../config";
import { createRunnerPlacement, type RunnerPlacement } from "../runner-placement";
import type { GroupingHelper } from "../finding-groups";
import { createRemoteSessionAgentRunner } from "./helpers";

/** One issued turn per day; shared helper lifecycle records usage and auth/quota outcomes. */
export function createFindingGroupHelper(options: {
  store: Db;
  helpers: () => Promise<RunnerHelpers>;
  profile: () => AgentProfile;
  placement?: RunnerPlacement;
}): GroupingHelper {
  const placement = options.placement ?? createRunnerPlacement({ store: options.store });
  return async (input) => {
    if (!(await linearSessionInWorkspace(options.store, input.sessionId, input.workspaceId)))
      throw new Error("Finding grouping session is outside the workspace.");
    let text = "";
    const helper = createRemoteSessionAgentRunner({
      store: options.store,
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
