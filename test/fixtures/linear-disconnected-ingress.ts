import { createHmac } from "node:crypto";
import { join } from "node:path";
import { openDatabase } from "../../src/db";
import { startPaws } from "../../src/index";
import { createInboxStore } from "../../src/linear";

const home = process.argv[2]!;
const nativeFetch = fetch;
let requests = 0;
globalThis.fetch = Object.assign(
  async () => {
    requests++;
    throw new Error("Offline request must not run");
  },
  { preconnect: () => undefined },
);
const paws = startPaws(
  {
    PAWS_HOME: home,
    PAWS_PORT: "0",
    LINEAR_MODE: "agent-session",
    LINEAR_CLIENT_ID: "client",
    LINEAR_CLIENT_SECRET: "fake-secret",
    LINEAR_WEBHOOKS: "true",
    LINEAR_WEBHOOK_SECRET: "fake-webhook-secret",
  },
  { noTunnel: true },
);
const body = JSON.stringify({
  type: "AgentSessionEvent",
  action: "created",
  organizationId: "org",
  oauthClientId: "client",
  appUserId: "app",
  webhookTimestamp: Date.now(),
  agentSession: { id: "disconnected-session", issue: { id: "issue", team: { id: "team" } } },
});
const response = await nativeFetch(new URL("/webhooks/linear", paws.server.url), {
  method: "POST",
  headers: {
    "linear-delivery": "disconnected-delivery",
    "linear-signature": createHmac("sha256", "fake-webhook-secret").update(body).digest("hex"),
  },
  body,
});
await new Promise<void>((resolve) => setImmediate(resolve));
paws.stop();
const reopened = openDatabase(join(home, "paws.db"));
const pending = createInboxStore(reopened)
  .listUnhandled()
  .map((event) => event.sessionId);
reopened.close();
console.log(JSON.stringify({ status: response.status, requests, pending }));
