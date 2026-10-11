import { expect, test } from "bun:test";
import { handleStatusRequest } from "../engine";

const ID = "bac3f259-220f-4671-a193-42c764c92f23";
const URL = `http://127.0.0.1:8787/api/linear/artifacts/${ID}`;
const bytes = new Uint8Array([1, 2, 3]);

function reader(mimeType = "image/png", displayName = "Screenshot.png") {
  const calls: string[] = [];
  return {
    calls,
    async readLinearArtifact(id: string) {
      calls.push(id);
      return { bytes, mimeType, displayName };
    },
  };
}

test("private dashboard images use opaque IDs, safe inline headers and no public CORS", async () => {
  const options = reader();
  const result = await handleStatusRequest(
    new Request(URL, { headers: { origin: "http://127.0.0.1:8787" } }),
    options,
  );
  expect(result?.status).toBe(200);
  expect(new Uint8Array(await result!.arrayBuffer())).toEqual(bytes);
  expect(result?.headers.get("content-type")).toBe("image/png");
  expect(result?.headers.get("content-disposition")).toStartWith("inline;");
  expect(result?.headers.get("content-length")).toBe("3");
  expect(result?.headers.get("cache-control")).toBe("no-store");
  expect(result?.headers.get("x-content-type-options")).toBe("nosniff");
  expect(result?.headers.get("content-security-policy")).toContain("sandbox");
  expect(result?.headers.get("access-control-allow-origin")).toBeNull();
  expect(options.calls).toEqual([ID]);
  const head = await handleStatusRequest(new Request(URL, { method: "HEAD" }), options);
  expect(head?.status).toBe(200);
  expect(await head?.text()).toBe("");
});

test("active content is always downloaded and filenames cannot inject headers", async () => {
  for (const mime of [
    "text/html",
    "image/svg+xml",
    "application/pdf",
    "text/plain",
    "bad\r\nHeader: injected",
  ]) {
    const result = await handleStatusRequest(
      new Request(URL),
      reader(mime, 'report"\r\nInjected: yes.html'),
    );
    expect(result?.status).toBe(200);
    expect(result?.headers.get("content-disposition")).toStartWith("attachment;");
    expect(result?.headers.get("injected")).toBeNull();
  }
  const forced = await handleStatusRequest(new Request(`${URL}?download=1`), reader());
  expect(forced?.headers.get("content-disposition")).toStartWith("attachment;");
});

test("cross-origin and remote readers cannot fetch local private artifacts", async () => {
  const options = reader();
  for (const request of [
    new Request(URL.replace("127.0.0.1", "remote.example")),
    new Request(URL, { headers: { origin: "https://attacker.example" } }),
    new Request(URL, { headers: { host: "attacker.example" } }),
    new Request(URL, { headers: { "sec-fetch-site": "cross-site" } }),
  ])
    expect((await handleStatusRequest(request, options))?.status).toBe(403);
  expect(options.calls).toHaveLength(0);
  expect((await handleStatusRequest(new Request(URL, { method: "POST" }), options))?.status).toBe(
    405,
  );
  expect(
    (await handleStatusRequest(new Request(URL.replace(ID, "unknown")), options))?.status,
  ).toBe(404);
  expect(options.calls).toHaveLength(0);
});

test("missing or corrupt snapshots fail without exposing private paths", async () => {
  expect((await handleStatusRequest(new Request(URL), {}))?.status).toBe(404);
  const missing = await handleStatusRequest(new Request(URL), {
    async readLinearArtifact() {
      return null;
    },
  });
  expect(missing?.status).toBe(404);
  const corrupt = await handleStatusRequest(new Request(URL), {
    async readLinearArtifact() {
      throw new Error("/private/secret.upload?signature=hidden");
    },
  });
  expect(corrupt?.status).toBe(404);
  expect(await corrupt?.text()).toBe("Not found");
});
