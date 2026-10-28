import { z } from "zod";
import {
  LinearEntityNotFoundError,
  LinearHttpError,
  LinearGraphQLError,
  type LinearClient,
} from "./graphql";
import { stableUuid } from "./sub-issues";

export type FindingIssueTitle = { identifier: string; title: string; teamId: string };
export interface FindingIssueAdapter {
  openTitles(teamIds: readonly string[], signal: AbortSignal): Promise<FindingIssueTitle[]>;
  file(input: { key: string; teamId: string; title: string; description: string }): Promise<string>;
  add(input: { key: string; teamId: string; identifier: string; body: string }): Promise<void>;
}
/** A deterministic refusal before any issue/comment mutation. Safe to release a new action claim. */
class FindingWriteRefused extends Error {
  readonly noFindingWrite = true;
}
function definiteRefusal(error: unknown): boolean {
  return (
    error instanceof LinearEntityNotFoundError ||
    (error instanceof LinearHttpError && [400, 401, 403, 404, 422].includes(error.status)) ||
    (error instanceof LinearGraphQLError &&
      error.codes.length > 0 &&
      error.codes.length === error.errorsCount &&
      error.codes.every((code) =>
        [
          "BAD_USER_INPUT",
          "INPUT_ERROR",
          "VALIDATION_ERROR",
          "GRAPHQL_VALIDATION_FAILED",
          "FORBIDDEN",
          "UNAUTHENTICATED",
          "NOT_FOUND",
          "ENTITY_NOT_FOUND",
          "PERMISSION_DENIED",
        ].includes(code),
      ))
  );
}
async function findingWrite(
  client: LinearClient,
  query: string,
  variables: Record<string, unknown>,
  operation: "issueCreate" | "commentCreate",
) {
  let data: unknown;
  try {
    data = await client.query(query, variables);
  } catch (error) {
    if (definiteRefusal(error))
      throw new FindingWriteRefused(
        "Linear refused this finding write. Check the issue and team access.",
      );
    throw error;
  }
  if (z.object({ [operation]: z.object({ success: z.literal(false) }) }).safeParse(data).success)
    throw new FindingWriteRefused("Linear did not accept this finding write.");
  return data;
}
const node = z.object({ id: z.string() });
const page = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
const issue = node.extend({ identifier: z.string() });
export function createFindingIssueAdapter(client: LinearClient): FindingIssueAdapter {
  async function existing(id: string) {
    return z
      .object({ issues: z.object({ nodes: z.array(issue) }) })
      .parse(
        await client.query(
          `query FindingFiled($id: ID!) { issues(filter:{id:{eq:$id}},first:1) { nodes { id identifier } } }`,
          { id },
        ),
      ).issues.nodes[0];
  }
  return {
    async openTitles(teamIds, signal) {
      const result: FindingIssueTitle[] = [];
      for (const teamId of teamIds) {
        let after: string | null = null;
        do {
          const data: {
            nodes: { identifier: string; title: string }[];
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          } = z
            .object({
              issues: z.object({
                nodes: z.array(z.object({ identifier: z.string(), title: z.string() })),
                pageInfo: page,
              }),
            })
            .parse(
              await client.query(
                `query FindingOpenIssues($team: ID!, $after: String) {
              issues(first:100,after:$after,filter:{team:{id:{eq:$team}},state:{type:{nin:["completed","canceled"]}}}) {
                nodes { identifier title } pageInfo { hasNextPage endCursor }
              }
            }`,
                { team: teamId, after },
                { signal },
              ),
            ).issues;
          result.push(...data.nodes.map((i) => ({ ...i, teamId })));
          if (
            data.pageInfo.hasNextPage &&
            (!data.pageInfo.endCursor || data.pageInfo.endCursor === after)
          )
            throw new Error("Linear issue pagination did not advance");
          after = data.pageInfo.hasNextPage ? data.pageInfo.endCursor : null;
        } while (after);
      }
      return result;
    },
    async file(input) {
      const id = stableUuid(`paws:finding-group:${input.key}`);
      const previous = await existing(id);
      if (previous) return previous.identifier;
      const prepared = await (async () => {
        const team = z
          .object({
            team: z.object({
              states: z.object({ nodes: z.array(node.extend({ type: z.string() })) }),
              labels: z.object({ nodes: z.array(node.extend({ name: z.string() })) }),
            }),
          })
          .parse(
            await client.query(
              `query FindingTriage($id: String!) { team(id:$id) {
          states(first:100) { nodes { id type } }
          labels(first:100,filter:{name:{eq:"review finding"}}) { nodes { id name } }
        } }`,
              { id: input.teamId },
            ),
          ).team;
        const stateId = team.states.nodes.find((s) => s.type === "triage")?.id;
        if (!stateId)
          throw new FindingWriteRefused("The Linear team needs a Triage state to file findings.");
        let labelId = team.labels.nodes.find((l) => l.name === "review finding")?.id;
        if (!labelId) {
          const created = z
            .object({ issueLabelCreate: z.object({ success: z.literal(true), issueLabel: node }) })
            .parse(
              await client.query(
                `mutation FindingLabel($input: IssueLabelCreateInput!) { issueLabelCreate(input:$input) { success issueLabel { id } } }`,
                { input: { name: "review finding", teamId: input.teamId } },
              ),
            );
          labelId = created.issueLabelCreate.issueLabel.id;
        }
        return { stateId, labelId };
      })().catch((error) => {
        if (error instanceof FindingWriteRefused) throw error;
        throw new FindingWriteRefused(
          "Linear could not prepare the Triage state and review finding label. Check team access before retrying.",
        );
      });
      const created = z
        .object({ issueCreate: z.object({ success: z.literal(true), issue }) })
        .parse(
          await findingWrite(
            client,
            `mutation FindingGroupIssue($input: IssueCreateInput!) { issueCreate(input:$input) { success issue { id identifier } } }`,
            {
              input: {
                id,
                teamId: input.teamId,
                title: input.title,
                description: input.description,
                stateId: prepared.stateId,
                labelIds: [prepared.labelId],
                delegateId: null,
              },
            },
            "issueCreate",
          ),
        );
      return created.issueCreate.issue.identifier;
    },
    async add(input) {
      const target = z
        .object({
          issue: issue.extend({
            team: node,
            state: z.object({ type: z.string() }),
            comments: z.object({ nodes: z.array(node) }),
            archivedAt: z.string().nullable().optional(),
          }),
        })
        .parse(
          await client
            .query(
              `query FindingGroupTarget($id: String!, $comment: ID!) { issue(id:$id) {
          id identifier archivedAt team { id } state { type } comments(first:1,filter:{id:{eq:$comment}}) { nodes { id } }
        } }`,
              {
                id: input.identifier,
                comment: stableUuid(`paws:finding-group-comment:${input.key}`),
              },
            )
            .then((data) => {
              if (z.object({ issue: z.null() }).safeParse(data).success)
                throw new FindingWriteRefused("The suggested issue is unavailable.");
              return data;
            })
            .catch((error) => {
              if (definiteRefusal(error))
                throw new FindingWriteRefused(
                  "The suggested issue is unavailable. Check its access or choose another action.",
                );
              throw error;
            }),
        ).issue;
      if (target.team.id !== input.teamId)
        throw new FindingWriteRefused("The suggested issue is outside this group's team.");
      if (target.comments.nodes.length) return;
      if (target.archivedAt || ["completed", "canceled"].includes(target.state.type))
        throw new FindingWriteRefused("The suggested issue is no longer open.");
      z.object({ commentCreate: z.object({ success: z.literal(true) }) }).parse(
        await findingWrite(
          client,
          `mutation FindingGroupComment($input: CommentCreateInput!) { commentCreate(input:$input) { success } }`,
          {
            input: {
              id: stableUuid(`paws:finding-group-comment:${input.key}`),
              issueId: target.id,
              body: input.body,
            },
          },
          "commentCreate",
        ),
      );
    },
  };
}

export function createFakeFindingIssueAdapter(initial: FindingIssueTitle[] = []) {
  const reads: string[][] = [];
  const files: Parameters<FindingIssueAdapter["file"]>[0][] = [];
  const comments: Parameters<FindingIssueAdapter["add"]>[0][] = [];
  const adapter: FindingIssueAdapter = {
    async openTitles(teamIds) {
      reads.push([...teamIds]);
      return initial.filter((i) => teamIds.includes(i.teamId));
    },
    async file(input) {
      if (!files.some((f) => f.key === input.key)) files.push(input);
      return `PAS-${files.findIndex((f) => f.key === input.key) + 1}`;
    },
    async add(input) {
      if (!comments.some((c) => c.key === input.key)) comments.push(input);
    },
  };
  return { ...adapter, reads, files, comments };
}
