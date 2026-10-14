import type { LinearClient } from "./graphql";
import type { AcceptedLinearEvent } from "./events";
import { sessionCreatedKey } from "./events";
import type { InboxStore } from "./inbox";
import { isRecord, readString } from "./read";

export type LinearSessionTarget = { kind: "issue" | "comment"; id: string };
export type StartedLinearSession = { id: string; url: string | null };

const SESSION_FIELDS = `id url createdAt updatedAt creator { id } appUser { id organization { id } }
  issue { id identifier title description url }
  comment { id body url } sourceComment { id body url }`;

export function createSessionStarter(options: {
  client: LinearClient;
  store: InboxStore;
  appUserId: string | null;
  onEvent: (event: AcceptedLinearEvent) => Promise<void | boolean>;
}) {
  return async (
    target: LinearSessionTarget,
    externalUrl: string,
    signal?: AbortSignal,
    acceptSession?: (event: AcceptedLinearEvent) => void,
  ): Promise<StartedLinearSession> => {
    const operation =
      target.kind === "issue" ? "agentSessionCreateOnIssue" : "agentSessionCreateOnComment";
    const inputType =
      target.kind === "issue" ? "AgentSessionCreateOnIssue" : "AgentSessionCreateOnComment";
    const data = await options.client.query(
      `mutation StartLinearSession($input: ${inputType}!) {
        ${operation}(input: $input) { success agentSession { ${SESSION_FIELDS} } }
      }`,
      {
        input: {
          [target.kind === "issue" ? "issueId" : "commentId"]: target.id,
          externalUrls: [{ label: "Paws", url: externalUrl }],
        },
      },
      signal === undefined ? undefined : { signal },
    );
    const payload = isRecord(data) && isRecord(data[operation]) ? data[operation] : null;
    const session =
      payload !== null && isRecord(payload["agentSession"]) ? payload["agentSession"] : null;
    const app = session !== null && isRecord(session["appUser"]) ? session["appUser"] : null;
    const issue = session !== null && isRecord(session["issue"]) ? session["issue"] : null;
    const id = session === null ? null : readString(session, "id");
    const appUserId = app === null ? null : readString(app, "id");
    const issueId = issue === null ? null : readString(issue, "id");
    if (
      payload?.["success"] !== true ||
      id === null ||
      appUserId === null ||
      issueId === null ||
      (options.appUserId !== null && appUserId !== options.appUserId)
    ) {
      throw new Error("Linear did not return an authorized issue session");
    }
    const organization = app !== null && isRecord(app["organization"]) ? app["organization"] : null;
    const sourceComment = isRecord(session?.["sourceComment"]) ? session["sourceComment"] : null;
    const comment = isRecord(session?.["comment"]) ? session["comment"] : null;
    const selectedComment = [sourceComment, comment].find(
      (entry) => entry !== null && readString(entry, "id") === target.id,
    );
    if (target.kind === "comment" && selectedComment === undefined)
      throw new Error("Linear returned a different comment thread");
    const promptContext = [
      `${readString(issue!, "identifier") ?? issueId}: ${readString(issue!, "title") ?? ""}`,
      readString(issue!, "description"),
      selectedComment === undefined || selectedComment === null
        ? null
        : readString(selectedComment, "body"),
    ]
      .filter((value) => value !== null)
      .join("\n\n");
    const updatedAtMs = Date.parse(readString(session!, "updatedAt") ?? "");
    if (!Number.isFinite(updatedAtMs))
      throw new Error("Linear returned an invalid session timestamp");
    const event: AcceptedLinearEvent = {
      dedupeKey: sessionCreatedKey(id),
      deliveryId: null,
      source: "poll",
      action: "created",
      sessionId: id,
      issueId,
      activityId: null,
      body: null,
      signal: null,
      updatedAtMs,
      payload: JSON.stringify({
        type: "AgentSessionEvent",
        action: "created",
        appUserId,
        organizationId: organization === null ? null : readString(organization, "id"),
        agentSession: session,
        promptContext,
      }),
    };
    acceptSession?.(event);
    const stored = options.store.commit(event);
    if (!stored.handled || acceptSession !== undefined) {
      void options
        .onEvent(options.store.get(event.dedupeKey) ?? event)
        .then(() => options.store.markHandled(event.dedupeKey))
        .catch(() => undefined);
    }
    return { id, url: readString(session!, "url") ?? readString(issue!, "url") };
  };
}
