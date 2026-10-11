import { describe, expect, test } from "bun:test";
import { createLinearClient } from "../src/linear";

const token = "synthetic-linear-token";

describe("Linear transport cancellation", () => {
  test("a pre-aborted call does not obtain credentials or send a request", async () => {
    let authCalls = 0;
    let requests = 0;
    const client = createLinearClient({
      auth: {
        hasToken: () => true,
        async ensureFresh() {
          authCalls += 1;
          return token;
        },
        async forceRefresh() {
          return token;
        },
      },
      fetch: async () => {
        requests += 1;
        return Response.json({ data: {} });
      },
    });
    await expect(
      client.query("query { viewer { id } }", {}, { signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(authCalls).toBe(0);
    expect(requests).toBe(0);
  });

  test("cancellation while credentials are loading settles promptly and prevents a later request", async () => {
    let resolveAuth: (value: string) => void = () => {};
    const credentials = new Promise<string>((resolve) => {
      resolveAuth = resolve;
    });
    let requests = 0;
    const client = createLinearClient({
      auth: {
        hasToken: () => true,
        ensureFresh: () => credentials,
        forceRefresh: () => credentials,
      },
      fetch: async () => {
        requests += 1;
        return Response.json({ data: {} });
      },
    });
    const controller = new AbortController();
    const pending = client.query("query { viewer { id } }", {}, { signal: controller.signal });
    controller.abort(new Error("stopped"));
    await expect(pending).rejects.toThrow("stopped");
    resolveAuth(token);
    await Bun.sleep(0);
    expect(requests).toBe(0);
  });

  test("passes cancellation to the active request", async () => {
    let notifyStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const controller = new AbortController();
    const client = createLinearClient({
      auth: {
        hasToken: () => true,
        ensureFresh: async () => token,
        forceRefresh: async () => token,
      },
      fetch: async (_url, init) => {
        expect(init?.signal).toBe(controller.signal);
        notifyStarted();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        });
      },
    });
    const pending = client.query("query { viewer { id } }", {}, { signal: controller.signal });
    await started;
    controller.abort(new Error("interrupted"));
    await expect(pending).rejects.toThrow("interrupted");
  });

  test("does not retry a 401 after cancellation during token refresh", async () => {
    let notifyRefresh: () => void = () => {};
    let resolveRefresh: (value: string) => void = () => {};
    const refreshing = new Promise<void>((resolve) => {
      notifyRefresh = resolve;
    });
    const refreshed = new Promise<string>((resolve) => {
      resolveRefresh = resolve;
    });
    let requests = 0;
    const client = createLinearClient({
      auth: {
        hasToken: () => true,
        ensureFresh: async () => token,
        forceRefresh: () => {
          notifyRefresh();
          return refreshed;
        },
      },
      fetch: async () => {
        requests += 1;
        return new Response("", { status: 401 });
      },
    });
    const controller = new AbortController();
    const pending = client.query("query { viewer { id } }", {}, { signal: controller.signal });
    await refreshing;
    controller.abort(new Error("stopped"));
    await expect(pending).rejects.toThrow("stopped");
    resolveRefresh(token);
    await Bun.sleep(0);
    expect(requests).toBe(1);
  });
});
