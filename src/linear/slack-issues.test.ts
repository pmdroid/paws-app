import { expect, test } from "bun:test";
import { createLinearSlackIssueMethods, slackIssueId } from "./slack-issues";

test("a Slack issue is created once under its stable id, never in another team, and teams resolve only when unique", async () => {
  const id = slackIssueId("thread-1");
  const existing: Record<string, unknown>[] = [];
  const creates: unknown[] = [];
  const team = { id: "team-eng", key: "ENG", name: "Engineering", private: true };
  const teams: unknown[] = [team];
  const methods = createLinearSlackIssueMethods({
    async query(text: string, variables?: Record<string, unknown>) {
      if (text.includes("SlackIssueTeam")) return { teams: { nodes: teams } };
      if (text.includes("SlackIssueFiled"))
        return { viewer: { id: "paws-app" }, issues: { nodes: existing } };
      const input = variables?.["input"] as Record<string, unknown>;
      creates.push(input);
      const owner = { id: input["teamId"] };
      existing.push({ id: input["id"], identifier: "ENG-7", url: null, team: owner });
      return { issueCreate: { success: true, issue: existing.at(-1) } };
    },
  });
  const request = { key: "thread-1", teamId: "team-eng", title: "Retry", description: "Scope" };
  const first = await methods.fileSlackIssue(request);
  expect(await methods.fileSlackIssue(request)).toEqual(first);
  expect(first).toEqual({ id, identifier: "ENG-7", url: null });
  expect(creates).toEqual([
    { id, delegateId: "paws-app", teamId: "team-eng", title: "Retry", description: "Scope" },
  ]);
  await expect(methods.fileSlackIssue({ ...request, teamId: "team-ops" })).rejects.toThrow(
    "another team",
  );
  expect(await methods.slackIssueTeam("eng")).toEqual(team);
  teams.push({ ...team, id: "team-2" });
  expect(await methods.slackIssueTeam("eng")).toBeNull();
});
