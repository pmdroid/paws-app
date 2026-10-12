import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { migrate, openDatabase } from "../src/db";
import {
  createInboxStore,
  handleLinearWebhook,
  matchesLinearInstallation,
  parseAgentEvent,
  parseLinearAdministration,
  parseLinearSessionInstallation,
  type AcceptedLinearEvent,
} from "../src/linear";

const scope = {
  organizationId: "organization",
  oauthClientId: "oauth-client",
  appUserId: "paws-app",
};
const at = Date.parse("2026-10-11T12:00:00Z");
const payload = {
  ...scope,
  type: "PermissionChange",
  action: "teamAccessChanged",
  createdAt: new Date(at).toISOString(),
  webhookId: "subscription-id",
  webhookTimestamp: at,
  canAccessAllPublicTeams: false,
  addedTeamIds: ["added"],
  removedTeamIds: ["removed"],
};
const event = (value: unknown) => parseAgentEvent(JSON.stringify(value), "delivery", at)!;

function notification(action = "issueStatusChanged") {
  return {
    ...payload,
    type: "AppUserNotification",
    action,
    notification: {
      id: "notification-id",
      type: action,
      userId: "paws-app",
      actorId: "human",
      actor: { id: "human" },
      issueId: "issue",
      issue: { id: "issue", teamId: "team", team: { id: "team" } },
    },
  };
}

describe("Linear administration event normalization", () => {
  test("team access changes retain the affected teams and exact installation", () => {
    expect(parseLinearAdministration(event(payload))).toEqual({
      ...scope,
      kind: "teams",
      createdAtMs: at,
      canAccessAllPublicTeams: false,
      addedTeamIds: ["added"],
      removedTeamIds: ["removed"],
    });
  });

  test("app revocation is scoped by organization and OAuth client without inventing an app user", () => {
    const revoked = parseLinearAdministration(
      event({ ...payload, type: "OAuthApp", action: "revoked", appUserId: undefined }),
    )!;
    expect(revoked).toEqual({
      organizationId: scope.organizationId,
      oauthClientId: scope.oauthClientId,
      kind: "revoked",
      createdAtMs: at,
    });
    expect(matchesLinearInstallation(revoked, scope)).toBe(true);
    expect(
      matchesLinearInstallation(revoked, { ...scope, appUserId: "second-installation-user" }),
    ).toBe(true);
    expect(matchesLinearInstallation(revoked, { ...scope, oauthClientId: "other-client" })).toBe(
      false,
    );
    expect(
      matchesLinearInstallation(revoked, { ...scope, organizationId: "other-organization" }),
    ).toBe(false);
  });

  test.each([
    "issueMention",
    "issueEmojiReaction",
    "issueCommentMention",
    "issueCommentReaction",
    "issueAssignedToYou",
    "issueUnassignedFromYou",
    "issueNewComment",
    "issueStatusChanged",
  ])("retains %s identity and actor for authoritative handling", (action) => {
    const parsed = parseLinearAdministration(event(notification(action)))!;
    expect(parsed).toEqual({
      ...scope,
      kind: "notification",
      createdAtMs: at,
      notificationId: "notification-id",
      action,
      issueId: "issue",
      teamId: "team",
      actorId: "human",
    });
    expect(matchesLinearInstallation(parsed, { ...scope, appUserId: "other-app-user" })).toBe(
      false,
    );
  });

  test("unassignment remains a notification instead of credential revocation", () => {
    const parsed = parseLinearAdministration(event(notification("issueUnassignedFromYou")));
    expect(parsed?.kind).toBe("notification");
    expect(parsed).not.toHaveProperty("removedTeamIds");
  });

  test("contradictory issue, actor and receiver identities fail closed", () => {
    const source = notification();
    source.notification.issue.id = "different-issue";
    expect(parseLinearAdministration(event(source))).toBeNull();
    source.notification.issue.id = "issue";
    source.notification.actor.id = "different-actor";
    expect(parseLinearAdministration(event(source))).toBeNull();
    source.notification.actor.id = "human";
    source.notification.userId = "different-recipient";
    expect(parseLinearAdministration(event(source))).toBeNull();
  });

  test("incomplete permissions and untrusted sources cannot create administration events", () => {
    for (const override of [
      { oauthClientId: null },
      { organizationId: null },
      { appUserId: " " },
      { createdAt: "invalid" },
      { removedTeamIds: null },
      { addedTeamIds: [1] },
      { addedTeamIds: ["removed"] },
      { canAccessAllPublicTeams: null },
    ])
      expect(parseLinearAdministration(event({ ...payload, ...override }))).toBeNull();
    expect(parseLinearAdministration({ ...event(payload), source: "poll" })).toBeNull();
    expect(parseLinearAdministration({ ...event(payload), deliveryId: null })).toBeNull();
    expect(
      parseLinearAdministration(event({ ...payload, type: "OAuthApp", action: "updated" })),
    ).toBeNull();
  });

  test("session installation metadata comes from the verified event and rejects mismatched scope", () => {
    const raw = {
      ...payload,
      type: "AgentSessionEvent",
      action: "created",
      agentSession: {
        id: "session",
        ...scope,
        issue: { id: "issue", teamId: "team", team: { id: "team" } },
      },
    };
    expect(parseLinearSessionInstallation(event(raw))).toEqual({
      ...scope,
      sessionId: "session",
      teamId: "team",
    });
    raw.agentSession.organizationId = "other-organization";
    expect(parseLinearSessionInstallation(event(raw))).toBeNull();
    raw.agentSession.organizationId = scope.organizationId;
    raw.agentSession.appUserId = "other-user";
    expect(parseLinearSessionInstallation(event(raw))).toBeNull();
    expect(parseLinearSessionInstallation({ ...event(raw), source: "poll" })).toBeNull();
  });

  test.each(["team", "issue", "event"])(
    "signed contradictory %s ownership cannot persist session installation scope",
    async (contradiction) => {
      const db = openDatabase(":memory:");
      try {
        migrate(db);
        const source = {
          ...payload,
          type: "AgentSessionEvent",
          action: "created",
          agentSession: {
            id: "session",
            ...scope,
            issueId: "issue",
            issue: { id: "issue", teamId: "team", team: { id: "team" } },
          },
        };
        if (contradiction === "team") source.agentSession.issue.team.id = "other-team";
        if (contradiction === "issue") source.agentSession.issue.id = "other-issue";
        const raw = JSON.stringify(source);
        const signature = createHmac("sha256", "fake-webhook-secret").update(raw).digest("hex");
        let received = false;
        const response = await handleLinearWebhook(
          new Request("http://localhost/webhook", {
            method: "POST",
            body: raw,
            headers: { "linear-delivery": "session-delivery", "linear-signature": signature },
          }),
          "fake-webhook-secret",
          {
            store: createInboxStore(db),
            now: () => at,
            onEvent(input) {
              received = true;
              expect(
                parseLinearSessionInstallation(
                  contradiction === "event" ? { ...input, issueId: "other-issue" } : input,
                ),
              ).toBeNull();
            },
          },
        );
        expect(response.status).toBe(200);
        expect(received).toBe(true);
      } finally {
        db.close();
      }
    },
  );

  test("the webhook authenticates and persists the administrative payload before dispatch", async () => {
    const db = openDatabase(":memory:");
    try {
      migrate(db);
      const raw = JSON.stringify(payload);
      const accepted: AcceptedLinearEvent[] = [];
      const store = createInboxStore(db);
      const deps = {
        store,
        now: () => at,
        onEvent: (input: AcceptedLinearEvent) => {
          expect(store.get(input.dedupeKey)).not.toBeNull();
          accepted.push(input);
        },
      };
      const request = (signature: string) =>
        new Request("http://localhost/webhook", {
          method: "POST",
          body: raw,
          headers: { "linear-delivery": "delivery", "linear-signature": signature },
        });
      expect((await handleLinearWebhook(request("bad"), "fake-webhook-secret", deps)).status).toBe(
        401,
      );
      expect(accepted).toHaveLength(0);
      const signature = createHmac("sha256", "fake-webhook-secret").update(raw).digest("hex");
      expect(
        (await handleLinearWebhook(request(signature), "fake-webhook-secret", deps)).status,
      ).toBe(200);
      expect(accepted).toHaveLength(1);
      expect(parseLinearAdministration(accepted[0]!)?.kind).toBe("teams");
    } finally {
      db.close();
    }
  });
});
