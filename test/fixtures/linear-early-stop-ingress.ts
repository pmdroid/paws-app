import "../quiet-journal";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { startPaws } from "../../src/index";
import { createInboxStore, linearTokenPath, writeStoredToken } from "../../src/linear";

const home = process.argv[2]!;
const token = process.argv[3] === "token";
if (token)
  writeStoredToken(linearTokenPath(join(home, "secrets")), {
    accessToken: "fake-access",
    refreshToken: "fake-refresh",
    expiresAtMs: Date.now() + 600_000,
    actor: "app",
    scope: "read,write",
  });
const nativeFetch = fetch;
const queries: string[] = [];
const bodies: string[] = [];
globalThis.fetch = Object.assign(
  async (_url: unknown, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body));
    const query = payload.query as string;
    if (query.includes("IntakePoll")) return Response.json({ data: { viewer: { id: "app" } } });
    if (typeof payload.variables?.input?.content?.body === "string")
      bodies.push(payload.variables.input.content.body);
    queries.push(query);
    if (!query.includes("agentActivityCreate"))
      throw new Error("Early Stop must not make an API read");
    return Response.json({
      data: { agentActivityCreate: { success: true, agentActivity: { id: "stop-response" } } },
    });
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
const statuses: number[] = [];
for (const action of ["prompted", "created"]) {
  const body = JSON.stringify({
    type: "AgentSessionEvent",
    action,
    organizationId: "org",
    oauthClientId: "client",
    appUserId: "app",
    webhookTimestamp: Date.now(),
    agentSession: { id: "early-stop", issue: { id: "issue", team: { id: "team" } } },
    ...(action === "prompted"
      ? { agentActivity: { id: "stop-activity", signal: "stop", body: "Stop" } }
      : {}),
  });
  statuses.push(
    (
      await nativeFetch(new URL("/webhooks/linear", paws.server.url), {
        method: "POST",
        headers: {
          "linear-delivery": action,
          "linear-signature": createHmac("sha256", "fake-webhook-secret")
            .update(body)
            .digest("hex"),
        },
        body,
      })
    ).status,
  );
  for (
    let attempt = 0;
    createInboxStore(paws.db).listUnhandled().length > 0 && attempt < 100;
    attempt++
  )
    await Bun.sleep(5);
}
const session = paws.db
  .query<{ generation: number; stopped_at: number | null }, [string]>(
    "SELECT generation, stopped_at FROM linear_session WHERE session_id = ?",
  )
  .get("early-stop");
const items = paws.db
  .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM work_item")
  .get()!.count;
const pending = createInboxStore(paws.db).listUnhandled().length;
await paws.catchUp();
paws.stop();
console.log(
  JSON.stringify({
    statuses,
    items,
    pending,
    stopped: session?.stopped_at != null,
    generation: session?.generation,
    apiReads: queries.filter((query) => !query.includes("agentActivityCreate")).length,
    firstAcknowledgements: bodies.filter((body) => body === "Picked up this issue.").length,
  }),
);
