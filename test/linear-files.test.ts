import { describe, expect, test } from "bun:test";
import { createLinearFileTransfer, type FetchLike, type LinearClient } from "../src/linear";

const ASSET = "https://uploads.linear.app/workspace/file";
const SIGNED = "https://storage.example.com/bucket/file?signature=private";
const BYTES = new Uint8Array([1, 2, 3, 4]);

function prepared(headers: { key: string; value: string }[] = []) {
  return {
    fileUpload: { success: true, uploadFile: { uploadUrl: SIGNED, assetUrl: ASSET, headers } },
  };
}

function setup(
  options: { payload?: unknown; fetch?: FetchLike; maxBytes?: number; timeoutMs?: number } = {},
) {
  const queries: {
    query: string;
    variables: Record<string, unknown> | undefined;
    signal: AbortSignal | undefined;
  }[] = [];
  const transfers: { url: string; init: RequestInit | undefined }[] = [];
  let authCalls = 0;
  const client: LinearClient = {
    async query(query, variables, request) {
      queries.push({ query, variables, signal: request?.signal });
      return options.payload ?? prepared();
    },
  };
  const transfer = createLinearFileTransfer({
    client,
    auth: {
      async ensureFresh() {
        authCalls++;
        return "linear-secret-token";
      },
    },
    maxBytes: options.maxBytes,
    timeoutMs: options.timeoutMs,
    fetch: async (url, init) => {
      transfers.push({ url: String(url), init });
      return options.fetch?.(url, init) ?? new Response(null, { status: 200 });
    },
  });
  return { transfer, queries, transfers, authCalls: () => authCalls };
}

describe("Linear private uploads", () => {
  test.each(["image/png", "application/pdf"])(
    "uploads %s privately with required signed headers and stable asset URL",
    async (contentType) => {
      const { transfer, queries, transfers, authCalls } = setup({
        payload: prepared([
          { key: "x-amz-acl", value: "private" },
          { key: "authorization", value: "StorageSignature storage-only" },
          { key: "content-type", value: contentType },
        ]),
      });
      expect(await transfer.upload({ filename: "result.png", contentType, bytes: BYTES })).toEqual({
        filename: "result.png",
        contentType,
        size: BYTES.byteLength,
        assetUrl: ASSET,
      });
      expect(queries[0]?.variables).toEqual({
        filename: "result.png",
        contentType,
        size: 4,
        makePublic: false,
      });
      expect(queries[0]?.query).toContain("fileUpload(contentType: $contentType");
      expect(queries[0]?.signal).toBeInstanceOf(AbortSignal);
      const request = transfers[0];
      expect(request?.url).toBe(SIGNED);
      expect(request?.init?.method).toBe("PUT");
      expect(request?.init?.redirect).toBe("error");
      const headers = new Headers(request?.init?.headers);
      expect(headers.get("x-amz-acl")).toBe("private");
      expect(headers.get("content-type")).toBe(contentType);
      expect(headers.get("authorization")).toBe("StorageSignature storage-only");
      expect(headers.get("authorization")).not.toContain("linear-secret-token");
      expect(request?.init?.body).toEqual(BYTES);
      expect(authCalls()).toBe(0);
    },
  );

  test("snapshots bytes before awaiting upload preparation", async () => {
    const { transfer, transfers } = setup();
    const bytes = new Uint8Array([7, 8]);
    const input = { filename: "original.png", contentType: "image/png", bytes };
    const pending = transfer.upload(input);
    bytes.fill(0);
    input.filename = "../secret";
    input.contentType = "invalid";
    expect(await pending).toMatchObject({ filename: "original.png", contentType: "image/png" });
    expect(transfers[0]?.init?.body).toEqual(new Uint8Array([7, 8]));
  });

  test("rejects invalid preparation payloads without PUT", async () => {
    for (const payload of [
      {},
      { fileUpload: { success: false } },
      { fileUpload: { success: true, uploadFile: null } },
      { fileUpload: { success: true, uploadFile: { uploadUrl: SIGNED, assetUrl: ASSET } } },
    ]) {
      const { transfer, transfers } = setup({ payload });
      await expect(
        transfer.upload({ filename: "result.txt", contentType: "text/plain", bytes: BYTES }),
      ).rejects.toThrow("no valid upload destination");
      expect(transfers).toEqual([]);
    }
  });

  test("rejects insecure upload and foreign asset destinations", async () => {
    const credentialUrl = new URL("https://storage.example.com/file");
    credentialUrl.username = "user";
    credentialUrl.password = "password";
    for (const uploadUrl of [
      "http://storage.example.com/file",
      credentialUrl.toString(),
      "https://storage.example.com/file#fragment",
    ]) {
      const payload = prepared();
      payload.fileUpload.uploadFile.uploadUrl = uploadUrl;
      const { transfer, transfers } = setup({ payload });
      await expect(
        transfer.upload({ filename: "result.txt", contentType: "text/plain", bytes: BYTES }),
      ).rejects.toThrow("HTTPS destination");
      expect(transfers).toEqual([]);
    }
    const payload = prepared();
    payload.fileUpload.uploadFile.assetUrl = "https://evil.example.com/file";
    await expect(
      setup({ payload }).transfer.upload({
        filename: "result.txt",
        contentType: "text/plain",
        bytes: BYTES,
      }),
    ).rejects.toThrow("exact HTTPS");
  });

  test("does not expose signed URLs or response bodies on failure", async () => {
    const { transfer } = setup({
      fetch: async () => new Response("storage-secret-error-body", { status: 403 }),
    });
    let error: unknown;
    try {
      await transfer.upload({ filename: "result.txt", contentType: "text/plain", bytes: BYTES });
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain("upload HTTP 403");
    expect(String(error)).not.toContain("storage-secret-error-body");
    expect(String(error)).not.toContain("signature=private");
  });

  test("rejects unsafe names, MIME types and byte limits before preparation", async () => {
    const { transfer, queries } = setup({ maxBytes: 3 });
    for (const filename of [
      "../secret",
      "dir/file",
      "dir\\file",
      "",
      "\0secret",
      "a\nb",
      "..",
      "x".repeat(256),
    ]) {
      await expect(
        transfer.upload({ filename, contentType: "text/plain", bytes: new Uint8Array() }),
      ).rejects.toThrow("safe filename");
    }
    await expect(
      transfer.upload({
        filename: "result.txt",
        contentType: "text/plain\r\nAuthorization: secret",
        bytes: new Uint8Array(),
      }),
    ).rejects.toThrow("MIME type");
    await expect(
      transfer.upload({ filename: "result.txt", contentType: "text/plain", bytes: BYTES }),
    ).rejects.toThrow("byte limit");
    expect(queries).toEqual([]);
  });
});

describe("Linear authorized downloads", () => {
  test("sends the bearer only to the private storage origin and reads bounded chunks", async () => {
    const { transfer, transfers, authCalls } = setup({
      fetch: async () =>
        new Response(BYTES, { headers: { "content-type": "image/png; charset=binary" } }),
    });
    expect(await transfer.download({ url: ASSET, filename: "screenshot.png" })).toEqual({
      filename: "screenshot.png",
      contentType: "image/png",
      size: 4,
      bytes: BYTES,
    });
    expect(transfers[0]?.url).toBe(ASSET);
    expect(transfers[0]?.init?.method).toBe("GET");
    expect(transfers[0]?.init?.redirect).toBe("error");
    expect(new Headers(transfers[0]?.init?.headers).get("authorization")).toBe(
      "Bearer linear-secret-token",
    );
    expect(authCalls()).toBe(1);
  });

  test("rejects all foreign origins before acquiring credentials", async () => {
    const { transfer, transfers, authCalls } = setup();
    const credentialUrl = new URL("https://uploads.linear.app/file");
    credentialUrl.username = "user";
    credentialUrl.password = "secret";
    for (const url of [
      "http://uploads.linear.app/file",
      "https://uploads.linear.app.evil.test/file",
      "https://uploads.linear.app:8443/file",
      "https://uploads.linear.app@evil.test/file",
      credentialUrl.toString(),
      "file:///tmp/secret",
      "https://uploads.linear.app/file#fragment",
    ]) {
      await expect(transfer.download({ url })).rejects.toThrow("exact HTTPS");
    }
    expect(transfers).toEqual([]);
    expect(authCalls()).toBe(0);
  });

  test("derives a safe filename without trusting a Content-Disposition path", async () => {
    const { transfer } = setup({
      fetch: async () =>
        new Response(BYTES, {
          headers: { "content-disposition": "attachment; filename=../../secret" },
        }),
    });
    expect(
      await transfer.download({ url: "https://uploads.linear.app/workspace/..%2F..%2Freport.pdf" }),
    ).toMatchObject({ filename: "_.._report.pdf", contentType: "application/octet-stream" });
    await expect(transfer.download({ url: ASSET, filename: "../overwrite" })).rejects.toThrow(
      "safe filename",
    );
  });

  test("rejects HTTP redirects without forwarding the token", async () => {
    const { transfer, transfers } = setup({
      fetch: async (_url, init) => {
        expect(init?.redirect).toBe("error");
        return new Response(null, {
          status: 302,
          headers: { location: "https://evil.test/steal" },
        });
      },
    });
    await expect(transfer.download({ url: ASSET })).rejects.toThrow("download HTTP 302");
    expect(transfers).toHaveLength(1);
    const response = new Response(BYTES);
    Object.defineProperty(response, "redirected", { value: true });
    await expect(
      setup({ fetch: async () => response }).transfer.download({ url: ASSET }),
    ).rejects.toThrow("redirects are forbidden");
  });

  test("rejects oversized lengths and streaming content and cancels the body", async () => {
    let canceled = 0;
    const stream = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(BYTES);
        },
        cancel() {
          canceled++;
        },
      });
    const header = setup({
      maxBytes: 3,
      fetch: async () => new Response(stream(), { headers: { "content-length": "4" } }),
    });
    await expect(header.transfer.download({ url: ASSET })).rejects.toThrow("byte limit");
    const chunked = setup({ maxBytes: 3, fetch: async () => new Response(stream()) });
    await expect(chunked.transfer.download({ url: ASSET })).rejects.toThrow("byte limit");
    expect(canceled).toBe(2);
  });

  test("does not expose authentication or failure bodies", async () => {
    const { transfer } = setup({
      fetch: async () => new Response("private-download-body", { status: 401 }),
    });
    let error: unknown;
    try {
      await transfer.download({ url: ASSET });
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain("download HTTP 401");
    expect(String(error)).not.toContain("private-download-body");
    expect(String(error)).not.toContain("linear-secret-token");
  });
});

describe("Linear file cancellation", () => {
  test("already canceled requests do not call auth, GraphQL or storage", async () => {
    const { transfer, queries, transfers, authCalls } = setup();
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    await expect(transfer.download({ url: ASSET, signal: controller.signal })).rejects.toThrow(
      "stopped",
    );
    await expect(
      transfer.upload({
        filename: "result.txt",
        contentType: "text/plain",
        bytes: BYTES,
        signal: controller.signal,
      }),
    ).rejects.toThrow("stopped");
    expect(queries).toEqual([]);
    expect(transfers).toEqual([]);
    expect(authCalls()).toBe(0);
  });

  test("cancels preparation before PUT and aborts its GraphQL signal", async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    let putCalls = 0;
    let finish: (value: unknown) => void = () => {};
    const transfer = createLinearFileTransfer({
      client: {
        query(_query, _variables, request) {
          requestSignal = request?.signal;
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
      },
      auth: {
        async ensureFresh() {
          return "secret";
        },
      },
      fetch: async () => {
        putCalls++;
        return new Response();
      },
    });
    const pending = transfer.upload({
      filename: "result.txt",
      contentType: "text/plain",
      bytes: BYTES,
      signal: controller.signal,
    });
    controller.abort(new Error("stopped preparation"));
    await expect(pending).rejects.toThrow("stopped preparation");
    expect(requestSignal?.aborted).toBe(true);
    finish(prepared());
    await Bun.sleep(1);
    expect(putCalls).toBe(0);
  });

  test("bounds authentication waiting and never fetches after timeout", async () => {
    let finish: (value: string) => void = () => {};
    let fetchCalls = 0;
    const transfer = createLinearFileTransfer({
      client: {
        async query() {
          return prepared();
        },
      },
      auth: {
        ensureFresh() {
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
      },
      fetch: async () => {
        fetchCalls++;
        return new Response();
      },
      timeoutMs: 5,
    });
    await expect(transfer.download({ url: ASSET })).rejects.toThrow("timed out");
    finish("secret");
    await Bun.sleep(1);
    expect(fetchCalls).toBe(0);
  });

  test("times out a stalled PUT and aborts its fetch signal", async () => {
    let requestSignal: AbortSignal | null | undefined;
    const { transfer } = setup({
      timeoutMs: 5,
      fetch: async (_url, init) => {
        requestSignal = init?.signal;
        return new Promise<Response>(() => {});
      },
    });
    await expect(
      transfer.upload({ filename: "result.txt", contentType: "text/plain", bytes: BYTES }),
    ).rejects.toThrow("timed out");
    expect(requestSignal?.aborted).toBe(true);
  });

  test("cancels an in-progress streaming download", async () => {
    const controller = new AbortController();
    let canceled = false;
    const { transfer } = setup({
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(stream) {
              stream.enqueue(new Uint8Array([1]));
            },
            cancel() {
              canceled = true;
            },
          }),
        ),
    });
    const pending = transfer.download({ url: ASSET, signal: controller.signal });
    await Bun.sleep(1);
    controller.abort(new Error("stopped download"));
    await expect(pending).rejects.toThrow("stopped download");
    expect(canceled).toBe(true);
  });
});

describe("Linear file private transport errors", () => {
  test("redacts raw fetch failures for upload and download", async () => {
    const { transfer } = setup({
      fetch: async () => {
        throw new Error("signed-url-signature-and-token");
      },
    });
    await expect(
      transfer.upload({ filename: "result.txt", contentType: "text/plain", bytes: BYTES }),
    ).rejects.toThrow("Linear file upload request failed");
    await expect(transfer.download({ url: ASSET })).rejects.toThrow(
      "Linear file download request failed",
    );
  });

  test("redacts body stream failures", async () => {
    const { transfer } = setup({
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error("private-signed-url"));
            },
          }),
        ),
    });
    await expect(transfer.download({ url: ASSET })).rejects.toThrow(
      "Linear file download body could not be read",
    );
  });

  test("bounds stalled download body reads", async () => {
    let canceled = false;
    const { transfer } = setup({
      timeoutMs: 5,
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              canceled = true;
            },
          }),
        ),
    });
    await expect(transfer.download({ url: ASSET })).rejects.toThrow("timed out");
    expect(canceled).toBe(true);
  });

  test("rejects malformed signed headers without revealing their contents", async () => {
    const { transfer, transfers } = setup({
      payload: prepared([{ key: "invalid header", value: "storage-secret" }]),
    });
    await expect(
      transfer.upload({ filename: "result.txt", contentType: "text/plain", bytes: BYTES }),
    ).rejects.toThrow("invalid upload headers");
    expect(transfers).toEqual([]);
  });
});
