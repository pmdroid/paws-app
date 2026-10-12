import { expect, test } from "bun:test";
import { checkRepositoryWriteAccess } from "../src/github";

function check(response: Response | Error, app = false) {
  return checkRepositoryWriteAccess({
    owner: "acme",
    repo: "project",
    token: "host-only-token",
    app,
    signal: new AbortController().signal,
    fetch: async (url, init) => {
      expect(String(url)).toBe("https://api.github.com/repos/acme/project");
      expect(init?.redirect).toBe("error");
      if (response instanceof Error) throw response;
      return response;
    },
  });
}

test("repository probes distinguish definitive missing access from unknown API outcomes", async () => {
  expect(await check(new Response(null, { status: 404 }))).toBe(false);
  expect(await check(Response.json({ permissions: { push: false } }))).toBe(false);
  expect(await check(Response.json({ permissions: { push: true } }))).toBe(true);
  expect(await check(Response.json({}), true)).toBe(true);
  for (const status of [401, 403, 429, 500, 503])
    await expect(check(new Response(null, { status }))).rejects.toThrow("access check failed");
  await expect(check(new Error("Network unavailable"))).rejects.toThrow("Network unavailable");
  await expect(check(new DOMException("Timeout", "TimeoutError"))).rejects.toThrow("Timeout");
  await expect(check(new Response("invalid json"))).rejects.toThrow();
  await expect(check(Response.json({}))).rejects.toThrow("incomplete");
});
