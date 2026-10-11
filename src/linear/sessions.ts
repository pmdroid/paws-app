import type { TrackerAdapter } from "./adapter";
import type { LinearClient } from "./graphql";
import { isRecord, readString } from "./read";
import type {
  ActivityReceipt,
  SessionElicitation,
  ProgressUpdate,
  SessionOnComment,
  SessionOnIssue,
  SessionReceipt,
  SessionUpdate,
  SessionUrl,
} from "./types";

export interface LinearSessionAdapter extends TrackerAdapter {
  createActivity(update: ProgressUpdate): Promise<ActivityReceipt>;
  createElicitation(question: SessionElicitation): Promise<ActivityReceipt>;
  updateSession(update: SessionUpdate): Promise<SessionReceipt>;
  createSessionOnIssue(input: SessionOnIssue): Promise<SessionReceipt>;
  createSessionOnComment(input: SessionOnComment): Promise<SessionReceipt>;
}

const ACTIVITY_MUTATION = `mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
  agentActivityCreate(input: $input) { success agentActivity { id } }
}`;

const SESSION_UPDATE_MUTATION = `mutation AgentSessionUpdate($id: String!, $input: AgentSessionUpdateInput!) {
  agentSessionUpdate(id: $id, input: $input) { success agentSession { id } }
}`;

const SESSION_ISSUE_MUTATION = `mutation AgentSessionCreateOnIssue($input: AgentSessionCreateOnIssue!) {
  agentSessionCreateOnIssue(input: $input) { success agentSession { id } }
}`;

const SESSION_COMMENT_MUTATION = `mutation AgentSessionCreateOnComment($input: AgentSessionCreateOnComment!) {
  agentSessionCreateOnComment(input: $input) { success agentSession { id } }
}`;

export function createLinearSessionMethods(client: LinearClient) {
  async function sendActivity(input: Record<string, unknown>): Promise<ActivityReceipt> {
    const data = await client.query(ACTIVITY_MUTATION, { input });
    const receipt = mutationReceipt(data, "agentActivityCreate", "agentActivity");
    if (input["id"] !== undefined && receipt.id !== input["id"]) {
      throw new Error("Linear agentActivityCreate returned a different activity ID");
    }
    return receipt;
  }

  return {
    async createActivity(update: ProgressUpdate): Promise<ActivityReceipt> {
      return sendActivity(activityInput(update));
    },
    async createElicitation(question: SessionElicitation): Promise<ActivityReceipt> {
      return sendActivity(elicitationInput(question));
    },
    async updateSession(update: SessionUpdate): Promise<SessionReceipt> {
      const { sessionId, ...input } = update;
      validateSessionUpdate(update);
      const data = await client.query(SESSION_UPDATE_MUTATION, { id: sessionId, input });
      const receipt = mutationReceipt(data, "agentSessionUpdate", "agentSession");
      if (receipt.id !== sessionId) {
        throw new Error("Linear agentSessionUpdate returned a different session ID");
      }
      return receipt;
    },
    async createSessionOnIssue(input: SessionOnIssue): Promise<SessionReceipt> {
      validateUrls(input.externalUrls);
      const data = await client.query(SESSION_ISSUE_MUTATION, { input });
      return mutationReceipt(data, "agentSessionCreateOnIssue", "agentSession");
    },
    async createSessionOnComment(input: SessionOnComment): Promise<SessionReceipt> {
      validateUrls(input.externalUrls);
      const data = await client.query(SESSION_COMMENT_MUTATION, { input });
      return mutationReceipt(data, "agentSessionCreateOnComment", "agentSession");
    },
  };
}

export function activityInput(update: ProgressUpdate): Record<string, unknown> {
  validateActivityId(update.id);
  if (update.ephemeral && update.kind !== "thought" && update.kind !== "action") {
    throw new Error("Only Linear thought and action activities can be ephemeral");
  }
  if (update.action !== undefined && update.kind !== "action") {
    throw new Error("Structured action details require an action activity");
  }
  const content =
    update.kind === "action"
      ? { type: "action", ...(update.action ?? { action: "update", parameter: update.body }) }
      : { type: update.kind, body: update.body };
  return {
    agentSessionId: update.sessionId,
    content,
    ...(update.id === undefined ? {} : { id: update.id }),
    ...(update.ephemeral === undefined ? {} : { ephemeral: update.ephemeral }),
  };
}

export function elicitationInput(question: SessionElicitation): Record<string, unknown> {
  validateActivityId(question.id);
  const options = question.options ?? [];
  if (question.auth !== undefined && options.length > 0) {
    throw new Error("Linear authentication and select signals cannot be combined");
  }
  const input: Record<string, unknown> = {
    agentSessionId: question.sessionId,
    content: { type: "elicitation", body: question.body },
    ...(question.id === undefined ? {} : { id: question.id }),
  };
  if (question.auth !== undefined) {
    validateUrl(question.auth.url);
    input["signal"] = "auth";
    input["signalMetadata"] = question.auth;
  } else if (options.length > 0) {
    input["signal"] = "select";
    input["signalMetadata"] = {
      options: options.map((option) =>
        typeof option === "string" ? { label: option, value: option } : option,
      ),
    };
  }
  return input;
}

export function validateSessionUpdate(update: SessionUpdate): void {
  if (
    update.externalUrls !== undefined &&
    (update.addedExternalUrls !== undefined || update.removedExternalUrls !== undefined)
  ) {
    throw new Error("Linear session URL replacement cannot be combined with incremental updates");
  }
  validateUrls(update.externalUrls);
  validateUrls(update.addedExternalUrls);
  for (const url of update.removedExternalUrls ?? []) validateUrl(url);
  if (update.summary !== undefined && update.summary !== null) {
    if (
      [...update.summary].length > 255 ||
      update.summary.trim().length === 0 ||
      /[\r\n\0]/.test(update.summary)
    ) {
      throw new Error("Linear session summary requires 1 to 255 characters without line breaks");
    }
  }
  for (const step of update.plan ?? []) {
    if (!["pending", "inProgress", "completed", "canceled"].includes(step.status)) {
      throw new Error("Invalid Linear session plan status");
    }
  }
}

export function validateUrls(urls: readonly SessionUrl[] | undefined): void {
  const seen = new Set<string>();
  for (const entry of urls ?? []) {
    validateUrl(entry.url);
    if (seen.has(entry.url)) throw new Error("Linear session URLs must be unique");
    seen.add(entry.url);
  }
}

function validateUrl(value: string): void {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Linear session links require an HTTP or HTTPS URL");
  }
}

function validateActivityId(id: string | undefined): void {
  if (
    id !== undefined &&
    !/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(id)
  ) {
    throw new Error("Linear activity IDs must be UUID v4 identifiers");
  }
}

function mutationReceipt(data: unknown, operation: string, entity: string): { id: string } {
  const payload = isRecord(data) && isRecord(data[operation]) ? data[operation] : null;
  if (payload?.["success"] !== true) throw new Error(`Linear ${operation} was unsuccessful`);
  const record = isRecord(payload[entity]) ? payload[entity] : null;
  const id = record === null ? null : readString(record, "id");
  if (id === null) throw new Error(`Linear ${operation} was missing the ${entity} ID`);
  return { id };
}
