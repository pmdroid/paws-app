import { eq } from "drizzle-orm";
import "../quiet-journal";
import { storeHomeLinearToken } from "../helpers";
import { createHmac } from "node:crypto";
import { startPaws } from "../../src/index";
import { createInboxStore } from "../../src/linear";

const home = process.argv[2]!;
const token = process.argv[3] === "token";
if (token)
  await storeHomeLinearToken(home, {
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
const paws = await startPaws({
  PAWS_HOME: home,
  PAWS_PORT: "0",
  LINEAR_MODE: "agent-session",
  LINEAR_CLIENT_ID: "client",
  LINEAR_CLIENT_SECRET: "fake-secret",
  LINEAR_WEBHOOKS: "true",
  LINEAR_WEBHOOK_SECRET: "fake-webhook-secret",
});
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
    (await createInboxStore(paws.store).listUnhandled()).length > 0 && attempt < 100;
    attempt++
  )
    await Bun.sleep(5);
}
const session = await paws.store.run(function* (q) {
  const row = yield* q.one(
    q.orm
      .select({ generation: q.t.linearSession.generation, stopped_at: q.t.linearSession.stoppedAt })
      .from(q.t.linearSession)
      .where(eq(q.t.linearSession.sessionId, "early-stop")),
  );
  return row ?? null;
});
const items = (await paws.store.run((q) => q.all(q.orm.select().from(q.t.workItem)))).length;
const pending = (await createInboxStore(paws.store).listUnhandled()).length;
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
