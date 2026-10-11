import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { checkGitHubSignature, handleGitHubWebhook } from "../src/github";
import { listGitHubDeliveries } from "../src/db";
import { startPaws } from "../src/index";
import { tempHome } from "./helpers";

const secret = "synthetic-github-webhook-secret";
function request(payload: string, change: Record<string, string> = {}): Request {
  return new Request("http://localhost/webhooks/github", {
    method: "POST",
    body: payload,
    headers: {
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`,
      "x-github-delivery": "delivery-1",
      "x-github-event": "ping",
      ...change,
    },
  });
}

test("GitHub signature verification matches its published HMAC test vector", () => {
  expect(
    checkGitHubSignature({
      secret: "It's a Secret to Everybody",
      body: Buffer.from("Hello, World!"),
      signature: "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
    }),
  ).toEqual({ ok: true });
  expect(
    checkGitHubSignature({ secret, signature: "sha256=bad", body: Buffer.from("{}") }),
  ).toEqual({ ok: false, reason: "invalid_signature" });
});

test("GitHub webhook rejects unsigned, changed or invalid payloads before accepting a delivery", async () => {
  const accepted: unknown[] = [];
  const inbox = {
    accept: (value: unknown) => {
      accepted.push(value);
    },
  };
  const body = JSON.stringify({ zen: "京都" });
  const valid = request(body);
  expect(
    (await handleGitHubWebhook(new Request(valid, { body: body + " " }), secret, inbox)).status,
  ).toBe(401);
  expect(
    (await handleGitHubWebhook(request(body, { "x-hub-signature-256": "" }), secret, inbox)).status,
  ).toBe(401);
  expect((await handleGitHubWebhook(request(body), null, inbox)).status).toBe(401);
  expect((await handleGitHubWebhook(request("invalid"), secret, inbox)).status).toBe(400);
  expect(
    (await handleGitHubWebhook(request(body, { "x-github-delivery": "" }), secret, inbox)).status,
  ).toBe(400);
  expect(accepted).toEqual([]);
  expect((await handleGitHubWebhook(request(body), secret, inbox)).status).toBe(200);
  expect(accepted).toEqual([{ deliveryId: "delivery-1", event: "ping", payload: body }]);
});

test("GitHub webhook does not acknowledge a verified event until its inbox accepts it", async () => {
  const body = JSON.stringify({ action: "opened" });
  expect((await handleGitHubWebhook(request(body), secret)).status).toBe(503);
  const response = await handleGitHubWebhook(request(body), secret, {
    accept() {
      throw new Error(secret);
    },
  });
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain(secret);
});

test("the running GitHub endpoint persists verified deliveries and deduplicates them across restart", async () => {
  const home = tempHome();
  const env = { PAWS_HOME: home, PAWS_PORT: "0", GITHUB_WEBHOOK_SECRET: secret };
  let paws = startPaws(env);
  const payload = JSON.stringify({ action: "opened", pull_request: { number: 1 } });
  try {
    const send = () => {
      const delivery = request(payload);
      return fetch(`http://127.0.0.1:${paws.server.port}/webhooks/github`, {
        method: "POST",
        body: payload,
        headers: delivery.headers,
      });
    };
    expect((await send()).status).toBe(200);
    expect(listGitHubDeliveries(paws.db)).toHaveLength(1);
    paws.stop();
    paws = startPaws(env);
    expect((await send()).status).toBe(200);
    expect(listGitHubDeliveries(paws.db)).toMatchObject([
      { deliveryId: "delivery-1", event: "ping", payload },
    ]);
    expect(readFileSync(join(home, "paws.db")).toString()).not.toContain(secret);
  } finally {
    paws.stop();
    rmSync(home, { recursive: true, force: true });
  }
});
