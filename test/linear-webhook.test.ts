import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { startPaws } from "../src/index";
import {
  TIMESTAMP_WINDOW_MS,
  checkLinearSignature,
  handleLinearWebhook,
  isPawsStop,
  sessionCreatedKey,
} from "../src/linear";
import { createInboxStore } from "../src/linear";
import { tempDb, tempHome } from "./helpers";

const SECRET = "webhook-secret";

describe("linear webhooks", () => {
  test("rejects a bad signature and a stale timestamp before writing a row", async () => {
    const db = tempDb();
    const store = createInboxStore(db);
    const now = 1_700_000_000_000;
    const body = JSON.stringify({
      webhookTimestamp: now,
      type: "AgentSessionEvent",
      action: "created",
    });
    const stale = await handleLinearWebhook(signedRequest(body, SECRET, "del-1"), SECRET, {
      store,
      now: () => now + TIMESTAMP_WINDOW_MS + 1,
    });
    expect(stale.status).toBe(401);
    expect(await stale.json()).toEqual({ ok: false, reason: "stale_timestamp" });

    const forged = await handleLinearWebhook(
      signedRequest(body, SECRET, "del-1", "ff".repeat(32)),
      SECRET,
      { store, now: () => now },
    );
    expect(forged.status).toBe(401);
    expect(store.listUnhandled()).toHaveLength(0);
    expect(
      checkLinearSignature({ signature: null, secret: SECRET, rawBody: body, timestampMs: now }),
    ).toEqual({
      ok: false,
      reason: "missing_signature",
    });
    db.close();
  });

  test("commits a delivery before acknowledging and does not wait on the follow-up", async () => {
    const db = tempDb();
    const store = createInboxStore(db);
    const now = 1_700_000_000_000;
    const body = agentBody(now, "ses_1", "iss_1");
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const started = Date.now();
    const response = await handleLinearWebhook(signedRequest(body, SECRET, "del-1"), SECRET, {
      store,
      now: () => now,
      onEvent: (event) => {
        calls.push(event.dedupeKey);
        return gate;
      },
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, duplicate: false });
    expect(store.listUnhandled().map((event) => event.dedupeKey)).toEqual([
      sessionCreatedKey("ses_1"),
    ]);
    expect(calls).toEqual([sessionCreatedKey("ses_1")]);

    const replay = await handleLinearWebhook(signedRequest(body, SECRET, "del-2"), SECRET, {
      store,
      now: () => now,
      onEvent: () => {
        calls.push("again");
        return Promise.resolve();
      },
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ok: true, duplicate: true });
    expect(calls).toEqual([sessionCreatedKey("ses_1")]);

    release();
    await gate;
    await Promise.resolve();
    await Promise.resolve();
    expect(store.listUnhandled()).toHaveLength(0);
    db.close();
  });

  test("a prompted /paws stop reply arrives as a stop signal, like the poller reads it", async () => {
    const db = tempDb();
    const store = createInboxStore(db);
    const now = 1_700_000_000_000;
    const prompted = (id: string, body: string) =>
      JSON.stringify({
        webhookTimestamp: now,
        type: "AgentSessionEvent",
        action: "prompted",
        agentSession: { id: "ses_1", issueId: "iss_1" },
        agentActivity: { id, content: { type: "prompt", body } },
      });
    const seen: { body: string | null; signal: string | null }[] = [];
    for (const [id, body] of [
      ["act_1", "  /paws stop please"],
      ["act_2", "Please do not /paws stop yet"],
    ] as const) {
      const response = await handleLinearWebhook(
        signedRequest(prompted(id, body), SECRET, `del-${id}`),
        SECRET,
        {
          store,
          now: () => now,
          onEvent: (event) => {
            seen.push({ body: event.body, signal: event.signal });
            return Promise.resolve();
          },
        },
      );
      expect(response.status).toBe(200);
    }
    expect(seen).toEqual([
      { body: "  /paws stop please", signal: "stop" },
      { body: "Please do not /paws stop yet", signal: null },
    ]);
    expect(isPawsStop(seen[0]!.body)).toBe(true);
    db.close();
  });

  test("startPaws leaves webhook routes off unless LINEAR_WEBHOOKS is set", async () => {
    const home = tempHome();
    const paws = startPaws({
      PAWS_HOME: home,
      PAWS_PORT: "0",
      PAWS_HOST: "127.0.0.1",
      LINEAR_WEBHOOK_SECRET: SECRET,
    });
    try {
      const now = Date.now();
      const body = agentBody(now, "ses_http", "iss_http");
      const base = `http://${paws.server.hostname}:${paws.server.port}`;
      const hidden = await fetch(`${base}/webhooks/linear`, signedInit(body, SECRET, "del-http"));
      expect(hidden.status).toBe(404);
      const github = await fetch(`${base}/webhooks/github`, { method: "POST" });
      expect(github.status).toBe(404);
      const count = paws.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM inbox_event").get();
      expect(count?.n).toBe(0);
      expect(paws.tunnelRequested).toBe(false);
    } finally {
      await paws.stop();
    }
  });

  test("startPaws persists a signed webhook when LINEAR_WEBHOOKS is on", async () => {
    const home = tempHome();
    const paws = startPaws({
      PAWS_HOME: home,
      PAWS_PORT: "0",
      PAWS_HOST: "127.0.0.1",
      LINEAR_WEBHOOK_SECRET: SECRET,
      LINEAR_WEBHOOKS: "true",
    });
    try {
      const now = Date.now();
      const body = agentBody(now, "ses_http", "iss_http");
      const base = `http://${paws.server.hostname}:${paws.server.port}`;
      const ok = await fetch(`${base}/webhooks/linear`, signedInit(body, SECRET, "del-http"));
      expect(ok.status).toBe(200);
      const bad = await fetch(
        `${base}/webhooks/linear`,
        signedInit(body, "other-secret", "del-bad"),
      );
      expect(bad.status).toBe(401);
      const count = paws.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM inbox_event").get();
      expect(count?.n).toBe(1);
    } finally {
      await paws.stop();
    }
  });
});

function agentBody(now: number, sessionId: string, issueId: string): string {
  return JSON.stringify({
    type: "AgentSessionEvent",
    action: "created",
    webhookTimestamp: now,
    agentSession: { id: sessionId, issueId },
  });
}

function signedRequest(
  body: string,
  secret: string,
  deliveryId: string,
  signature?: string,
): Request {
  return new Request(
    "http://127.0.0.1/webhooks/linear",
    signedInit(body, secret, deliveryId, signature),
  );
}

function signedInit(
  body: string,
  secret: string,
  deliveryId: string,
  signature = createHmac("sha256", secret).update(body).digest("hex"),
): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "linear-signature": signature,
      "linear-delivery": deliveryId,
    },
    body,
  };
}
