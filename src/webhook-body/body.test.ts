import { expect, test } from "bun:test";
import { readWebhookBody } from ".";

function pendingBody(signal?: AbortSignal) {
  let cancelled = false;
  const request = new Request("https://paws.example/webhooks/github", {
    method: "POST",
    ...(signal ? { signal } : {}),
    body: new ReadableStream<Uint8Array>(
      {
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    ),
  });
  return { request, cancelled: () => cancelled };
}

test("a stalled webhook body times out and cancels the stream", async () => {
  const body = pendingBody();
  const response = await readWebhookBody(body.request, 1024, 10);
  expect(response).toBeInstanceOf(Response);
  expect((response as Response).status).toBe(408);
  expect(body.cancelled()).toBe(true);
});

test("disconnecting the caller cancels a pending webhook body", async () => {
  const controller = new AbortController();
  const body = pendingBody(controller.signal);
  const result = readWebhookBody(body.request, 1024);
  controller.abort();
  expect(((await result) as Response).status).toBe(408);
  expect(body.cancelled()).toBe(true);
});

test("the shared webhook reader bounds concurrent input and recovers after cancellation", async () => {
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const bodies = controllers.map((controller) => pendingBody(controller.signal));
  const pending = bodies.map((body) => readWebhookBody(body.request, 1024));
  try {
    const fifth = pendingBody();
    expect(((await readWebhookBody(fifth.request, 1024)) as Response).status).toBe(503);
    expect(fifth.cancelled()).toBe(true);
  } finally {
    for (const controller of controllers) controller.abort();
    await Promise.all(pending);
  }
  expect(bodies.every((body) => body.cancelled())).toBe(true);
  const result = await readWebhookBody(
    new Request("https://paws.example/webhooks/github", { method: "POST", body: "京都" }),
    1024,
  );
  expect(Buffer.isBuffer(result)).toBe(true);
  expect(result.toString()).toBe("京都");
});

test("malformed declared lengths are rejected without consuming input", async () => {
  for (const length of ["-1", "1.5", "unknown"]) {
    const body = pendingBody();
    body.request.headers.set("content-length", length);
    expect(((await readWebhookBody(body.request, 1024)) as Response).status).toBe(400);
    expect(body.cancelled()).toBe(true);
  }
});
