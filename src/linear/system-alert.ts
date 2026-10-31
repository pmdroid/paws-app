import type { TrackerRequestOptions } from "./adapter";
import type { LinearClient } from "./graphql";
import { isRecord } from "./read";

export type SystemAlert = { id: string; issueId: string; body: string };

export function createSystemAlertMethods(client: LinearClient) {
  return {
    async postSystemAlert(input: SystemAlert, options?: TrackerRequestOptions): Promise<void> {
      options?.signal?.throwIfAborted();
      const data = await client.query(
        `query SystemAlert($id: ID!) {
        comments(filter: { id: { eq: $id } }, first: 2) { nodes { id body issue { id } } }
      }`,
        { id: input.id },
        options,
      );
      const connection = isRecord(data) ? data.comments : null;
      const nodes = isRecord(connection) ? connection.nodes : null;
      if (!Array.isArray(nodes) || nodes.length > 1) throw new Error("Invalid system alert lookup");
      if (nodes.length === 1) {
        const node = nodes[0];
        if (
          !isRecord(node) ||
          node.body !== input.body ||
          !isRecord(node.issue) ||
          node.issue.id !== input.issueId
        )
          throw new Error("System alert identity does not match");
        return;
      }
      const result = await client.query(
        `mutation SystemAlertCreate($input: CommentCreateInput!) {
        commentCreate(input: $input) { success comment { id } }
      }`,
        { input },
        options,
      );
      const receipt = isRecord(result) ? result.commentCreate : null;
      if (
        !isRecord(receipt) ||
        receipt.success !== true ||
        !isRecord(receipt.comment) ||
        receipt.comment.id !== input.id
      )
        throw new Error("System alert creation was not confirmed");
    },
  };
}
