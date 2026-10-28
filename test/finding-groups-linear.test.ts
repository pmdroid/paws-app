import { expect, test } from "bun:test";
import {
  LinearEntityNotFoundError,
  LinearGraphQLError,
  LinearHttpError,
  createFindingIssueAdapter,
} from "../src/linear";

function fakeLinear() {
  const calls: { query: string; variables: Record<string, unknown> }[] = [];
  const issues = new Map<string, string>();
  const comments = new Set<string>();
  let triage = true;
  let targetError: unknown;
  let mutationError: unknown;
  let refused = false;
  let stateType = "started";
  let teamId = "team";
  const adapter = createFindingIssueAdapter({
    async query(query, variables = {}) {
      calls.push({ query, variables });
      if (query.includes("FindingOpenIssues"))
        return {
          issues: {
            nodes: [{ identifier: "PAS-20", title: "Fix secrets" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      if (query.includes("FindingFiled"))
        return {
          issues: {
            nodes: issues.has(String(variables.id))
              ? [{ id: variables.id, identifier: issues.get(String(variables.id)) }]
              : [],
          },
        };
      if (query.includes("FindingTriage"))
        return {
          team: {
            states: { nodes: triage ? [{ id: "triage", type: "triage" }] : [] },
            labels: { nodes: [{ id: "label", name: "review finding" }] },
          },
        };
      const input = variables.input as Record<string, unknown>;
      if (query.includes("FindingGroupIssue")) {
        if (mutationError) throw mutationError;
        if (refused) return { issueCreate: { success: false, issue: null } };
        issues.set(String(input.id), "PAS-21");
        return { issueCreate: { success: true, issue: { id: input.id, identifier: "PAS-21" } } };
      }
      if (query.includes("FindingGroupTarget") && targetError) throw targetError;
      if (query.includes("FindingGroupTarget"))
        return {
          issue: {
            id: "target",
            identifier: "PAS-20",
            team: { id: teamId },
            state: { type: stateType },
            comments: {
              nodes: comments.has(String(variables.comment)) ? [{ id: variables.comment }] : [],
            },
          },
        };
      if (query.includes("FindingGroupComment")) {
        comments.add(String(input.id));
        return { commentCreate: { success: true } };
      }
      throw new Error(`Unexpected query: ${query}`);
    },
  });
  return {
    adapter,
    calls,
    failTarget: (error: unknown) => {
      targetError = error;
    },
    failMutation: (error: unknown) => {
      mutationError = error;
    },
    refuse: () => {
      refused = true;
    },
    setTriage: (enabled: boolean) => {
      triage = enabled;
    },
    setTarget: (state: string, team = "team") => {
      stateType = state;
      teamId = team;
    },
  };
}

test("group issue is a single undelegated Triage issue with review finding label and stable retries", async () => {
  const f = fakeLinear();
  const input = {
    key: "group",
    teamId: "team",
    title: "Use constant-time comparisons",
    description: "Shared fix\n\nsrc/auth.ts:12 (P1): Unsafe compare",
  };
  expect(await f.adapter.file(input)).toBe("PAS-21");
  expect(await f.adapter.file(input)).toBe("PAS-21");
  const writes = f.calls.filter((c) => c.query.includes("FindingGroupIssue"));
  expect(writes).toHaveLength(1);
  expect(writes[0]!.variables.input).toMatchObject({
    teamId: "team",
    title: input.title,
    description: input.description,
    stateId: "triage",
    labelIds: ["label"],
    delegateId: null,
  });
  expect(writes[0]!.variables.input).not.toHaveProperty("parentId");
});

test("existing-issue comments retry with one stable id and reject closed or other-team issues", async () => {
  const f = fakeLinear();
  const input = {
    key: "group",
    teamId: "team",
    identifier: "PAS-20",
    body: "Shared fix\n\nsrc/auth.ts:12 (P1): Unsafe compare",
  };
  await f.adapter.add(input);
  await f.adapter.add(input);
  expect(f.calls.filter((c) => c.query.includes("FindingGroupComment"))).toHaveLength(1);
  expect(
    f.calls.find((c) => c.query.includes("FindingGroupComment"))!.variables.input,
  ).toMatchObject({ issueId: "target", body: input.body });
  f.setTarget("completed");
  await expect(f.adapter.add({ ...input, key: "other-group" })).rejects.toThrow("no longer open");
  f.setTarget("started", "other");
  await expect(f.adapter.add({ ...input, key: "other-group" })).rejects.toThrow("outside");
});

test("only open titles for requested teams are read", async () => {
  const f = fakeLinear();
  expect(await f.adapter.openTitles(["team"], new AbortController().signal)).toEqual([
    { teamId: "team", identifier: "PAS-20", title: "Fix secrets" },
  ]);
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]!.variables).toEqual({ team: "team", after: null });
  expect(f.calls[0]!.query).toContain('nin:["completed","canceled"]');
  expect(f.calls[0]!.query).not.toContain("description");
});

test("missing Triage is a definitive no-write refusal that routes can safely unlock", async () => {
  const f = fakeLinear();
  f.setTriage(false);
  let error: unknown;
  try {
    await f.adapter.file({ key: "group", teamId: "team", title: "Fix", description: "Findings" });
  } catch (caught) {
    error = caught;
  }
  expect(error).toMatchObject({ noFindingWrite: true });
  expect(f.calls.filter((c) => c.query.includes("FindingGroupIssue"))).toHaveLength(0);
});

test("missing or unreadable suggested targets release actions, while transport errors stay uncertain", async () => {
  for (const error of [
    new LinearEntityNotFoundError("Entity not found: Issue"),
    new LinearHttpError(403, "", new Headers()),
  ]) {
    const f = fakeLinear();
    f.failTarget(error);
    await expect(
      f.adapter.add({ key: "group", teamId: "team", identifier: "PAS-20", body: "Findings" }),
    ).rejects.toMatchObject({ noFindingWrite: true });
    expect(f.calls.some((c) => c.query.includes("FindingGroupComment"))).toBe(false);
  }
  const f = fakeLinear();
  const offline = new Error("Connection reset");
  f.failTarget(offline);
  await expect(
    f.adapter.add({ key: "group", teamId: "team", identifier: "PAS-20", body: "Findings" }),
  ).rejects.toBe(offline);
});

test("deterministically rejected issue mutations release actions without treating timeouts as refusals", async () => {
  const input = { key: "group", teamId: "team", title: "Fix findings", description: "Shared fix" };
  const f = fakeLinear();
  f.refuse();
  await expect(f.adapter.file(input)).rejects.toMatchObject({ noFindingWrite: true });
  const validation = fakeLinear();
  validation.failMutation(
    new LinearGraphQLError("Invalid input", [{ extensions: { code: "BAD_USER_INPUT" } }]),
  );
  await expect(validation.adapter.file(input)).rejects.toMatchObject({ noFindingWrite: true });
  const transport = fakeLinear();
  const timeout = new Error("Timeout after write");
  transport.failMutation(timeout);
  await expect(transport.adapter.file(input)).rejects.toBe(timeout);
});
