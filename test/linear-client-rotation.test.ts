import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveLinearClient } from "../src/onboarding";
import { readSecretFile, saveSecret, useDatabaseSecrets } from "../src/credentials";
import { handleLinearClientSettingsRequest } from "../src/settings";
import { tempHome } from "./helpers";
import { tempStore } from "./pglite";

const url = "http://127.0.0.1:8787/api/settings/linear-client";
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function instance() {
  const home = tempHome();
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const dir = join(home, "secrets");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".envelope-key"), randomBytes(32), { mode: 0o600 });
  const { db, close } = await tempStore();
  const secrets = await useDatabaseSecrets(db, dir);
  cleanups.push(close, () => secrets.close());
  await saveSecret(
    join(dir, "linear-client.json"),
    JSON.stringify({ clientId: "old-client-marker", clientSecret: "old-secret-marker" }),
  );
  await saveSecret(join(dir, "linear-webhook"), "old-webhook-marker");
  const checks: URLSearchParams[] = [];
  let accept = true;
  const env: Record<string, string> = { PAWS_HOME: home };
  const send = (method: string, body?: unknown, role = "admin") =>
    handleLinearClientSettingsRequest(
      new Request(url, {
        method,
        headers: { "content-type": "application/json", "x-paws-csrf": "csrf" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      {
        home,
        env,
        csrfToken: "csrf",
        role,
        audit: async () => {},
        fetch: async (_input, init) => {
          checks.push(new URLSearchParams(String(init?.body)));
          return Response.json(
            { error: accept ? "invalid_grant" : "invalid_client" },
            {
              status: accept ? 400 : 401,
            },
          );
        },
      },
    );
  return {
    send,
    checks,
    env,
    refuse: () => (accept = false),
    runtime: () => resolveLinearClient(db, dir, env),
    webhook: () => readSecretFile(join(dir, "linear-webhook")),
  };
}

test("an admin rotates the Linear client after Linear accepts it", async () => {
  const f = await instance();
  expect((await f.send("PUT", { clientSecret: "member-marker" }, "member"))!.status).toBe(403);
  const response = await f.send("PUT", {
    clientId: "new-client-marker",
    clientSecret: "new-secret-marker",
    webhookSecret: "new-webhook-marker",
  });
  expect(response!.status).toBe(200);
  expect(JSON.stringify(await response!.json())).not.toContain("marker");
  expect(f.checks.map((body) => [body.get("client_id"), body.get("client_secret")])).toEqual([
    ["new-client-marker", "new-secret-marker"],
  ]);
  expect((await f.runtime()).clientId).toBe("new-client-marker");
  expect((await f.runtime()).clientSecret).toBe("new-secret-marker");
  expect(f.webhook()).toBe("new-webhook-marker");
});

test("a refused check keeps the old Linear client", async () => {
  const f = await instance();
  f.refuse();
  const response = await f.send("PUT", {
    clientSecret: "refused-marker",
    webhookSecret: "refused-webhook-marker",
  });
  expect(response!.status).toBe(400);
  expect(JSON.stringify(await response!.json())).not.toContain("marker");
  expect(f.checks[0]!.get("client_id")).toBe("old-client-marker");
  expect((await f.runtime()).clientSecret).toBe("old-secret-marker");
  expect(f.webhook()).toBe("old-webhook-marker");
});

test("environment-set Linear fields are read-only", async () => {
  const f = await instance();
  f.env.LINEAR_CLIENT_SECRET = "env-secret-marker";
  const read = (await (await f.send("GET"))!.json()) as { sources: Record<string, unknown> };
  expect(read.sources).toEqual({
    clientId: { source: "settings" },
    clientSecret: { source: "environment", variable: "LINEAR_CLIENT_SECRET" },
    webhookSecret: { source: "settings" },
  });
  expect(JSON.stringify(read)).not.toContain("marker");
  const refused = await f.send("PUT", { clientSecret: "new-secret-marker" });
  expect(refused!.status).toBe(409);
  expect(f.checks).toEqual([]);
  expect((await f.send("PUT", { clientId: "next-client-marker" }))!.status).toBe(409);
  expect(f.checks).toEqual([]);
  expect((await f.send("PUT", { webhookSecret: "next-webhook-marker" }))!.status).toBe(200);
  expect(f.webhook()).toBe("next-webhook-marker");
});
