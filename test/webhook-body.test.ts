import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { handleGitHubWebhook } from "../src/github";
import { createInboxStore, handleLinearWebhook, type InboxStore } from "../src/linear";
import { handleSlackWebhook } from "../src/slack";
import { tempDb } from "./helpers";

const secret = "synthetic-webhook-body-secret";
const now = 1_700_000_000_000;

type Endpoint = {
  name: string;
  limit: number;
  payload: string;
  headers: (payload: string) => Record<string, string>;
  handle: (request: Request, secret: string | null) => Promise<Response>;
};

function endpoints(store: InboxStore): Endpoint[] {
  return [
    {
      name: "github",
      limit: 25 * 1024 * 1024,
      payload: JSON.stringify({ zen: "京都 🐕" }),
      headers: (body) => ({
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
        "x-github-delivery": "body-delivery",
        "x-github-event": "ping",
      }),
      handle: (request, key) => handleGitHubWebhook(request, key, { accept() {} }),
    },
    {
      name: "linear",
      limit: 1024 * 1024,
      payload: JSON.stringify({ webhookTimestamp: now, title: "京都 🐕" }),
      headers: (body) => ({
        "linear-signature": createHmac("sha256", secret).update(body).digest("hex"),
        "linear-delivery": "body-delivery",
      }),
      handle: (request, key) => handleLinearWebhook(request, key, { store, now: () => now }),
    },
    {
      name: "slack",
      limit: 1024 * 1024,
      payload: JSON.stringify({ type: "url_verification", challenge: "京都 🐕" }),
      headers: (body) => ({
        "x-slack-signature": `v0=${createHmac("sha256", secret).update(`v0:${now / 1000}:`).update(body).digest("hex")}`,
        "x-slack-request-timestamp": String(now / 1000),
      }),
      handle: (request, key) => handleSlackWebhook(request, key, now),
    },
  ];
}

for (const name of ["github", "linear", "slack"]) {
  async function withEndpoint(run: (endpoint: Endpoint) => Promise<void>) {
    const db = tempDb();
    try {
      await run(endpoints(createInboxStore(db)).find((endpoint) => endpoint.name === name)!);
    } finally {
      db.close();
    }
  }

  test(`${name} rejects malformed signatures without consuming the request body`, async () => {
    await withEndpoint(async (endpoint) => {
      let reads = 0;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            reads++;
            controller.enqueue(new Uint8Array(64));
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );
      const headers = endpoint.headers(endpoint.payload);
      const signature = Object.keys(headers).find((key) => key.includes("signature"))!;
      headers[signature] = "invalid";
      const request = new Request(`https://paws.example/webhooks/${name}`, {
        method: "POST",
        headers,
        body,
      });
      expect((await endpoint.handle(request, secret)).status).toBe(401);
      expect(reads).toBe(0);
      await body.cancel();
    });
  });

  test(`${name} rejects declared oversized bodies before reading`, async () => {
    await withEndpoint(async (endpoint) => {
      let reads = 0;
      const request = new Request(`https://paws.example/webhooks/${name}`, {
        method: "POST",
        headers: {
          ...endpoint.headers(endpoint.payload),
          "content-length": String(endpoint.limit + 1),
        },
        body: new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              reads++;
              controller.close();
            },
          },
          { highWaterMark: 0 },
        ),
      });
      expect((await endpoint.handle(request, secret)).status).toBe(413);
      expect(reads).toBe(0);
    });
  });

  test(`${name} stops and cancels an oversized streamed body`, async () => {
    await withEndpoint(async (endpoint) => {
      let chunks = 0;
      let cancelled = false;
      const chunk = new Uint8Array(64 * 1024);
      const request = new Request(`https://paws.example/webhooks/${name}`, {
        method: "POST",
        headers: endpoint.headers(endpoint.payload),
        body: new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              if (chunks++ < endpoint.limit / chunk.length + 2) controller.enqueue(chunk);
              else controller.close();
            },
            cancel() {
              cancelled = true;
            },
          },
          { highWaterMark: 0 },
        ),
      });
      expect((await endpoint.handle(request, secret)).status).toBe(413);
      expect(chunks).toBe(endpoint.limit / chunk.length + 1);
      expect(cancelled).toBe(true);
    });
  });

  test(`${name} verifies exact raw UTF-8 bytes across arbitrary chunk boundaries`, async () => {
    await withEndpoint(async (endpoint) => {
      const bytes = Buffer.from(endpoint.payload);
      let offset = 0;
      const request = new Request(`https://paws.example/webhooks/${name}`, {
        method: "POST",
        headers: endpoint.headers(endpoint.payload),
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            if (offset < bytes.length) controller.enqueue(bytes.subarray(offset, ++offset));
            else controller.close();
          },
        }),
      });
      expect((await endpoint.handle(request, secret)).status).toBe(200);
    });
  });
}
