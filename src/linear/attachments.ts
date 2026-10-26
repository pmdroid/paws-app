import type { TrackerRequestOptions } from "./adapter";
import type { LinearClient } from "./graphql";
import type { IssueAttachment } from "./types";
import { isRecord } from "./read";

const LOOKUP = `query ArtifactAttachment($id: ID!) {
  attachments(first: 2, filter: {id: {eq: $id}}) {
    nodes { id title url issue { id identifier } }
  }
}`;
const CREATE = `mutation ArtifactAttachmentCreate($input: AttachmentCreateInput!) {
  attachmentCreate(input: $input) { success attachment { id title url issue { id identifier } } }
}`;

export function createLinearAttachmentMethods(client: LinearClient) {
  return {
    async deleteIssueAttachment(id: string, options?: TrackerRequestOptions): Promise<void> {
      const data = await client.query(LOOKUP, { id }, options);
      const connection = isRecord(data) ? data["attachments"] : null;
      const nodes = isRecord(connection) ? connection["nodes"] : null;
      if (!Array.isArray(nodes)) throw new Error("Linear attachment lookup returned invalid data");
      if (!nodes.length) return;
      const result = await client.query(
        `mutation EvidenceAttachmentDelete($id: String!) {
        attachmentDelete(id: $id) { success }
      }`,
        { id },
        options,
      );
      const receipt = isRecord(result) ? result["attachmentDelete"] : null;
      if (!isRecord(receipt) || receipt["success"] !== true)
        throw new Error("Linear attachment deletion was not confirmed");
    },
    async createIssueAttachment(
      input: IssueAttachment,
      options?: TrackerRequestOptions,
    ): Promise<void> {
      validateAttachment(input);
      options?.signal?.throwIfAborted();
      const data = await client.query(LOOKUP, { id: input.id }, options);
      options?.signal?.throwIfAborted();
      const connection = isRecord(data) ? data["attachments"] : null;
      const nodes = isRecord(connection) ? connection["nodes"] : null;
      if (!Array.isArray(nodes) || nodes.length > 1)
        throw new Error("Linear attachment lookup returned invalid data");
      if (nodes.length === 1) {
        if (!matches(nodes[0], input, true))
          throw new Error("Linear attachment identity does not match the deliverable");
        return;
      }
      const { evidence: _evidence, ...fields } = input;
      const result = await client.query(CREATE, { input: fields }, options);
      options?.signal?.throwIfAborted();
      const receipt = isRecord(result) ? result["attachmentCreate"] : null;
      if (
        !isRecord(receipt) ||
        receipt["success"] !== true ||
        !matches(receipt["attachment"], input, false)
      ) {
        throw new Error("Linear attachment creation was not confirmed");
      }
    },
  };
}

function matches(value: unknown, input: IssueAttachment, exactId: boolean): boolean {
  if (!isRecord(value)) return false;
  const issue = value["issue"];
  return (
    typeof value["id"] === "string" &&
    (!exactId || value["id"] === input.id) &&
    value["title"] === input.title &&
    value["url"] === input.url &&
    isRecord(issue) &&
    (issue["id"] === input.issueId || issue["identifier"] === input.issueId)
  );
}

function validateAttachment(input: IssueAttachment): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.id)) {
    throw new Error("Issue attachment requires a UUID v4");
  }
  if (
    !input.issueId.trim() ||
    !input.title.trim() ||
    input.title.length > 255 ||
    /[\r\n\0]/.test(input.title)
  ) {
    throw new Error("Issue attachment requires an issue and a valid title");
  }
  const url = new URL(input.url);
  if (
    (input.evidence ? url.protocol !== "https:" : url.origin !== "https://uploads.linear.app") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Issue attachment requires a published Linear asset URL");
  }
}
