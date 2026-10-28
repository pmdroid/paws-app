import { setTimeout as delay } from "node:timers/promises";
import type { Database } from "bun:sqlite";
import type { RunnerHelpers } from "../runner-helpers";
import type { AgentProfile } from "../config";
import { eligibleRunners } from "../runner-placement";
import { FINDING_GROUPS_RUNNER_VERSION } from "../runner-protocol";
import type { GroupingHelper } from "../finding-groups";
import { versionAtLeast } from "./session-restore";

/** One dispatch, without failover: a daily job cannot spend a second helper turn. */
export function createFindingGroupHelper(options: {
  db: Database;
  helpers: () => Promise<RunnerHelpers>;
  profile: () => AgentProfile;
}): GroupingHelper {
  return async (input) => {
    input.signal.throwIfAborted();
    const helpers = await options.helpers();
    const profile = options.profile();
    const owners = options.db
      .query<{ userId: string }, [string]>(
        "SELECT user_id AS userId FROM workspace_member WHERE workspace_id=? AND active=1 AND role IN ('owner','admin') ORDER BY user_id",
      )
      .all(input.workspaceId);
    const session = options.db
      .query<{ teamId: string }, [string]>(
        "SELECT team_id AS teamId FROM linear_session WHERE session_id=?",
      )
      .get(input.sessionId);
    if (!session) throw new Error("Finding grouping needs a reporting session.");
    let id: string | null = null;
    for (const owner of owners) {
      const candidates = eligibleRunners(options.db, {
        workspaceId: input.workspaceId,
        teamId: session.teamId,
        ownerUserId: owner.userId,
        leadUserIds: [],
        agent: profile.agent,
        purpose: "work",
      });
      for (const runner of candidates.filter((r) => r.eligible)) {
        const health = options.db
          .query<{ version: string | null }, [string]>(
            "SELECT runner_version AS version FROM runner_host_status WHERE runner_id=?",
          )
          .get(runner.id);
        if (!versionAtLeast(health?.version, FINDING_GROUPS_RUNNER_VERSION)) continue;
        try {
          id = helpers.dispatch({
            runnerId: runner.id,
            sessionId: input.sessionId,
            purpose: "finding_groups",
            profile,
            prompt: input.prompt,
          }).command.id;
          break;
        } catch (error) {
          // Busy runners are safe to skip before a command is issued.
          if (!(error instanceof Error) || !/busy|capacity/i.test(error.message)) throw error;
        }
      }
      if (id) break;
    }
    if (!id)
      throw new Error(
        "No available admin runner supports finding grouping. Update a paired runner and check agent sign-in.",
      );
    try {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        input.signal.throwIfAborted();
        const result = helpers.result(id);
        if (result) {
          if (
            result.stopReason !== "end_turn" ||
            result.timedOut ||
            result.cancelled ||
            result.authRequired ||
            !result.agentExited
          )
            throw new Error("Finding grouping helper did not complete.");
          return {
            text: result.text,
            ...(result.tokens === undefined ? {} : { tokens: result.tokens }),
          };
        }
        await delay(250, undefined, { signal: input.signal });
      }
      throw new Error("Finding grouping helper timed out.");
    } finally {
      helpers.finish(id);
    }
  };
}
