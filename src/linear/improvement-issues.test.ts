import { describe, expect, test } from "bun:test";
import { LinearRateLimitError } from "./budget";
import { LinearHttpError, type LinearClient } from "./graphql";
import { createLinearImprovementDelivery } from "./improvement-issues";

const ISSUE = {
  id: "11111111-1111-4111-8111-111111111111",
  identifier: "PAS-9",
  url: "https://linear.app/x/PAS-9",
  team: { id: "team-a" },
  state: { type: "triage" },
  delegate: null,
};

function client(answer: (query: string, variables: Record<string, unknown>) => unknown) {
  const calls: { query: string; variables: Record<string, unknown> }[] = [];
  const fake: LinearClient = {
    async query(query, variables = {}) {
      calls.push({ query, variables });
      return answer(query, variables);
    },
  };
  return { fake, calls };
}

describe("Linear improvement delivery", () => {
  test("creates the issue with the client-supplied id, Triage, the label and no delegate", async () => {
    const { fake, calls } = client((query) => {
      if (query.includes("PawsImprovementTeam"))
        return {
          team: {
            states: {
              nodes: [
                { id: "backlog", type: "backlog", position: 0 },
                { id: "triage", type: "triage", position: 1 },
              ],
            },
          },
          issueLabels: { nodes: [{ id: "other-team", isGroup: false, team: { id: "team-b" } }] },
        };
      if (query.includes("issueLabelCreate"))
        return { issueLabelCreate: { success: true, issueLabel: { id: "label-1" } } };
      return { issueCreate: { success: true, issue: ISSUE } };
    });
    const result = await createLinearImprovementDelivery(fake).createIssue({
      id: ISSUE.id,
      teamId: "team-a",
      title: "Make recovery durable",
      description: "Body",
      label: "paws retro",
    });
    expect(result).toEqual({
      ok: true,
      value: {
        id: ISSUE.id,
        identifier: "PAS-9",
        url: ISSUE.url,
        teamId: "team-a",
        state: "open",
        stateType: "triage",
        delegated: false,
        description: null,
      },
    });
    expect(calls.at(-1)!.variables["input"]).toEqual({
      id: ISSUE.id,
      teamId: "team-a",
      title: "Make recovery durable",
      description: "Body",
      labelIds: ["label-1"],
      stateId: "triage",
      delegateId: null,
    });
  });

  test("an empty lookup is not a failure and a closed issue reads as closed", async () => {
    const delivery = createLinearImprovementDelivery(
      client((_query, variables) =>
        variables["id"] === ISSUE.id
          ? { issues: { nodes: [{ ...ISSUE, state: { type: "canceled" } }] } }
          : { issues: { nodes: [] } },
      ).fake,
    );
    expect(await delivery.findIssue("missing")).toEqual({ ok: true, value: null });
    expect(await delivery.findIssue(ISSUE.id)).toMatchObject({
      ok: true,
      value: { state: "closed" },
    });
  });

  test("classifies refusals before a write apart from writes with unknown effect", async () => {
    const headers = new Headers();
    const failing = (error: unknown) =>
      createLinearImprovementDelivery(
        client(() => {
          throw error;
        }).fake,
      );
    expect(await failing(new LinearHttpError(429, "", headers)).findIssue("x")).toMatchObject({
      ok: false,
      failure: "rate_limited",
    });
    expect(
      await failing(
        new LinearRateLimitError(30_000, {
          requestsRemaining: 0,
          requestsLimit: 1,
          requestsResetMs: null,
          complexityRemaining: null,
          complexityLimit: null,
          complexityResetMs: null,
          complexity: null,
        }),
      ).findIssue("x"),
    ).toMatchObject({ ok: false, failure: "rate_limited", retryAfterMs: 30_000 });
    expect(await failing(new LinearHttpError(401, "", headers)).findIssue("x")).toMatchObject({
      ok: false,
      failure: "unauthorized",
    });
    expect(await failing(new TypeError("fetch failed")).findIssue("x")).toMatchObject({
      ok: false,
      failure: "unavailable",
    });
    expect(
      await failing(new TypeError("fetch failed")).createComment({
        id: "c",
        issueId: "i",
        body: "b",
      }),
    ).toMatchObject({ ok: false, failure: "unknown" });
  });

  test("a create whose response is lost reports an unknown outcome", async () => {
    const delivery = createLinearImprovementDelivery(
      client((query) => {
        if (query.includes("PawsImprovementTeam"))
          return {
            team: { states: { nodes: [] } },
            issueLabels: { nodes: [{ id: "label-1", isGroup: false, team: null }] },
          };
        throw new LinearHttpError(502, "", new Headers());
      }).fake,
    );
    expect(
      await delivery.createIssue({
        id: ISSUE.id,
        teamId: "team-a",
        title: "t",
        description: "d",
        label: "paws retro",
      }),
    ).toMatchObject({ ok: false, failure: "unknown" });
  });
});
