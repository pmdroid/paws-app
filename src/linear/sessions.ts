import { createLinearIssueContextReads } from "./issue-context";
import { createLinearSessionReads } from "./history";
import type { LinearSessionSnapshot, LinearActivitySnapshot } from "./history";
import type { TrackerAdapter, TrackerRequestOptions } from "./adapter";
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
  getSession?(id: string, options?: TrackerRequestOptions): Promise<LinearSessionSnapshot>;
  listSessionActivities?(
    id: string,
    options?: TrackerRequestOptions,
  ): Promise<readonly LinearActivitySnapshot[]>;
  createActivity(update: ProgressUpdate, options?: TrackerRequestOptions): Promise<ActivityReceipt>;
  createElicitation(
    question: SessionElicitation,
    options?: TrackerRequestOptions,
  ): Promise<ActivityReceipt>;
  updateSession(update: SessionUpdate, options?: TrackerRequestOptions): Promise<SessionReceipt>;
  createSessionOnIssue(
    input: SessionOnIssue,
    options?: TrackerRequestOptions,
  ): Promise<SessionReceipt>;
  createSessionOnComment(
    input: SessionOnComment,
    options?: TrackerRequestOptions,
  ): Promise<SessionReceipt>;
}

const ACTIVITY_MUTATION = `mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
  agentActivityCreate(input: $input) { success agentActivity { id } }
}`;

const ACTIVITY_LOOKUP = `query AgentActivityByCallerId($id: ID!, $sessionId: String!) {
  agentActivities(first: 2, includeArchived: true, filter: { id: { eq: $id }, agentSessionId: { eq: $sessionId } }) {
    nodes {
      id agentSession { id } ephemeral signal signalMetadata
      content {
        ... on AgentActivityThoughtContent { type body }
        ... on AgentActivityActionContent { type action parameter result }
        ... on AgentActivityElicitationContent { type body }
        ... on AgentActivityResponseContent { type body }
        ... on AgentActivityErrorContent { type body }
      }
    }
    pageInfo { hasNextPage }
  }
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
  async function sendActivity(
    input: Record<string, unknown>,
    options?: TrackerRequestOptions,
  ): Promise<ActivityReceipt> {
    options?.signal?.throwIfAborted();
    const request = {
      ...options,
      signal: options?.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)])
        : AbortSignal.timeout(10_000),
    };
    if (options?.reconcile && input["id"] !== undefined) {
      const existing = await findActivity(client, input, request);
      if (existing !== null) return existing;
    }
    request.signal.throwIfAborted();
    if (options?.isCurrent && !options.isCurrent())
      throw new Error("The Linear activity was superseded before publication");
    const data = await client.query(ACTIVITY_MUTATION, { input }, request);
    request.signal.throwIfAborted();
    const receipt = mutationReceipt(data, "agentActivityCreate", "agentActivity");
    if (input["id"] !== undefined && receipt.id !== input["id"]) {
      throw new Error("Linear agentActivityCreate returned a different activity ID");
    }
    return receipt;
  }

  return {
    ...createLinearSessionReads(client),
    ...createLinearIssueContextReads(client),
    async createActivity(
      update: ProgressUpdate,
      options?: TrackerRequestOptions,
    ): Promise<ActivityReceipt> {
      return sendActivity(activityInput(update), options);
    },
    async createElicitation(
      question: SessionElicitation,
      options?: TrackerRequestOptions,
    ): Promise<ActivityReceipt> {
      return sendActivity(elicitationInput(question), options);
    },
    async updateSession(
      update: SessionUpdate,
      options?: TrackerRequestOptions,
    ): Promise<SessionReceipt> {
      options?.signal?.throwIfAborted();
      const { sessionId, ...input } = update;
      validateSessionUpdate(update);
      const data = await client.query(SESSION_UPDATE_MUTATION, { id: sessionId, input }, options);
      options?.signal?.throwIfAborted();
      const receipt = mutationReceipt(data, "agentSessionUpdate", "agentSession");
      if (receipt.id !== sessionId) {
        throw new Error("Linear agentSessionUpdate returned a different session ID");
      }
      return receipt;
    },
    async createSessionOnIssue(
      input: SessionOnIssue,
      options?: TrackerRequestOptions,
    ): Promise<SessionReceipt> {
      options?.signal?.throwIfAborted();
      validateUrls(input.externalUrls);
      const data = await client.query(SESSION_ISSUE_MUTATION, { input }, options);
      options?.signal?.throwIfAborted();
      return mutationReceipt(data, "agentSessionCreateOnIssue", "agentSession");
    },
    async createSessionOnComment(
      input: SessionOnComment,
      options?: TrackerRequestOptions,
    ): Promise<SessionReceipt> {
      options?.signal?.throwIfAborted();
      validateUrls(input.externalUrls);
      const data = await client.query(SESSION_COMMENT_MUTATION, { input }, options);
      options?.signal?.throwIfAborted();
      return mutationReceipt(data, "agentSessionCreateOnComment", "agentSession");
    },
  };
}

async function findActivity(
  client: LinearClient,
  input: Record<string, unknown>,
  options: { signal: AbortSignal },
): Promise<ActivityReceipt | null> {
  const data = await client.query(
    ACTIVITY_LOOKUP,
    { id: input["id"], sessionId: input["agentSessionId"] },
    options,
  );
  options.signal.throwIfAborted();
  const connection = isRecord(data) ? data["agentActivities"] : null;
  if (
    !isRecord(connection) ||
    !Array.isArray(connection["nodes"]) ||
    !isRecord(connection["pageInfo"]) ||
    connection["pageInfo"]["hasNextPage"] !== false ||
    connection["nodes"].length > 1
  )
    throw new Error("Linear returned incomplete activity reconciliation data");
  const activity: unknown = connection["nodes"][0];
  if (activity === undefined) return null;
  if (!isRecord(activity) || !isRecord(activity["agentSession"]))
    throw new Error("Linear returned invalid activity reconciliation data");
  const expected = {
    id: input["id"],
    sessionId: input["agentSessionId"],
    content: input["content"],
    ephemeral: input["ephemeral"] ?? false,
    signal: input["signal"],
    signalMetadata: input["signalMetadata"],
  };
  const actual = {
    id: activity["id"],
    sessionId: activity["agentSession"]["id"],
    content: activity["content"],
    ephemeral: activity["ephemeral"],
    signal: activity["signal"],
    signalMetadata: signalMetadata(activity["signalMetadata"]),
  };
  if (JSON.stringify(normalize(expected)) !== JSON.stringify(normalize(actual)))
    throw new Error("The existing Linear activity does not match this delivery");
  return { id: String(input["id"]) };
}

function signalMetadata(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!isRecord(parsed)) throw new Error("Linear returned invalid activity signal metadata");
  return parsed;
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== null && entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalize(entry)]),
  );
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
