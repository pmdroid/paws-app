import { eq } from "drizzle-orm";
import "../quiet-journal";
import { storeHomeLinearToken } from "../helpers";
import { createHmac } from "node:crypto";
import { createInboxStore } from "../../src/linear";
import { createLinearReconnect } from "../../src/onboarding";
import { startPaws } from "../../src/index";

const home = process.argv[2]!;
const previous = {
  accessToken: "fake-old-access",
  refreshToken: "fake-old-refresh",
  expiresAtMs: Date.now() + 600_000,
  actor: "app" as const,
  scope: "read,write",
};
await storeHomeLinearToken(home, previous);
const nativeFetch = fetch;
const started = Promise.withResolvers<void>();
const released = Promise.withResolvers<Response>();
const mutations: string[] = [];
globalThis.fetch = Object.assign(
  async (_url: unknown, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body));
    if (payload.query.includes("IntakePoll"))
      return Response.json({ data: { viewer: { id: "app" } } });
    if (payload.query.includes("PawsSessionInstallation"))
      return Response.json({
        data: {
          viewer: { id: "app", app: true, organization: { id: "org" } },
          agentSession: {
            id: "session",
            appUser: { id: "app", app: true, organization: { id: "org" } },
            issue: { id: "issue", team: { id: "team" } },
          },
        },
      });
    if (payload.query.includes("PawsTeamAccess")) {
      started.resolve();
      return released.promise;
    }
    mutations.push(payload.query);
    throw new Error("Superseded intake must not make a mutation");
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
const scope = { organizationId: "org", oauthClientId: "client", appUserId: "app" };
const post = async (event: object, delivery: string) => {
  const body = JSON.stringify({ ...scope, ...event, webhookTimestamp: Date.now() });
  return nativeFetch(new URL("/webhooks/linear", paws.server.url), {
    method: "POST",
    headers: {
      "linear-delivery": delivery,
      "linear-signature": createHmac("sha256", "fake-webhook-secret").update(body).digest("hex"),
    },
    body,
  });
};
const created = await post(
  {
    type: "AgentSessionEvent",
    action: "created",
    agentSession: { id: "session", issueId: "issue" },
  },
  "created",
);
await started.promise;
const revoked = await post(
  { type: "OAuthApp", action: "revoked", createdAt: new Date().toISOString() },
  "revoked",
);
const reconnect = await createLinearReconnect({
  now: () => Date.now() + 1000,
  fetch: async () =>
    Response.json({ data: { viewer: { id: "app", app: true, organization: { id: "org" } } } }),
})(paws.store, home);
const restored = await reconnect.complete({
  clientId: "client",
  token: { ...previous, accessToken: "fake-new-access", refreshToken: "fake-new-refresh" },
});
released.resolve(Response.json({ data: { team: { id: "team" } } }));
for (
  let attempt = 0;
  (await createInboxStore(paws.store).listUnhandled()).length > 0 && attempt < 100;
  attempt++
)
  await Bun.sleep(5);
const session = await paws.store.run(function* (q) {
  const row = yield* q.one(
    q.orm
      .select({ generation: q.t.linearSession.generation, stopped_at: q.t.linearSession.stoppedAt })
      .from(q.t.linearSession)
      .where(eq(q.t.linearSession.sessionId, "session")),
  );
  return row ?? null;
});
const items = (await paws.store.run((q) => q.all(q.orm.select().from(q.t.workItem)))).length;
const pending = (await createInboxStore(paws.store).listUnhandled()).length;
await paws.catchUp();
paws.stop();
console.log(
  JSON.stringify({
    statuses: [created.status, revoked.status],
    restored,
    items,
    pending,
    mutations,
    generation: session?.generation,
    stopped: session?.stopped_at != null,
  }),
);
