import { createHmac } from "node:crypto";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  createInboxStore,
  handleLinearWebhook,
  isQueuedIntake,
  openLinear,
  type AcceptedLinearEvent,
  type IntakeQueue,
} from "../src/linear";
import { startServer } from "../src/server";
import { tempDb, tempHome } from "./helpers";

const SECRET = "webhook-secret";
const LINEAR_DEADLINE_MS = 5_000;
const scope = { organizationId: "org", oauthClientId: "client", appUserId: "app" };

function bodies(now: number): Record<string, unknown>[] {
  const session = { ...scope, id: "session", issue: { id: "issue", team: { id: "team" } } };
  const base = { ...scope, createdAt: new Date(now).toISOString(), webhookTimestamp: now };
  return [
    { ...base, type: "AgentSessionEvent", action: "created", agentSession: session },
    {
      ...base,
      type: "AgentSessionEvent",
      action: "prompted",
      agentSession: session,
      agentActivity: { id: "prompt", content: { type: "prompt", body: "Make it blue" } },
    },
    {
      ...base,
      type: "AgentSessionEvent",
      action: "prompted",
      agentSession: session,
      agentActivity: { id: "stop", signal: "stop", content: { type: "prompt", body: "" } },
    },
    {
      ...base,
      type: "PermissionChange",
      action: "teamAccessChanged",
      canAccessAllPublicTeams: false,
      addedTeamIds: [],
      removedTeamIds: ["team"],
    },
    {
      ...base,
      type: "AppUserNotification",
      action: "issueNewComment",
      notification: {
        id: "notification",
        type: "issueNewComment",
        userId: "app",
        issueId: "issue",
        issue: { id: "issue", team: { id: "team" } },
      },
    },
    { ...base, type: "OAuthApp", action: "revoked", appUserId: undefined },
    { ...base, type: "Issue", action: "update", data: { id: "issue" } },
  ];
}

describe("Linear webhook acknowledgement", () => {
  test("every Linear webhook answers 200 within 5 seconds while the Linear client is stalled", async () => {
    const db = tempDb();
    const home = tempHome();
    const stall = Promise.withResolvers<void>();
    const stalled: string[] = [];
    const linear = openLinear({
      db,
      secretsDir: join(home, "secrets"),
      env: { LINEAR_ACCESS_TOKEN: "fixture-token", LINEAR_CLIENT_ID: "client" },
      followUp: async () => {
        await stall.promise;
      },
      async fetch(_url, init) {
        stalled.push(String(init?.body));
        await stall.promise;
        throw new Error("Linear stalled");
      },
    });
    const server = startServer({
      hostname: "127.0.0.1",
      port: 0,
      webhooks: true,
      linearWebhookSecret: SECRET,
      linearWebhook: linear.webhook,
    });
    try {
      const url = `http://127.0.0.1:${server.port}/webhooks/linear`;
      let delivery = 0;
      for (const body of bodies(Date.now())) {
        delivery += 1;
        const raw = JSON.stringify(body);
        const started = performance.now();
        const response = await Promise.race([
          fetch(url, signedInit(raw, crypto.randomUUID())),
          Bun.sleep(LINEAR_DEADLINE_MS).then(() => null),
        ]);
        expect({ delivery, status: response?.status ?? "timed out" }).toEqual({
          delivery,
          status: 200,
        });
        expect(performance.now() - started).toBeLessThan(LINEAR_DEADLINE_MS);
      }
      await waitFor(() => stalled.length > 0);
    } finally {
      stall.resolve();
      await linear.webhook.intake?.idle();
      await Bun.sleep(10);
      await server.stop(true);
      db.close();
    }
  });

  test("a repeated Linear-Delivery is processed once", async () => {
    const db = tempDb();
    const store = createInboxStore(db);
    const arrived: string[] = [];
    const followed: string[] = [];
    const release = Promise.withResolvers<void>();
    const intake: IntakeQueue = {
      accepts: isQueuedIntake,
      arrive: (event) => arrived.push(event.dedupeKey),
      wake() {},
      idle: async () => {},
      stop: async () => {},
    };
    const deps = {
      store,
      intake,
      onEvent: async (event: AcceptedLinearEvent) => {
        followed.push(event.dedupeKey);
        await release.promise;
      },
    };
    const [created, , , , notification] = bodies(Date.now());
    const deliveries = [
      { body: created, id: "4b4e7d2c-0d7f-4c36-9b0b-3e1f7f2b9a01" },
      { body: notification, id: "4b4e7d2c-0d7f-4c36-9b0b-3e1f7f2b9a02" },
    ];
    const answers: unknown[] = [];
    for (const retry of [0, 1, 2]) {
      if (retry === 2) {
        release.resolve();
        await Bun.sleep(0);
      }
      for (const { body, id } of deliveries) {
        const raw = JSON.stringify({ ...body, webhookTimestamp: Date.now() + retry });
        const response = await handleLinearWebhook(
          new Request("http://127.0.0.1/webhooks/linear", signedInit(raw, id)),
          SECRET,
          deps,
        );
        expect(response.status).toBe(200);
        answers.push(await response.json());
      }
    }
    expect(answers).toEqual([
      { ok: true, duplicate: false },
      { ok: true, duplicate: false },
      { ok: true, duplicate: true },
      { ok: true, duplicate: true },
      { ok: true, duplicate: true },
      { ok: true, duplicate: true },
    ]);
    expect(arrived).toEqual(["session:session:created"]);
    expect(followed).toHaveLength(1);
    expect(store.get(followed[0]!)?.deliveryId).toBe(deliveries[1]!.id);
    db.close();
  });
});

function signedInit(body: string, deliveryId: string): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "linear-signature": createHmac("sha256", SECRET).update(body).digest("hex"),
      "linear-delivery": deliveryId,
    },
    body,
  };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await Bun.sleep(5);
  }
  throw new Error("condition not met");
}
